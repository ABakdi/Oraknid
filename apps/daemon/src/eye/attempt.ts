import { createHash } from "node:crypto";
import type {
  Autonomy,
  Budget,
  choiceQuestion,
  Difficulty,
  MetricsSample,
  TaskKind,
} from "@oraknid/contracts";
import {
  buildContextPack,
  busyMachine,
  countOf,
  decideOutcome,
  type Ending,
  fence,
  type GatedAction,
  guidanceFromOthers,
  HANDOFF_REQUEST,
  nextRung,
  type Route,
  type RouteCandidate,
  record,
  route,
  rungOf,
  saysCheckBroken,
  skillExcerpt,
  taskScope,
  type WorkKind,
  whenSaid,
  workKindOf,
} from "@oraknid/core";
import type { LegEvent, PermissionRequest } from "@oraknid/leg-sdk";
import type { Sandbox } from "@oraknid/os";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/open.ts";
import { attempts, jobs, sessions, tasks } from "../db/schema.ts";
import { SideEffects } from "../engine/effects.ts";
import type { EventBus } from "../events/bus.ts";
import { applyOutcome, EndAttempt, markUnusable } from "../harness/apply.ts";
import { type AttemptCtx, type AttemptState, beginTurn, factsOf } from "../harness/facts.ts";
import { asPermission, asPreTool, createGate } from "../harness/gate.ts";
import { AttemptLog } from "../harness/log.ts";
import { handoffFromAttempt, recordEvents, takeOver } from "../harness/record.ts";
import { type CheckReport, createVerifier, type RunOptions } from "../harness/verifier.ts";
import { newId } from "../ids.ts";
import type { InboxStore } from "../inbox/store.ts";
import { sandboxPlan } from "../legs/plan.ts";
import type { LegRegistry } from "../legs/registry.ts";
import type { LegSupervisor, Supervised } from "../legs/supervisor.ts";
import { legSessionLimit } from "../resources/work.ts";
import { serversForLeg } from "../servers/for-leg.ts";
import { type JobServerRef, plainServerCheck } from "../servers/remote.ts";
import type { Servers } from "../servers/service.ts";
import { CLAUDE_SHARE, readSetting, writeSetting } from "../settings.ts";
import { handoffFromLog } from "../silk/handoff.ts";
import type { SilkStore } from "../silk/store.ts";
import { summarizeShortened } from "../silk/summarize.ts";
import type { BrokerSession, McpBroker } from "../tools/broker.ts";
import { BUILT_IN, type ToolRegistry, type ToolRow } from "../tools/registry.ts";
import type { GitHub } from "../workspace/github.ts";
import { githubLinkOf, githubLinksOf } from "../workspace/github-tool.ts";
import type { WorkTree } from "../workspace/tree.ts";
import { BrainStopped, type CheckRepair, type EyeBrain, type GitHubForRepair } from "./brain.ts";
import { LegStop, legLimits, stopWaiting, trackAttempt } from "./leg-work.ts";
import { addMessage, guidanceMark } from "./talk.ts";

/** The providers (Leg kinds) for which I allowed same-provider fallback (ADR-009). */
export const SAME_PROVIDER_FALLBACK = "fallback.sameProvider";

export type TaskRow = typeof tasks.$inferSelect;

export interface AttemptDeps {
  db: Db;
  bus: EventBus;
  silk: SilkStore;
  inbox: InboxStore;
  registry: LegRegistry;
  supervisor: LegSupervisor;
  sandbox: Sandbox;
  legsDir: string;
  now: () => number;
  /** The judge of auto mode (ADR-053); without one, what the rules leave counts as blocked. */
  brain?: EyeBrain;
  /** Tools for skills (ADR-021): the job's MCP servers, run by the daemon. */
  tools?: { registry: ToolRegistry; broker: McpBroker };
  /** The outbox: a tool's sends happen at most once (BR-6). */
  effects?: SideEffects;
  /** My servers, for a job whose project has some (ADR-026). */
  servers?: Servers;
  /** GitHub, for the checks Oraknid answers itself about the project's repo (ADR-038). */
  github?: GitHub;
  /** The machine's last few seconds of metrics: a new session waits for room (ADR-016). */
  machine?: () => MetricsSample[];
  /** Session rotation (BR-3): share of the context window. */
  rotateAt?: number;
  /** How often to look for a stall while waiting for a Leg. */
  stallCheckMs?: number;
  maxTurns?: number;
}

export interface AttemptJob {
  id: string;
  title: string;
  goal: string;
  autonomy: Autonomy;
  allowedLegIds: string[];
  moneyAllowed: boolean;
  waived: GatedAction[];
  unsandboxed: boolean;
  skillBody: string;
  /** The tools its sessions get, by name (ADR-021). */
  tools: string[];
  /** The skill's own checks for results that aren't code (Skills → Checks). */
  skillChecks?: string;
  /** The servers its project gave it (Servers → Servers in projects). */
  serverIds?: string[];
  /** Each server's role in the project (ADR-042). */
  serverRoles?: Record<string, { role: string; production: boolean | null }>;
  /** The server I chose or confirmed for its work on a server, "none", or not asked yet (ADR-042). */
  server?: string | null;
  /** The server whose own job this is: its place is the server, not a repo (ADR-049). */
  serverJob?: string | null;
  /** A project of several repos, as a Leg must know it (ADR-042). */
  layout?: string;
  /** Its project's ports on this computer its sandboxes may reach (Sandboxing → network). */
  localPorts?: number[];
  /** The project's other skills, whose guidance a task may get (Skills → Skills per project). */
  otherSkills?: { name: string; body: string }[];
  /** The job's inputs, rendered for context packs. */
  inputs: string;
}

export type AttemptOutcome =
  | { kind: "done"; commit: string | null; commits?: { repo: string; sha: string }[] }
  | { kind: "retry"; reason: string }
  | { kind: "blocked"; reason: string; until: number | null }
  /** Left out by me; `dependents`: the tasks that need it are left out too (ADR-045). */
  | { kind: "skipped"; dependents?: boolean }
  | { kind: "owner-held" }
  | { kind: "cancel-job"; reason: string }
  /** Its Leg was paused, or its work in the job cancelled: stopped at a safe point, the job goes on. */
  | { kind: "leg-stopped"; how: "pause" | "cancel" | "room"; reason: string };

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);

/**
 * One attempt at one task (The-Eye → The loop): route, checkpoint, run
 * the Leg from a context pack, apply the permission policy, verify the
 * work itself, self-prompt, watch for drift and climb the ladder, rotate
 * sessions, and on success commit and record progress in Silk.
 */
export async function runAttempt(
  d: AttemptDeps,
  job: AttemptJob,
  taskId: string,
  ws: { cwd: string; tree: WorkTree; tmpDir: string; trash: string },
  attemptNo: number,
  jobSignal: AbortSignal,
): Promise<AttemptOutcome> {
  const task = d.db.select().from(tasks).where(eq(tasks.id, taskId)).get() as TaskRow;
  const now = d.now;
  // Stopped by its job (a pause, a cancel, a shutdown), or by its Leg alone (Jobs-and-Projects → Controls).
  const legStop = new AbortController();
  const signal = AbortSignal.any([jobSignal, legStop.signal]);

  // ── A paused Leg's task waits for it (unless I reassign it) ─────
  let waitedFor = legLimits(d.db, job.id, taskId).waitFor;
  let saidWaitingFor = false;
  for (;;) {
    waitedFor = legLimits(d.db, job.id, taskId).waitFor;
    const leg = waitedFor ? d.registry.get(waitedFor) : null;
    if (!leg?.paused) break;
    if (!saidWaitingFor) {
      saidWaitingFor = true;
      d.bus.publish({
        type: "task.waiting-for-leg",
        topic: `job:${job.id}`,
        jobId: job.id,
        payload: {
          taskId,
          legId: leg.id,
          reason: `It waits for ${leg.name}, paused; it goes on when the Leg is resumed, or on another Leg if I reassign it.`,
        },
      });
    }
    await pause(1000, signal);
  }

  // ── Route ───────────────────────────────────────────────────────
  // ADR-009: after a usage limit, another account of the same provider is not a fallback unless I allowed it.
  const sameProvider = new Set(readSetting(d.db, SAME_PROVIDER_FALLBACK, z.array(z.string()), []));
  // Entries are "kind:legId": the account that hit the limit may come back after its reset; others may not.
  const limited = task.limitedKinds
    .map((e) => e.split(":") as [string, string])
    .filter(([k]) => !sameProvider.has(k));
  const blockedKinds = new Set(limited.map(([k]) => k));
  const limitedLegs = new Set(limited.map(([, id]) => id));
  // Legs whose work in this job (or on this task) I cancelled are not used again; a task that
  // waited for a Leg now resumed goes back to it.
  const { avoid: avoidLegs } = legLimits(d.db, job.id, taskId);
  const allowed = candidatesFor(d.registry, job.allowedLegIds).filter(
    (c) => !avoidLegs.has(c.legId),
  );
  const back = waitedFor ? allowed.filter((c) => c.legId === waitedFor) : [];
  const all = back.length ? back : allowed;
  const candidates = all.filter(
    (c) => !blockedKinds.has(d.registry.require(c.legId).kind) || limitedLegs.has(c.legId),
  );
  const heldBack = all.length - candidates.length;
  // Read now, so a budget I changed while the job runs applies to the next task.
  const budget = d.db.select({ budget: jobs.budget }).from(jobs).where(eq(jobs.id, job.id)).get()
    ?.budget as Budget | undefined;
  const quotaShare = budget?.quotaShare ?? null;
  const estimatedTokens = 20_000 + Math.ceil(task.instructions.length / 4);
  // The kind of work, for the ladder's rungs (ADR-052 §3).
  const work: WorkKind = job.serverJob ? "server" : workKindOf(task);
  const routeTask = {
    kind: task.kind as TaskKind,
    difficulty: task.difficulty as Difficulty,
    requiredCapabilities: task.requiredCapabilities as never,
    estimatedTokens,
    stepUp: task.stepUp,
    pinnedModelId: task.pinnedModelId,
    avoid: task.avoid,
    work,
  };
  const routeOptions = {
    moneyAllowed: job.moneyAllowed,
    quotaShare,
    claudeShare: claudeShareOf(d, job.id, budget),
  };
  // A Leg runs at most its limit of task sessions at once (ADR-016). When only busy Legs could
  // take the task, it waits for one, without blocking its job.
  // And a new session waits for room on the machine: a local model needs headroom (ADR-016).
  let machineBusy: string | null = null;
  const free = (c: RouteCandidate) => {
    if (d.supervisor.busy(c.legId) >= legLimit(d, c.legId)) return false;
    const why = d.machine ? busyMachine(d.machine(), c.profile.costModel === "local") : null;
    if (why) machineBusy = why;
    return !why;
  };
  // Each candidate knows how busy its Leg is: tasks side by side spread across Legs (ADR-050).
  const withSessions = (c: RouteCandidate): RouteCandidate => ({
    ...c,
    sessions: { running: d.supervisor.busy(c.legId), limit: legLimit(d, c.legId) },
  });
  let routed = route(routeTask, candidates.filter(free).map(withSessions), routeOptions);
  let saidWaiting: string | null = null;
  while (!routed.ranked[0] && route(routeTask, candidates, routeOptions).ranked[0]) {
    const reason = machineBusy
      ? `It waits for room: ${machineBusy}.`
      : "Every Leg that could take it is busy; it starts when one is free.";
    if (saidWaiting !== reason) {
      saidWaiting = reason;
      d.bus.publish({
        type: "task.waiting-for-leg",
        topic: `job:${job.id}`,
        jobId: job.id,
        payload: { taskId, reason },
      });
    }
    machineBusy = null;
    await pause(1000, signal);
    routed = route(routeTask, candidates.filter(free).map(withSessions), routeOptions);
  }
  const pick = routed.ranked[0];
  if (!pick) {
    // The earliest reset that frees a Leg: a used-up window, or one past this job's quota share.
    const share = quotaShare?.hard ? quotaShare.limit : null;
    const until = [
      ...d.registry.all().map((l) => l.limitedUntil),
      // A model or Leg resting after a provider failure (M13.22).
      ...candidates.map((c) => c.cooldown?.until),
      ...(share === null
        ? []
        : candidates.flatMap((c) =>
            c.windows.filter((w) => (w.utilization ?? 0) >= share).map((w) => w.resetsAt),
          )),
    ]
      .filter((t): t is number => !!t && t > now())
      .sort((a, b) => a - b)[0];
    const resets = until ? ` until ${whenSaid(until, now())}` : "";
    return {
      kind: "blocked",
      reason: heldBack
        ? `"${task.title}" hit a usage limit on ${[...blockedKinds].join(", ")}; other accounts of the same provider are not used as fallback (ADR-009). It waits${resets}, for another provider, or for my setting.`
        : whyNoLeg(d, job, task.title, routed.excluded, until ?? null),
      until: until ?? null,
    };
  }
  const leg = pick.candidate;
  if (waitedFor) stopWaiting(d.db, job.id, taskId);
  // Held from now until the attempt ends, whichever way; reachable by its Leg's pause or cancel.
  let ended: () => void = () => {};
  const untrack = trackAttempt({
    jobId: job.id,
    taskId,
    legId: leg.legId,
    stop: (why) => legStop.abort(why),
    ended: new Promise<void>((r) => {
      ended = r;
    }),
  });
  const hold = d.supervisor.hold(leg.legId);
  const release = () => {
    hold();
    untrack();
    ended();
  };
  const routing = {
    leg: leg.legName,
    model: leg.model,
    effort: pick.effort,
    score: pick.score,
    reasons: pick.reasons,
    excluded: routed.excluded,
  };
  // My messages from the moment the task shows as running reach this attempt (Talking to The Eye).
  const guidanceAtStart = guidanceMark();
  const attemptId = newId(now());
  d.bus.atomically(() => {
    d.db
      .update(tasks)
      .set({
        state: "running",
        assignedLegId: leg.legId,
        assignedModelId: leg.legModelId,
        effort: pick.effort,
        attemptCount: task.attemptCount + 1,
        routing,
      })
      .where(eq(tasks.id, taskId))
      .run();
    d.db
      .insert(attempts)
      .values({
        id: attemptId,
        taskId,
        jobId: job.id,
        legId: leg.legId,
        legModelId: leg.legModelId,
        effort: pick.effort,
        startedAt: now(),
        escalations: [],
      })
      .run();
    d.bus.publish({
      type: "task.state",
      topic: `job:${job.id}`,
      jobId: job.id,
      payload: { taskId, to: "running", routing },
    });
  });

  const ckpt = `refs/oraknid/${job.id}/${taskId}/${attemptNo}`;
  // The task's scope is measured from before its first attempt, so what a crashed one left
  // outside it is still seen (Audit 1 → D1-06).
  const scopeBase = `refs/oraknid/${job.id}/${taskId}/base`;
  try {
    await ws.tree.checkpoint(ckpt, `oraknid: before ${task.title} (attempt ${attemptNo})`);
    await ws.tree.checkpoint(scopeBase, `oraknid: before ${task.title}`, true);
  } catch (error) {
    release();
    // No attempt or task is left looking alive by a checkpoint that failed (Audit 1 → Q1-13).
    d.db
      .update(attempts)
      .set({ endedAt: now(), outcome: "abandoned" })
      .where(eq(attempts.id, attemptId))
      .run();
    d.db.update(tasks).set({ state: "ready" }).where(eq(tasks.id, taskId)).run();
    throw error;
  }

  const before = d.db
    .select()
    .from(attempts)
    .where(eq(attempts.taskId, taskId))
    .orderBy(desc(attempts.startedAt))
    .all()
    .find((a) => a.id !== attemptId);
  // The attempt log (ADR-056 §1): what this attempt does, decides and ends as.
  const attemptLog = new AttemptLog(d.db, now);
  const trail = attemptLog.at({ jobId: job.id, taskId, attemptId });
  // What the attempt before left behind: a handoff when a crash wrote none, the actions it left
  // without a result marked uncertain (ADR-056 §1).
  if (before)
    await takeOver(d, attemptLog, { jobId: job.id, task, before }, () =>
      safeDiffStat(ws, `refs/oraknid/${job.id}/${taskId}/${attemptNo - 1}`),
    );

  // The same model again (the top of the ladder, a stop, a step up in effort): its own session
  // is resumed with what happened, not a fresh one that finds everything again (ADR-052 §1).
  // Never after its work was rolled back (a kill), and only where the Leg can resume: what its
  // probe found, never a list of kinds here; never probed, a fresh session with the handoff.
  const resumeFrom =
    before &&
    before.legModelId === leg.legModelId &&
    before.outcome !== "succeeded" &&
    !(before.escalations as string[]).some((e) => e.endsWith(":kill")) &&
    d.registry.features(leg.legId)?.resume === true
      ? (d.db
          .select({ native: sessions.nativeSessionId })
          .from(sessions)
          .where(eq(sessions.attemptId, before.id))
          .orderBy(desc(sessions.startedAt))
          .all()
          .find((s) => s.native)?.native ?? null)
      : null;

  const started = now();
  /** What the attempt carries from turn to turn (harness/facts.ts): the ladder, what was observed. */
  const st: AttemptState = {
    level: task.escalation,
    escalations: [],
    observed: {
      scope: scopeOf(task),
      changedPaths: [],
      commands: [],
      verifyFailures: [],
      falseClaim: null,
      lastActivityAt: now(),
      tokensSinceProgress: 0,
      taskBudgetTokens: null,
      forbidden: [],
      gateBypass: [],
      local: leg.profile.costModel === "local",
    },
    tokensBaseline: 0,
    sessionTokens: 0,
    usage: null,
    turns: 0,
    ownerAsked: new Set(),
    // Only messages written after this attempt began: older ones are in Silk, in its context pack.
    guidanceSeen: guidanceAtStart,
    stuckFrom: 0,
    nudged: false,
    signalled: new Set(),
  };
  const observed = st.observed;
  // Typed by assertion: they change inside closures, which narrowing cannot follow.
  let session = null as Supervised | null;
  let sessionLog: string | null = null;
  /** The job's servers as its commands name them, production marked (ADR-049): filled by prepareServers. */
  const servers: JobServerRef[] = [];
  /** Commands waiting for their result, by tool call id. */
  const pending = new Map<string, string>();
  /** What every turn's events tell the drift detectors: commands, results, usage, activity. */
  const watch = (e: LegEvent) => {
    observed.lastActivityAt = now();
    logEvent(e);
    if (e.type === "tool.called" && typeof e.input.command === "string")
      pending.set(e.id, e.input.command);
    if (e.type === "tool.result" && pending.has(e.id)) {
      observed.commands.push({
        command: pending.get(e.id) as string,
        outputHash: hash(`${e.ok}:${e.output}`),
      });
      pending.delete(e.id);
    }
    // Claude Code's own auto mode refused a call (ADR-053): the Gate counts it like any other block.
    if (e.type === "permission.denied" && e.by === "leg") gate.legRefused(e.request, e.reason);
    if (e.type === "usage") {
      st.sessionTokens = e.usage.inputTokens + e.usage.outputTokens;
      observed.tokensSinceProgress = Math.max(0, st.sessionTokens - st.tokensBaseline);
      st.usage = e.usage;
    }
  };

  const event = (type: string, payload: Record<string, unknown>) =>
    d.bus.publish({ type, topic: `job:${job.id}`, jobId: job.id, payload: { taskId, ...payload } });

  const toolRows = d.tools && job.tools.length ? d.tools.registry.byNames(job.tools) : [];
  /**
   * Every action of the agent, from every source, is decided by the Gate
   * (ADR-056 §3): the adapters below only translate its decision.
   */
  const gate = createGate({
    db: d.db,
    bus: d.bus,
    inbox: d.inbox,
    silk: d.silk,
    now,
    ...(d.brain ? { brain: d.brain } : {}),
    ...(d.tools ? { tools: d.tools.registry } : {}),
    toolRows,
    legsDir: d.legsDir,
    job,
    task,
    leg,
    attemptId,
    cwd: ws.cwd,
    servers,
    signal,
    on: {
      activity: () => {
        observed.lastActivityAt = now();
      },
      forbidden: (what) => observed.forbidden.push(what),
      gateBypass: (what) => observed.gateBypass.push(what),
      event,
    },
  });
  /** The agent's actions, their results (read by the Gate) and words, in the attempt log. */
  const logEvent = recordEvents(trail, gate.ran);
  /** The Leg's permission prompt. */
  const onPermission = async (r: PermissionRequest) =>
    asPermission(await gate.decide({ source: "prompt", request: r }));
  /** Claude Code's PreToolUse hook, in its own auto mode (ADR-053). */
  const onPreToolUse = async (r: PermissionRequest) =>
    asPreTool(await gate.decide({ source: "hook", request: r }));
  const pack = (): string => {
    const window = leg.profile.contextWindow ?? 200_000;
    const built = buildContextPack({
      task: {
        id: task.id,
        title: task.title,
        instructions: task.instructions,
        scope: scopeOf(task),
        verify: task.verify,
      },
      goal: job.goal,
      skill: [
        skillExcerpt(job.skillBody, `${task.title} ${task.kind}`),
        guidanceFromOthers(
          job.skillBody,
          job.otherSkills ?? [],
          `${task.title} ${task.instructions}`,
        ),
      ]
        .filter(Boolean)
        .join("\n\n"),
      entries: d.silk.all(job.id),
      // What earlier jobs of the project settled, not only what this branch holds (ADR-034).
      earlier: d.silk.earlier(job.id),
      digest: "",
      inputs: job.inputs,
      capTokens: Math.floor(window * 0.15),
    });
    // What had to be shortened is summarised in the background for the next pack.
    if (built.shortened.length >= 2)
      void summarizeShortened(d, job.id, ws.cwd, built.shortened).catch((e) =>
        console.error("silk summary failed", e),
      );
    return [
      built.text,
      job.layout ? `# The repos\n\n${job.layout}` : "",
      // A server job's place is its server: no repo, no GitHub (ADR-049).
      job.serverJob ? "" : GIT_TEXT,
      serversText,
      job.serverJob ? "" : githubText(),
    ]
      .filter(Boolean)
      .join("\n\n");
  };

  /** How this job does GitHub work: through Oraknid's github tool, never a CLI or a token (ADR-038). */
  const githubText = () => {
    if (!toolRows.some((t) => t.name === "github" && t.command === BUILT_IN)) return "";
    const link = githubLinkOf(d.db, job.id);
    const repos = githubLinksOf(d.db, job.id);
    const where = ws.tree.several
      ? `This project is several repos; each call names one with \`repo\` (its name in the project). ${repos
          .map((r) =>
            r.github
              ? `**${r.name}** (\`${r.folder}/\`) → **${r.github.owner}/${r.github.name}** (${r.github.visibility}), through ${r.github.account}${r.github.ready ? "" : "; it doesn't exist yet: `create_repo` creates it"}.`
              : `**${r.name}** (\`${r.folder}/\`) has no GitHub repository linked yet: if the task needs one, say so in your report and stop; The Eye asks the owner.`,
          )
          .join(" ")}`
      : link
        ? `This project's GitHub repository is **${link.owner}/${link.name}** (${link.visibility}), through the account ${link.account}${link.ready ? "" : "; it doesn't exist yet: `create_repo` creates it"}.`
        : "This project has no GitHub repository linked yet: if the task needs one, say so in your report and stop; The Eye asks the owner.";
    return `# GitHub\n\n${where}\n\nDo every GitHub action with the \`github\` tool (the oraknid-github MCP server): \`repo_info\`, \`create_repo\`, \`push\` (a local branch to the linked repo), \`open_pull_request\`. Oraknid holds the token and runs git with it. Never install or run the \`gh\` CLI, never look for or ask for a token, never add a remote with credentials or run \`git push\` yourself.`;
  };

  /** The job's tools for this attempt's sessions, opened with the first one. */
  let toolsOpen = null as BrokerSession | null;
  const openTools = async () => {
    if (toolsOpen || !toolRows.length || !d.tools) return toolsOpen;
    /** A send's place in the outbox: the same message, to the same place, is one action. */
    const sendSpec = (tool: ToolRow, name: string, args: Record<string, unknown>) => ({
      key: `mcp:${tool.name}:${name}:${hash(JSON.stringify(args))}`,
      taskId,
    });
    toolsOpen = await d.tools.broker.open(
      toolRows,
      {
        decide: async (tool, name, args) => {
          const sends = tool.sends.includes(name) && d.effects;
          const spec = sendSpec(tool, name, args);
          if (sends) {
            // At most once (BR-6): a send already made, or caught mid-way by a crash, isn't made again.
            const before = d.effects?.get(SideEffects.keyOf(job.id, spec));
            if (before?.state === "performed" || before?.state === "confirmed")
              return {
                allow: false,
                message: `This exact ${name} was already made in this job; Oraknid doesn't repeat it.`,
              };
            if (before?.state === "performing")
              return {
                allow: false,
                message: `An identical ${name} was interrupted mid-way; the owner is asked whether it happened before it is tried again.`,
              };
          }
          const judged = d.tools?.registry.judge(tool, { jobId: job.id }, name, args);
          const v = asPermission(
            await gate.decide({
              source: "mcp",
              request: {
                tool: `mcp__${tool.name}__${name}`,
                input: args,
                command: null,
                path: null,
              },
              ...(judged !== undefined ? { judged } : {}),
            }),
          );
          // Work on the project's linked repo passes without asking: said in the job's events (ADR-038).
          if (v.allow && typeof judged === "object")
            event("tool.linked", { tool: tool.name, name, reason: "the project's linked repo" });
          if (v.allow && sends && d.effects) {
            const row = d.effects.intend(job.id, {
              ...spec,
              action: `${tool.name}.${name}`,
              payload: { tool: tool.name, name, args },
            });
            d.effects.set(row.idempotencyKey, "performing");
          }
          return v;
        },
        done: (tool, name, o) => {
          if (o.allowed && tool.sends.includes(name) && d.effects) {
            const key = SideEffects.keyOf(job.id, sendSpec(tool, name, o.args));
            if (d.effects.get(key)?.state === "performing")
              d.effects.set(
                key,
                o.ok ? "performed" : "failed",
                o.ok ? { result: { bytes: o.bytes } } : { problem: "the tool said it failed" },
              );
          }
          event("tool.called", {
            tool: tool.name,
            name,
            allowed: o.allowed,
            ok: o.ok,
            bytes: o.bytes,
            ...(o.flags.length ? { flags: o.flags } : {}),
          });
          // What came from outside makes the task untrusted (BR-15).
          if (o.allowed && tool.untrusted)
            gate.markUntrusted(
              `read from ${tool.name} (${name}): gated actions ask me from now on`,
            );
        },
      },
      { jobId: job.id },
    );
    return toolsOpen;
  };

  /**
   * The job's servers (ADR-026): their state documents in the context, and
   * a way in from the Leg's own home: an SSH alias, its key, the pinned host key.
   */
  let serversText = "";
  let serversReady = false;
  const prepareServers = async () => {
    if (serversReady) return;
    serversReady = true;
    serversText = await serversForLeg(d, job, leg.legId, servers);
  };

  /**
   * The task's checks, run by Oraknid itself (BR-1) through the one Verifier
   * (ADR-056 §4): in the sandbox, on its servers, or its own; each command
   * read by the Gate first (§3).
   */
  const verifier = createVerifier(d, job, {
    cwd: ws.cwd,
    localCommit: (branch, repo) => ws.tree.localCommit(branch, repo),
    plan: () =>
      job.unsandboxed
        ? null
        : sandboxPlan(
            d.registry.require(leg.legId),
            d.sandbox,
            d.legsDir,
            job.localPorts ?? [],
            job.id,
          ),
    servers: () => servers,
    prepare: prepareServers,
    refuse: (command, where) => gate.check(command, where),
    signal,
    log: trail,
  });
  const runChecks = (commands: string[], o: RunOptions = {}) => verifier.run(commands, o);

  /**
   * The checks in the loop (ADR-052 §2): before the agent may end its turn,
   * Oraknid runs them; a failure keeps it working (Claude Code's Stop hook,
   * three times at most). A check that looks broken lets it stop: The Eye
   * looks at the check, not the agent.
   */
  const onStop = async (said = ""): Promise<string | null> => {
    if (!task.verify.length) return null;
    trail.append("StopRequested", { text: said.slice(-1000) });
    const report = await runChecks(task.verify, { why: "stop" });
    const bad = report.failures[0];
    if (!bad || report.broken.length) {
      // It lets the turn end now, nothing done after: the turn's end uses this run (bug 5).
      stopRun = { verify: [...task.verify], tree: await treeState(), report };
      return null;
    }
    event("task.checks-held", { command: bad.command, exitCode: bad.exitCode });
    return `Oraknid ran the task's checks and this one fails, so the task isn't done yet:\n${fence(bad.command)}\nfailed (exit ${bad.exitCode}):\n${fence(bad.output.slice(-2000))}\nFix the work, not the check, then finish. If the check itself is wrong, say why and finish.`;
  };

  /**
   * The checks the Stop hook ran when it let the turn end (ADR-052 §2): the
   * same checks on the same work aren't run again at the turn's end (bug 5).
   */
  let stopRun = null as { verify: string[]; tree: string; report: CheckReport } | null;
  /** The work as it stands, to tell whether it changed since the checks ran. */
  const treeState = async () => {
    try {
      return hash(await ws.tree.diffSince(scopeBase));
    } catch {
      return `unknown:${now()}`;
    }
  };

  const openSession = async (prompt: string, resume: string | null = null) => {
    await prepareServers();
    observed.lastActivityAt = now();
    const tools = await openTools();
    // A new session counts its tokens from zero.
    st.sessionTokens = 0;
    st.tokensBaseline = 0;
    try {
      session = await d.supervisor.start({
        legId: leg.legId,
        legModelId: leg.legModelId,
        effort: pick.effort,
        jobId: job.id,
        taskId,
        attemptId,
        cwd: ws.cwd,
        systemPrompt: pack(),
        prompt,
        ...(resume ? { resumeFrom: resume } : {}),
        unsandboxed: job.unsandboxed,
        localPorts: job.localPorts ?? [],
        onPermission,
        onStop,
        // Named in the session's prompt by adapters that list them; Oraknid runs them (onStop).
        checks: task.verify,
        // Careful keeps every prompt Oraknid's; auto and full let Claude Code's own auto mode
        // judge, with Oraknid's rules before every tool (ADR-053). Other Legs ignore it.
        permissionMode: job.autonomy === "careful" ? "ask" : "auto",
        onPreToolUse,
        ...(tools ? { tools } : {}),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      // A Leg that fails to start is unusable for now, never the task failing (ADR-052 §4).
      const why = error instanceof Error ? error.message : String(error);
      const outcome = markUnusable({ d, task, leg, event }, why, true);
      throw new EndAttempt(
        outcome ?? {
          kind: "retry",
          reason: `${leg.legName} could not start a session (${why}); the attempt doesn't count against the task`,
        },
        { kind: "CouldNotStart" },
      );
    }
    const row = d.db
      .select({ logFile: sessions.logFile })
      .from(sessions)
      .where(eq(sessions.id, session.id))
      .get();
    sessionLog = row?.logFile ?? null;
    trail.append("SessionOpened", {
      sessionId: session.id,
      legId: leg.legId,
      model: leg.model,
      resumed: resume,
    });
    return session;
  };

  /** Writes a handoff to Silk: asked of the Leg when it can still answer, rebuilt from its log otherwise. */
  const handOff = async (askLeg: boolean, failed = "") => {
    let body = "";
    if (askLeg && session) {
      try {
        await session.session.send(HANDOFF_REQUEST);
        body = (await nextTurnEnd(session, signal, 120_000))?.text ?? "";
      } catch {}
    }
    if (!/## Goal of the task/.test(body)) {
      body = sessionLog
        ? handoffFromLog({
            goal: task.instructions,
            logFile: sessionLog,
            diffStat: await safeDiffStat(ws, ckpt),
          })
        : "No session ran yet.";
    }
    // What the attempt log says (ADR-056 §7): what was tried, what the Gate refused, the checks.
    const logged = handoffFromAttempt(attemptLog, attemptId);
    if (logged) body = `${body}\n\n${logged}`;
    const entry = d.silk.add({
      jobId: job.id,
      taskId,
      kind: "handoff",
      title: `Handoff: ${task.title}`,
      // What failed, for the model that takes it next (ADR-052 §3).
      body: failed
        ? `${body}\n\n## Why it was handed over\n${leg.legName} · ${leg.model} didn't get it done:\n${failed}`
        : body,
      authoredBy: session ? { legId: leg.legId } : "eye",
    });
    trail.append("HandoffWritten", { silkId: entry.id, failed: failed || null });
  };

  const closeSession = async (how: "close" | "kill" | "stop" = "close") => {
    if (session)
      await (how === "kill"
        ? session.session.kill()
        : d.supervisor.close(session, how === "stop" ? "stopped" : "closed"));
    session = null;
  };

  /** The project's GitHub repos a check may be about, for The Eye's look at it (ADR-038, ADR-042). */
  const githubForRepair = (): GitHubForRepair => {
    if (!ws.tree.several) {
      const l = githubLinkOf(d.db, job.id);
      return l ? { repo: `${l.owner}/${l.name}`, visibility: l.visibility } : null;
    }
    const repos = githubLinksOf(d.db, job.id).filter((x) => x.github);
    return repos.length
      ? repos.map((x) => ({
          repo: `${x.github?.owner}/${x.github?.name}`,
          visibility: x.github?.visibility ?? "private",
          name: x.name,
        }))
      : null;
  };

  /**
   * Broken checks repaired, never counted against an agent (The-Eye → A check
   * that is wrong; ADR-052 §2): a failure that looks like the check's own
   * (syntax, quoting, a missing tool), or one the agent shows with evidence
   * to be the check's, is looked at by The Eye on its strongest model. A
   * broken check is replaced by one that tests the same thing, and the checks
   * run again; at most twice.
   */
  const repairBroken = async (
    checked: CheckReport,
    report: string,
    rerun: () => Promise<CheckReport>,
    before = false,
  ): Promise<CheckReport> => {
    const said = before ? null : saysCheckBroken(report);
    const looked = new Set<string>();
    for (let repairs = 0; repairs < 2 && d.brain; repairs++) {
      const bad = checked.failures[0];
      if (!bad || looked.has(bad.command)) break;
      // A guard (what the work must keep true) failing before any work is wrong itself (ADR-049):
      // the Verifier's report says so.
      const guard = before && checked.guards.some((g) => g.command === bad.command);
      const own = checked.broken.find((b) => b.command === bad.command)?.hint ?? null;
      const hint = own ?? (said ? `the agent says the check is broken: “${said}”` : null);
      if (!hint) break;
      looked.add(bad.command);
      let repair: CheckRepair;
      try {
        repair = await d.brain.repairCheck({
          jobId: job.id,
          cwd: ws.cwd,
          task: { title: task.title, instructions: task.instructions },
          command: bad.command,
          output: bad.output,
          hint,
          report: before ? "(The check was run before any work, to test it.)" : report,
          github: githubForRepair(),
          ...(servers.length
            ? { servers: servers.map((s) => ({ alias: s.alias, name: s.name })) }
            : {}),
          ...(guard ? { guard: true } : {}),
        });
      } catch (error) {
        // I stopped The Eye's thinking (M13.25): the job pauses here.
        if (error instanceof BrainStopped) throw error;
        break;
      }
      event("task.check-reviewed", {
        command: bad.command,
        broken: repair.broken,
        replacement: repair.broken ? repair.command : null,
        reason: repair.reason,
        ...(before ? { before: true } : {}),
        ...(!own && said ? { agentSaid: said } : {}),
      });
      if (!repair.broken) break;
      task.verify = task.verify.map((v) => (v === bad.command ? repair.command : v));
      // The file a corrected check names is the task's to write (M13.22).
      observed.scope = scopeOf(task);
      d.db.update(tasks).set({ verify: task.verify }).where(eq(tasks.id, taskId)).run();
      d.silk.add({
        jobId: job.id,
        taskId,
        kind: "decision",
        title: `Check corrected: ${task.title}`,
        body: `\`${bad.command}\` was wrong (${repair.reason}). It is now \`${repair.command}\`.`,
        authoredBy: "eye",
      });
      checked = await rerun();
    }
    return checked;
  };

  /**
   * Checks tested before they judge (ADR-052 §2): each of the task's checks
   * run once before its first attempt. Failing on work not done yet is what
   * a check should do; a broken one (syntax, quoting, a missing tool) is
   * repaired now, before any agent can be failed by it. What the run left in
   * the folder is put back. Said in the job's events.
   */
  const tryChecksFirst = async () => {
    if (!task.verify.length || !d.brain) return;
    const key = `eye.checksTried.${taskId}`;
    if (readSetting(d.db, key, z.boolean(), false)) return;
    const tried: { command: string; state: string }[] = [];
    // A check on a server in its plain form, `ssh <alias>` alone (ADR-049): kept so.
    await prepareServers();
    const plain = task.verify.map((v) =>
      servers.length
        ? plainServerCheck(
            v,
            servers.map((s) => s.alias),
          )
        : v,
    );
    if (plain.some((v, i) => v !== task.verify[i])) {
      const was = task.verify.filter((v, i) => v !== plain[i]);
      task.verify = plain;
      d.db.update(tasks).set({ verify: task.verify }).where(eq(tasks.id, taskId)).run();
      d.silk.add({
        jobId: job.id,
        taskId,
        kind: "decision",
        title: `Check put in its plain form: ${task.title}`,
        body: `${was.map((v) => `\`${v}\``).join(", ")} named the job's own ssh setup, which isn't where checks run: a check reaches a server by its alias alone, and Oraknid runs it there over its own connection.`,
        authoredBy: "eye",
      });
    }
    for (let i = 0; i < task.verify.length; i++) {
      const command = task.verify[i] as string;
      const before = { timeoutMs: 3 * 60_000, before: true, why: "before" };
      const first = await runChecks([command], before);
      const r = first.results[0];
      if (!r) continue;
      if (r.ok) {
        tried.push({ command, state: "passes before the work" });
        continue;
      }
      // A guard failing before any work is wrong (ADR-049): repaired like a broken one.
      if (!first.broken.length) {
        tried.push({ command, state: "fails on the work not done yet" });
        continue;
      }
      const after = await repairBroken(
        first,
        "",
        () => runChecks([task.verify[i] as string], before),
        true,
      );
      const current = task.verify[i] as string;
      tried.push({
        command,
        state:
          current !== command
            ? `broken, repaired as \`${current}\``
            : after.results[0] && after.broken.length
              ? "looks broken, and The Eye kept it"
              : "fails on the work not done yet",
      });
    }
    try {
      if ((await ws.tree.changedSince(ckpt)).length) await ws.tree.rollback(ckpt, ws.trash);
    } catch {}
    writeSetting(d.db, key, z.boolean(), true);
    event("task.checks-tried", { checks: tried });
  };

  /** Why the last attempt on this task stopped, for a session resumed (ADR-052 §1). */
  const lastStop = (): string => {
    if (!before) return "";
    const said = d.silk
      .all(job.id)
      .filter(
        (e) =>
          e.taskId === taskId &&
          e.createdAt >= before.startedAt &&
          (e.kind === "handoff" || e.kind === "issue") &&
          !e.title.startsWith("Uncertain after a restart"),
      )
      .sort((a, b) => a.createdAt - b.createdAt)
      .at(-1);
    const why = said?.body.split("## Why it was handed over")[1]?.trim();
    return (
      why ??
      (before.outcome === "abandoned"
        ? "it was stopped at a safe point"
        : "its last turn didn't finish the task")
    ).slice(0, 1500);
  };

  /**
   * A model on a higher rung of the ladder for this kind of work that may
   * take the task now (ADR-052 §3); null at the top, for a task I pinned or
   * gave to a Leg, or with nothing stronger allowed.
   */
  const higherRung = (): Route | null => {
    const mine = rungOf(leg.profile, work, task.kind as TaskKind);
    const now = candidatesFor(d.registry, job.allowedLegIds).filter(
      (c) =>
        !avoidLegs.has(c.legId) &&
        (!blockedKinds.has(d.registry.require(c.legId).kind) || limitedLegs.has(c.legId)),
    );
    const r = route({ ...routeTask, avoid: [...new Set([...task.avoid, leg.legModelId])] }, now, {
      ...routeOptions,
      claudeShare: claudeShareOf(d, job.id, budget),
    });
    const up = nextRung(mine, r.ranked, !!task.pinnedModelId || back.length > 0);
    return up === "top" ? null : up;
  };

  /** A question of mine said in the project's conversation too (ADR-045). */
  const conversationAsks = (
    text: string,
    questions: ReturnType<typeof choiceQuestion>[],
    itemId: string,
  ) =>
    addMessage(
      d,
      job.id,
      "eye",
      text,
      {
        intent: "report",
        did: [],
        silkIds: [],
        taskIds: [taskId],
        jobId: null,
        report: { kind: "waiting", taskId, facts: [], todo: [] },
      },
      { questions, itemId },
    );

  /** The attempt ends, recorded as counted (core's `countOf`): learned from when it says something of the model. */
  const finish = (ending: Ending) => {
    const c = countOf(ending);
    release();
    gate.withdrawAsked();
    trail.append("Outcome", { kind: c.record, reason: st.escalations.at(-1) ?? null });
    trail.append("AttemptEnded", { reason: c.record });
    d.db
      .update(attempts)
      .set({ endedAt: now(), outcome: c.record, escalations: st.escalations })
      .where(eq(attempts.id, attemptId))
      .run();
    const m = d.registry.model(leg.legModelId);
    // Its provider failing says nothing of what the model can do (M13.22).
    if (m && c.record !== "unavailable" && c.learn) {
      const stored = record(d.registry.storedProfile(m), task.kind as TaskKind, {
        success: c.success,
        tokens: st.observed.tokensSinceProgress,
        ms: now() - started,
        escalations: st.escalations.length,
      });
      d.registry.saveProfile(m.id, stored);
    }
  };

  /** What the turn's end is decided with (ADR-056 §6): the attempt's parts, for `facts.ts` and `apply.ts`. */
  const x: AttemptCtx = {
    d,
    job,
    task,
    leg,
    effort: pick.effort ?? null,
    work,
    ws,
    gate,
    log: attemptLog,
    trail,
    attemptId,
    ckpt,
    scopeBase,
    signal,
    servers,
    st,
    event,
    session: () => session,
    handOff,
    closeSession,
    openSession,
    turnEnd: (ms) => nextTurnEnd(session as Supervised, signal, ms, watch),
    runChecks,
    repairBroken: (checked, report, rerun) => repairBroken(checked, report, rerun),
    treeState,
    higher: () => {
      const up = higherRung();
      return up ? { legName: up.candidate.legName, model: up.candidate.model } : null;
    },
    conversationAsks: (text, questions, itemId) =>
      conversationAsks(text, questions as ReturnType<typeof choiceQuestion>[], itemId),
    scope: () => scopeOf(task),
  };

  try {
    // Checks tested before they judge (ADR-052 §2): run once before the work, a broken one is
    // repaired before any agent can be failed by it.
    await tryChecksFirst();
    const handoff = d.silk.current(job.id).some((e) => e.kind === "handoff" && e.taskId === taskId);
    // The agent runs the checks itself, in the loop (ADR-052 §2).
    const checksLine = task.verify.length
      ? "Run its checks yourself and keep working until they pass, then say DONE"
      : "Say DONE when it is finished";
    // What the model before didn't get done goes with the task up the ladder (ADR-052 §3).
    const stopped = before && before.outcome !== "succeeded" ? lastStop() : "";
    if (resumeFrom) event("task.resumed", { nativeSessionId: resumeFrom });
    await openSession(
      resumeFrom
        ? `Oraknid continues this session after it stopped: ${stopped || "it was stopped"}\n\nPick up where you left off. ${checksLine}.`
        : handoff
          ? `Continue the task. The handoff above says where the last session stopped${before?.outcome === "failed" && stopped ? `, and what it didn't get done:\n${stopped}\n\n` : ". "}${checksLine}.`
          : `Do the task described above: plan it your own way, in this session. ${checksLine} and summarise what you changed.`,
      resumeFrom,
    );
    for (;;) {
      if (!session) throw new Error("no session");
      const end = await nextTurnEnd(session, signal, d.stallCheckMs ?? 30_000, watch);
      if (end) st.turns++;
      // What the Stop hook ran as it let this turn end, if it did: used once (bug 5).
      const ranAtStop = end ? stopRun : null;
      if (end) stopRun = null;
      const turn = beginTurn(x, end, ranAtStop, () => safeStrayed(ws.tree));
      // Gather the facts, decide (core's decideOutcome), do what it says (ADR-056 §6).
      while ((await applyOutcome(decideOutcome(factsOf(x, turn)), x, turn)) === "decide");
    }
  } catch (error) {
    if (error instanceof EndAttempt) {
      finish(error.ending);
      return error.outcome;
    }
    // Stopped (pause, cancel, shutdown) or failed: leave a handoff behind, then let the engine decide.
    const open = session as Supervised | null;
    if (open) {
      try {
        await open.session.interrupt();
      } catch {}
      await closeSession("stop");
      try {
        await handOff(false);
      } catch {}
    }
    // Its Leg alone was stopped (paused, or its work here cancelled): the work so far is kept
    // on a checkpoint beside the handoff (BR-7), and the job goes on.
    const byLeg =
      !jobSignal.aborted && legStop.signal.aborted && legStop.signal.reason instanceof LegStop
        ? (legStop.signal.reason as LegStop)
        : null;
    if (byLeg) {
      try {
        await ws.tree.checkpoint(
          `refs/oraknid/${job.id}/${taskId}/${attemptNo}-stopped`,
          `oraknid: ${task.title} stopped (${byLeg.how === "room" ? "paused for room" : `${byLeg.how} of ${byLeg.legName}`})`,
        );
      } catch {}
    }
    // Stopped by me or its job (a pause, a restart) says nothing of the model (ADR-052 §3).
    finish({ kind: "Stopped", byJob: signal.aborted });
    if (byLeg) {
      setReady(byLeg.message);
      return { kind: "leg-stopped", how: byLeg.how, reason: byLeg.message };
    }
    setReady("Stopped at a safe point; it starts again on resume.");
    throw error;
  } finally {
    toolsOpen?.close();
  }

  /** Nothing runs it any more: shown as ready at once, not "running" until it starts again. */
  function setReady(reason: string) {
    d.bus.atomically(() => {
      d.db
        .update(tasks)
        .set({ state: "ready", leaseUntil: null })
        .where(
          and(eq(tasks.id, taskId), inArray(tasks.state, ["assigned", "running", "verifying"])),
        )
        .run();
      d.bus.publish({
        type: "task.state",
        topic: `job:${job.id}`,
        jobId: job.id,
        payload: { taskId, to: "ready", reason },
      });
    });
  }
}

/** What every Leg is told about git: the folder stays a worktree, the repo's part is Oraknid's. */
const GIT_TEXT = `# Git

This folder is a git worktree of the project, on the job's branch. Oraknid commits your work there when its checks pass; merging into the work branch and pushing to GitHub are Oraknid's own steps when the job ends. So don't commit into other branches, merge, push, or run git init, and never move, delete or edit a .git or the project's worktrees: such commands are refused.`;

/** The worktrees that left the project, or none when that can't be told. */
function safeStrayed(tree: WorkTree): { folder: string; problem: string }[] {
  try {
    return tree.strayed();
  } catch {
    return [];
  }
}

/** A Leg's limit of task sessions at once: its own setting, else its kind's (ADR-050). */
const legLimit = (d: AttemptDeps, legId: string) => legSessionLimit(d.registry, legId);

/** Waits, or throws as soon as the attempt is stopped. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/** What changed since a checkpoint, or nothing when git can't tell. */
async function safeDiffStat(ws: { tree: WorkTree }, since: string): Promise<string> {
  try {
    return await ws.tree.diffStatSince(since);
  } catch {
    return "";
  }
}

/** Reads events until a turn ends; null when `ms` pass first (time to look for a stall). */
/** The read in flight on each session's events, kept across calls. */
const waiting = new WeakMap<AsyncIterator<LegEvent>, Promise<IteratorResult<LegEvent>>>();

async function nextTurnEnd(
  s: Supervised,
  signal: AbortSignal,
  ms: number,
  onEvent?: (e: LegEvent) => void,
): Promise<Extract<LegEvent, { type: "turn.ended" }> | null> {
  const it = iterators.get(s) ?? s.events[Symbol.asyncIterator]();
  iterators.set(s, it);
  const deadline = Date.now() + ms;
  for (;;) {
    if (signal.aborted) throw signal.reason;
    const left = deadline - Date.now();
    if (left <= 0) return null;
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    // A read still pending from a call that timed out is reused, never dropped: dropping it
    // lost the event it later delivered (a turn's end), and the attempt waited for ever.
    const pending = waiting.get(it) ?? it.next();
    waiting.set(it, pending);
    const next = await Promise.race([
      pending,
      new Promise<"timeout">((r) => {
        timer = setTimeout(() => r("timeout"), left);
      }),
      new Promise<"abort">((r) => {
        onAbort = () => r("abort");
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]).finally(() => {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener("abort", onAbort);
    });
    if (next === "timeout") return null;
    if (next === "abort") throw signal.reason;
    waiting.delete(it);
    if (next.done)
      return { type: "turn.ended", reason: "error", text: "", error: "The session ended." };
    onEvent?.(next.value);
    if (next.value.type === "turn.ended") return next.value;
  }
}

const iterators = new WeakMap<Supervised, AsyncIterator<LegEvent>>();

/**
 * What a task may change (M13.22): its scope, the files its checks and
 * instructions name, docs/ for research and planning (taskScope).
 */
const scopeOf = (task: TaskRow) =>
  taskScope({
    kind: task.kind,
    scope: task.scope,
    verify: task.verify,
    instructions: task.instructions,
  });

/** Every visible Leg model the job may use, as routing candidates. */
export function candidatesFor(registry: LegRegistry, allowed: string[]): RouteCandidate[] {
  const out: RouteCandidate[] = [];
  for (const leg of registry.all()) {
    if (allowed.length && !allowed.includes(leg.id)) continue;
    const view = registry.view(leg);
    for (const m of view.models.filter((x) => !x.hidden)) {
      out.push({
        legId: leg.id,
        legModelId: m.id,
        model: m.model,
        legName: leg.name,
        health: view.health,
        paused: view.paused,
        effortLevels: m.effortLevels,
        profile: m.profile,
        windows: [...view.quota, ...m.quota],
        cooldown: registry.cooldownOf(leg.id, m.id),
        legProviderFailures: registry.providerStreak(leg.id),
        legKind: leg.kind,
      });
    }
  }
  return out;
}

/**
 * The job's Claude share (ADR-052 §3): its budget's, else my setting for
 * every job; with how much of its attempts so far ran on Claude. Null: as
 * needed.
 */
function claudeShareOf(
  d: AttemptDeps,
  jobId: string,
  budget: Budget | undefined,
): { limit: number; used: number } | null {
  const limit =
    budget?.claudeShare ??
    readSetting(d.db, CLAUDE_SHARE, z.number().min(0).max(1).nullable(), null);
  if (limit === null || limit === undefined) return null;
  const rows = d.db
    .select({ legId: attempts.legId, outcome: attempts.outcome })
    .from(attempts)
    .where(eq(attempts.jobId, jobId))
    .all()
    .filter((a) => a.outcome !== "unavailable");
  const claude = new Set(
    d.registry
      .all()
      .filter((l) => l.kind === "claude-code")
      .map((l) => l.id),
  );
  const used = rows.length ? rows.filter((r) => claude.has(r.legId)).length / rows.length : 0;
  return { limit, used };
}

/**
 * Why no Leg can take a task, in words that say what to do (ADR-052 §4):
 * a paused Leg is paused, not out of quota; a quota says until when; a Leg
 * that can't start says why. Never "out of quota" for a Leg that isn't.
 */
function whyNoLeg(
  d: AttemptDeps,
  job: AttemptJob,
  title: string,
  excluded: { legModelId: string; why: string }[],
  until: number | null,
): string {
  const at = d.now();
  const legsAllowed = d.registry
    .all()
    .filter((l) => !job.allowedLegIds.length || job.allowedLegIds.includes(l.id));
  if (!legsAllowed.length) return `No Leg can take "${title}": there are no Legs.`;
  const parts: string[] = [];
  let paused = 0;
  for (const l of legsAllowed) {
    if (l.paused) {
      paused++;
      parts.push(`${l.name} is paused in Oraknid: unpause it on its card (Legs) to go on`);
    } else if (!l.enabled) parts.push(`${l.name} is turned off: turn it on in Legs`);
    else if (l.health === "rate-limited" && l.limitedUntil && l.limitedUntil > at)
      parts.push(`${l.name} is out of quota until ${whenSaid(l.limitedUntil, at)}`);
    else if (l.health === "rate-limited") parts.push(`${l.name} is out of quota`);
    else if (l.health === "unavailable" || l.health === "disabled")
      parts.push(`${l.name} can't be used: ${l.healthDetail ?? l.health}`);
    else {
      const ids = new Set(d.registry.models(l.id).map((m) => m.id));
      const whys = excluded.filter((e) => ids.has(e.legModelId)).map((e) => e.why);
      if (whys.length) parts.push(whys.join(" ").replace(/\.$/, ""));
    }
  }
  const when = until ? ` It goes on by itself at ${whenSaid(until, at)}.` : "";
  const act =
    paused && paused === legsAllowed.length
      ? " Unpause one to go on."
      : !until && paused
        ? " Unpause a Leg, or add one that can do it."
        : "";
  return `No Leg can take "${title}": ${parts.join("; ") || "none of them fits it"}.${when}${act}`;
}
