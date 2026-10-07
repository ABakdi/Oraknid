import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type Autonomy,
  type Budget,
  choiceQuestion,
  type Difficulty,
  isProduction,
  type MetricsSample,
  type TaskKind,
} from "@oraknid/contracts";
import {
  buildContextPack,
  busyMachine,
  claimsDone,
  correctivePrompt,
  DEFAULT_THRESHOLDS,
  type Drift,
  type DriftCode,
  deprecationOf,
  detect,
  fence,
  type GatedAction,
  guidanceFromOthers,
  HANDOFF_REQUEST,
  inScope,
  nextEscalation,
  type Observed,
  oraknidOwn,
  providerFailure,
  type Route,
  type RouteCandidate,
  record,
  route,
  rungOf,
  saysCheckBroken,
  saysOwnerNeeded,
  skillExcerpt,
  taskScope,
  usageLimitOf,
  type WorkKind,
  whenSaid,
  workKindOf,
} from "@oraknid/core";
import type { LegEvent, PermissionRequest, UsageSnapshot } from "@oraknid/leg-sdk";
import type { Sandbox } from "@oraknid/os";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/open.ts";
import { attempts, jobs, sessions, tasks } from "../db/schema.ts";
import { SideEffects } from "../engine/effects.ts";
import type { EventBus } from "../events/bus.ts";
import { ALLOW, asPermission, asPreTool, createGate } from "../harness/gate.ts";
import { newId } from "../ids.ts";
import type { InboxStore } from "../inbox/store.ts";
import { jobHomeDir } from "../legs/job-home.ts";
import { sandboxPlan } from "../legs/plan.ts";
import type { LegRegistry } from "../legs/registry.ts";
import type { LegSupervisor, Supervised } from "../legs/supervisor.ts";
import { legSessionLimit } from "../resources/work.ts";
import { runServerCheck } from "../servers/checks.ts";
import { isGuardCheck, type JobServerRef, parseSsh, plainServerCheck } from "../servers/remote.ts";
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
import { runBuiltinCheck } from "./builtin-checks.ts";
import { giveToLeg, LegStop, legLimits, stopWaiting, trackAttempt } from "./leg-work.ts";
import { dependentsOf, keepsGoingWrong, readKeepsGoingWrong } from "./questions.ts";
import { addMessage, guidanceMark, takeGuidance } from "./talk.ts";
import { looksBroken, runVerify, type VerifyResult } from "./verify.ts";

/** The providers (Leg kinds) for which I allowed same-provider fallback (ADR-009). */
export const SAME_PROVIDER_FALLBACK = "fallback.sameProvider";

/** The other answers when the agent says it can't finish without me. */
export const ILL_DO_IT = "I'll do it";
export const LEAVE_IT_OUT = "Leave it out";
export const STOP_JOB = "Stop the job";

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

/** Ladder steps that end the attempt, and why. */
class EndAttempt extends Error {
  constructor(
    readonly outcome: AttemptOutcome,
    /** The Leg or its model couldn't be used, not the task failing: not counted (ADR-052 §4). */
    readonly unavailable = false,
    /**
     * Ended by my answer: a "try again" isn't counted against the task (bug 10), and no
     * choice of mine is learned as the model's failure (bug 11).
     */
    readonly byOwner = false,
  ) {
    super(outcome.kind);
  }
}

const SEVERITY: DriftCode[] = ["D8", "D7", "D1", "D4", "D3", "D2", "D6", "D5"];
const PREFIX: Record<TaskKind, string> = {
  plan: "docs",
  research: "docs",
  implement: "feat",
  test: "test",
  review: "refactor",
  mechanical: "chore",
  external: "chore",
};

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

  // A crash leaves no handoff behind: built now from its session's log (Durability step 4; Audit 1 → D1-06).
  const before = d.db
    .select()
    .from(attempts)
    .where(eq(attempts.taskId, taskId))
    .orderBy(desc(attempts.startedAt))
    .all()
    .find((a) => a.id !== attemptId);
  if (before?.outcome === "abandoned") {
    const handedOff = d.silk
      .all(job.id)
      .some((e) => e.kind === "handoff" && e.taskId === taskId && e.createdAt >= before.startedAt);
    const log = d.db
      .select({ logFile: sessions.logFile })
      .from(sessions)
      .where(eq(sessions.attemptId, before.id))
      .orderBy(desc(sessions.startedAt))
      .get()?.logFile;
    if (!handedOff && log)
      d.silk.add({
        jobId: job.id,
        taskId,
        kind: "handoff",
        title: `Handoff: ${task.title}`,
        body: handoffFromLog({
          goal: task.instructions,
          logFile: log,
          diffStat: await safeDiffStat(ws, `refs/oraknid/${job.id}/${taskId}/${attemptNo - 1}`),
        }),
        authoredBy: "eye",
      });
  }

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

  const escalations: string[] = [];
  const started = now();
  /** Tokens of the current session when progress was last made or a drift was acted on (D6 counts from here). */
  let tokensBaseline = 0;
  let sessionTokens = 0;
  let level = task.escalation;
  // Only messages written after this attempt began: older ones are in Silk, in its context pack.
  let guidanceSeen = guidanceAtStart;
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
      sessionTokens = e.usage.inputTokens + e.usage.outputTokens;
      observed.tokensSinceProgress = Math.max(0, sessionTokens - tokensBaseline);
      usage = e.usage;
    }
  };

  let usage = null as UsageSnapshot | null;

  const observed: Observed = {
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
    // In the job's own home on the Leg (Audit 2, S2-08): another job running
    // on it never sees these keys. Emptied at every attempt all the same.
    const ssh = join(jobHomeDir(d.legsDir, leg.legId, job.id), ".ssh");
    mkdirSync(dirname(ssh), { recursive: true, mode: 0o700 });
    rmSync(ssh, { recursive: true, force: true });
    if (!d.servers || !job.serverIds?.length) return;
    mkdirSync(ssh, { recursive: true, mode: 0o700 });
    const config: string[] = [];
    const known: string[] = [];
    const docs: string[] = [];
    for (const id of job.serverIds) {
      // Its role in the project (ADR-042): what it is for, and production said loud.
      const r = job.serverRoles?.[id];
      const role = r?.role ? ` — ${r.role}` : "";
      const prod = isProduction(r) ? " (production: what runs there is live)" : "";
      const chosen = job.server === id ? " — **the server for this job's work**" : "";
      try {
        const s = await d.servers.forLeg(id);
        const keyFile = join(ssh, s.alias);
        writeFileSync(keyFile, s.privateKey.endsWith("\n") ? s.privateKey : `${s.privateKey}\n`, {
          mode: 0o600,
        });
        config.push(
          `Host ${s.alias}\n  HostName ${s.host}\n  Port ${s.port}\n  User ${s.user}\n  IdentityFile ${keyFile}\n  IdentitiesOnly yes\n  StrictHostKeyChecking yes\n  UserKnownHostsFile ${join(ssh, "oraknid_known_hosts")}`,
        );
        if (s.knownHost) known.push(s.knownHost);
        servers.push({ id, name: s.name, alias: s.alias, production: isProduction(r) });
        docs.push(`## ${s.name}${role}${prod}${chosen} — \`ssh ${s.alias}\`\n\n${s.state}`);
      } catch (error) {
        let name = "a server";
        try {
          name = d.servers.row(id).name;
        } catch {}
        docs.push(
          `## ${name}${role}${prod}${chosen} (this job can't reach it: ${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }
    writeFileSync(join(ssh, "config"), `${config.join("\n\n")}\n`, { mode: 0o600 });
    writeFileSync(join(ssh, "oraknid_known_hosts"), `${known.join("\n")}\n`, { mode: 0o600 });
    const named = job.server && job.server !== "none" ? job.serverIds.includes(job.server) : false;
    // ssh reads its config from the account's home, never $HOME: the alias is named with -F (ADR-049).
    const cfg = join(ssh, "config");
    const own = job.serverJob ? servers.find((x) => x.id === job.serverJob) : undefined;
    serversText = `# Servers this job may use\n\nReach each with its alias (\`ssh <alias>\`, \`scp\`, \`rsync\`). Read its state document first: it says what runs there and what must not break. Change only what the task needs; anything else on the server is not yours.${named ? " Work meant for a server (a deploy) goes to the one marked as this job's, and to no other." : ""}\n\nThe aliases are in \`${cfg}\`, which ssh reads only when it is named: \`ssh -F <that file> <alias> '<command>'\` (\`scp -F\` and \`rsync -e "ssh -F …"\` the same way). Put the command run there in one pair of quotes with nothing after it on the line, \`sudo -n\` inside them when it needs root. Every command on a server goes through Oraknid's approvals; on a production server every change asks the owner first. A change the approved plan names that Oraknid's rules block on their own is asked of the owner at once: wait for it. For any other block the task can't do without, say in your last message which command and why: the owner is asked. The task's checks are Oraknid's, run over its own connection: never make one pass another way (a file of your own standing in for a program); if one is wrong, say why and finish.${
      own
        ? `\n\n**This job's place is the server ${own.name}** (\`${own.alias}\`), not a repo: the workspace is a scratch folder for notes and scripts, and the work is done on the server. When the task is done, list in your last message what you changed on the server, a line each.`
        : ""
    }\n\n${docs.join("\n\n")}`;
  };

  /** The task's checks, run by Oraknid itself (BR-1): in the sandbox, on its servers, or its own. */
  const runChecks = async (commands: string[] = task.verify, timeoutMs?: number) => {
    const plan = job.unsandboxed
      ? null
      : sandboxPlan(
          d.registry.require(leg.legId),
          d.sandbox,
          d.legsDir,
          job.localPorts ?? [],
          job.id,
        );
    await prepareServers();
    return runVerify(commands, ws.cwd, plan, {
      signal,
      ...(timeoutMs ? { timeoutMs } : {}),
      // A check's command goes through the Gate too, as Oraknid's own (ADR-056 §3).
      refuse: (command) => gate.check(command, "local"),
      builtin: async (command) =>
        // A check on one of the job's servers runs there, over Oraknid's connection (ADR-049).
        (servers.length && d.servers
          ? await runServerCheck(command, {
              servers,
              run: (id, remote) => (d.servers as Servers).run(id, remote),
              refuse: (c) => gate.check(c, "server"),
            })
          : null) ??
        runBuiltinCheck(command, {
          ...(d.github ? { github: d.github } : {}),
          link: githubLinkOf(d.db, job.id),
          // In a project of several repos, `--repo <name>` says which (ADR-042).
          linkFor: (repo) => {
            const repos = githubLinksOf(d.db, job.id);
            if (repo) {
              const r = repos.find((x) => x.name.toLowerCase() === repo.toLowerCase());
              if (!r)
                return `This project has no repo named ${repo}: its repos are ${repos.map((x) => x.name).join(", ")}.`;
              return r.github;
            }
            const linked = repos.filter((x) => x.github);
            if (repos.length > 1 && linked.length > 1)
              return `This project has several repos: name one with --repo (${linked.map((x) => x.name).join(", ")}).`;
            return (repos.length === 1 ? repos[0]?.github : linked[0]?.github) ?? null;
          },
          localCommit: (branch, repo) => ws.tree.localCommit(branch, repo),
        }),
    });
  };

  /**
   * The checks in the loop (ADR-052 §2): before the agent may end its turn,
   * Oraknid runs them; a failure keeps it working (Claude Code's Stop hook,
   * three times at most). A check that looks broken lets it stop: The Eye
   * looks at the check, not the agent.
   */
  const onStop = async (): Promise<string | null> => {
    if (!task.verify.length) return null;
    const results = await runChecks();
    const bad = results.find((r) => !r.ok);
    if (!bad || looksBroken(bad)) {
      // It lets the turn end now, nothing done after: the turn's end uses this run (bug 5).
      stopRun = { verify: [...task.verify], tree: await treeState(), results };
      return null;
    }
    event("task.checks-held", { command: bad.command, exitCode: bad.exitCode });
    return `Oraknid ran the task's checks and this one fails, so the task isn't done yet:\n${fence(bad.command)}\nfailed (exit ${bad.exitCode}):\n${fence(bad.output.slice(-2000))}\nFix the work, not the check, then finish. If the check itself is wrong, say why and finish.`;
  };

  /**
   * The checks the Stop hook ran when it let the turn end (ADR-052 §2): the
   * same checks on the same work aren't run again at the turn's end (bug 5).
   */
  let stopRun = null as { verify: string[]; tree: string; results: VerifyResult[] } | null;
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
    sessionTokens = 0;
    tokensBaseline = 0;
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
      const outcome = notTheTask(why, true);
      throw new EndAttempt(
        outcome ?? {
          kind: "retry",
          reason: `${leg.legName} could not start a session (${why}); the attempt doesn't count against the task`,
        },
        true,
      );
    }
    const row = d.db
      .select({ logFile: sessions.logFile })
      .from(sessions)
      .where(eq(sessions.id, session.id))
      .get();
    sessionLog = row?.logFile ?? null;
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
    d.silk.add({
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
    results: VerifyResult[],
    report: string,
    rerun: () => Promise<VerifyResult[]>,
    before = false,
  ): Promise<VerifyResult[]> => {
    const said = before ? null : saysCheckBroken(report);
    const looked = new Set<string>();
    for (let repairs = 0; repairs < 2 && d.brain; repairs++) {
      const bad = results.find((r) => !r.ok);
      if (!bad || looked.has(bad.command)) break;
      // A guard (what the work must keep true) failing before any work is wrong itself (ADR-049).
      const guard = before && isGuardCheck(bad.command);
      const own =
        looksBroken(bad) ??
        (guard ? "it guards what the work must keep true, yet fails before any work" : null);
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
      results = await rerun();
    }
    return results;
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
      const first = await runChecks([command], 3 * 60_000);
      const r = first[0];
      if (!r) continue;
      if (r.ok) {
        tried.push({ command, state: "passes before the work" });
        continue;
      }
      // A guard failing before any work is wrong (ADR-049): repaired like a broken one.
      if (!looksBroken(r) && !isGuardCheck(command)) {
        tried.push({ command, state: "fails on the work not done yet" });
        continue;
      }
      const after = await repairBroken(
        first,
        "",
        () => runChecks([task.verify[i] as string], 3 * 60_000),
        true,
      );
      const current = task.verify[i] as string;
      tried.push({
        command,
        state:
          current !== command
            ? `broken, repaired as \`${current}\``
            : after[0] && (looksBroken(after[0]) || (!after[0].ok && isGuardCheck(command)))
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
          (e.kind === "handoff" || e.kind === "issue"),
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
    if (task.pinnedModelId || back.length) return null;
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
    return r.ranked.find((x) => (x.rung ?? 0) > mine) ?? null;
  };

  /** A usage limit on this Leg: another account of its provider isn't a fallback unless I allowed it (ADR-009). */
  const markLimited = () => {
    task.limitedKinds = [
      ...new Set([...task.limitedKinds, `${d.registry.require(leg.legId).kind}:${leg.legId}`]),
    ];
    // Not "avoid": a quota is no failure, and the ladder climbs only on failures (ADR-052 §3).
    d.db.update(tasks).set({ limitedKinds: task.limitedKinds }).where(eq(tasks.id, taskId)).run();
  };

  /**
   * An end that isn't the task's, read from the Leg's own words (ADR-052
   * §4, M13.22): a model its provider deprecated (hidden, the one it names
   * offered instead), a usage limit (the Leg out of quota until the reset it
   * says, kept until then), its provider or its program failing (a rest).
   * Each makes the Leg or model unusable until it clears; the attempt
   * doesn't count against the task. Null: the task's own failure.
   */
  const notTheTask = (error: string | null, atStart = false): AttemptOutcome | null => {
    if (!error) return null;
    const what = `${leg.legName} · ${leg.model}`;
    const old = deprecationOf(error);
    if (old && (!old.model || leg.model === old.model || leg.model.endsWith(`/${old.model}`))) {
      const replacementId = d.registry.deprecateModel(leg.legModelId, old.replacement);
      event("task.model-deprecated", {
        legId: leg.legId,
        legModelId: leg.legModelId,
        model: leg.model,
        replacement: old.replacement,
        replacementId,
      });
      return {
        kind: "retry",
        reason: `${what} was deprecated by its provider${old.replacement ? `; ${old.replacement} takes its place` : "; it is hidden"}, and the attempt doesn't count against the task`,
      };
    }
    const limit = usageLimitOf(error, now());
    if (limit) {
      const until = limit.until ?? now() + 15 * 60_000;
      const l = d.registry.require(leg.legId);
      if (!l.limitedUntil || l.limitedUntil < until)
        d.registry.setHealth(
          leg.legId,
          "rate-limited",
          `Out of quota until ${new Date(until).toISOString()}: ${limit.reason}`,
          until,
        );
      markLimited();
      event("task.leg-limited", { legId: leg.legId, until, reason: limit.reason });
      return {
        kind: "retry",
        reason: `${leg.legName} is out of quota until ${whenSaid(until, now())} (${limit.reason})`,
      };
    }
    const infra =
      providerFailure(error) ??
      (atStart
        ? {
            scope: "leg" as const,
            restMs: 2 * 60_000,
            reason: `could not start: ${error}`.slice(0, 160),
          }
        : null);
    if (!infra) return null;
    const { until, inARow } = d.registry.providerFailed(leg.legId, leg.legModelId, infra);
    event("task.provider-failed", {
      legId: leg.legId,
      legModelId: leg.legModelId,
      scope: infra.scope,
      reason: infra.reason,
      until,
      inARow,
    });
    return {
      kind: "retry",
      reason: `${infra.scope === "leg" ? leg.legName : what} failed at its provider (${infra.reason}); it rests until ${new Date(until).toISOString()}, and the attempt doesn't count against the task`,
    };
  };

  /** What the agent said it needs of me, asked once each in this attempt. */
  const ownerAsked = new Set<string>();
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

  /**
   * The agent ended its turn saying it can't finish without me (blocked by a
   * guard, something only I can do or allow) while a check fails: The Eye
   * asks that, specifically, not "keeps going wrong" (ADR-053). The command
   * is the blocked one the agent names, else the last one blocked, else the
   * one its words give. Allowed, the exact command runs once and the agent
   * is told to go on (true); my other answers end the attempt. False:
   * already asked.
   */
  const askOwnerNeeded = async (said: string, report: string, failed: VerifyResult) => {
    const remoteOf = (command: string) =>
      servers.length
        ? parseSsh(
            gate.plain(command),
            servers.map((s) => s.alias),
          )
        : null;
    const names = (b: { command: string }) => {
      const ssh = remoteOf(b.command);
      return report.includes(b.command) || (!!ssh?.remote && report.includes(ssh.remote.trim()));
    };
    const blockedHere = gate.blocked();
    const blocked = [...blockedHere].reverse().find(names) ?? blockedHere.at(-1) ?? null;
    const worded =
      /(?:owner action (?:is )?required|the owner (?:must|needs to|has to|should) run|you (?:can|could|need to) run)\s*:?\s*`?([^`\n]+?)`?\s*(?:$|\n)/i.exec(
        report,
      )?.[1] ?? null;
    const command = blocked?.command ?? worded?.trim() ?? null;
    const key = command ? gate.plain(command) : `said:${said}`;
    if (ownerAsked.has(key)) return false;
    ownerAsked.add(key);
    const ssh = command ? remoteOf(command) : null;
    const server = ssh ? servers.find((s) => s.alias === ssh.alias) : undefined;
    const shown = ssh && server ? `${ssh.remote.trim()}\` on ${server.name}` : `${command}\``;
    const dropped = dependentsOf(d.db, job.id, taskId);
    const prompt = command
      ? `${leg.legName} says it can't finish “${task.title}” without \`${shown}${
          blocked
            ? blocked.byLeg
              ? `, which its own auto mode refused (${blocked.reason})`
              : `, which Oraknid's rules blocked (${blocked.reason})`
            : ""
        }. What should I do?`
      : `${leg.legName} says it can't finish “${task.title}” without you. What should I do?`;
    const questions = [
      choiceQuestion(
        prompt,
        [
          ...(command
            ? [
                {
                  label: ALLOW,
                  detail:
                    "It runs once, exactly as written; the agent is told to go on and finish.",
                },
              ]
            : []),
          {
            label: ILL_DO_IT,
            detail: `The task is yours: do it yourself; the job waits until you mark the task done or hand it back.`,
          },
          {
            label: LEAVE_IT_OUT,
            detail: `The task is dropped and the job goes on without it.${
              dropped.length
                ? ` The tasks that need it are left out too: ${dropped.map((t) => `“${t.title}”`).join(", ")}.`
                : ""
            }`,
          },
          { label: STOP_JOB, detail: "The job is cancelled; the work done so far stays." },
        ],
        command ? ALLOW : null,
      ),
    ];
    const options = questions[0]?.options.map((o) => o.label) ?? [];
    const { answer } = (await gate.askOwner(
      "agent-needs",
      {
        kind: "question",
        jobId: job.id,
        taskId,
        raisedBy: "eye",
        title: command
          ? `${leg.legName} needs \`${shown.slice(0, 100)} for “${task.title}”`
          : `${leg.legName} needs you for “${task.title}”`,
        detail: `${prompt}\n\nIts words: “${said}”\n\nThe check that fails:\n${fence(failed.command)}\n${fence(failed.output.slice(-1500))}${command ? `\n\nThe command:\n${fence(command)}` : ""}`,
        options,
        defaultOption: null,
        questions,
      },
      {
        reason: `the agent needs the owner: ${said.slice(0, 200)}`,
        // Asked in the project's conversation too (ADR-045); answering there answers the item.
        opened: (itemId) => conversationAsks(prompt, questions, itemId),
        throwOnStop: true,
      },
    )) as { answer: string };
    if (answer === ALLOW && command) {
      // A grant, used by the first run of it (ADR-056 §3).
      gate.grantOnce(command, "allowed once: the agent said it can't finish without it");
      // What came of this turn isn't held against the agent: it was waiting on me.
      observed.falseClaim = null;
      observed.verifyFailures.pop();
      await session?.session.send(
        `The owner allows \`${command}\` to run once. Run it now exactly as written, then finish the task and say DONE.`,
      );
      return true;
    }
    if (answer !== ILL_DO_IT && answer !== LEAVE_IT_OUT && answer !== STOP_JOB) {
      // My own words: the agent gets them and goes on. What came of this turn isn't held
      // against it, as with Allow: it was waiting on me (bug 12).
      observed.falseClaim = null;
      observed.verifyFailures.pop();
      await session?.session.send(`The owner answers: ${answer}`);
      return true;
    }
    await closeSession();
    // My choices, not the model's failures (bug 11).
    if (answer === ILL_DO_IT) throw new EndAttempt({ kind: "owner-held" }, false, true);
    if (answer === LEAVE_IT_OUT)
      throw new EndAttempt({ kind: "skipped", dependents: true }, false, true);
    throw new EndAttempt(
      { kind: "cancel-job", reason: `Stopped by me: "${task.title}" couldn't finish without me.` },
      false,
      true,
    );
  };

  const ask = async (drift: Drift): Promise<never> => {
    const jobRow = d.db.select().from(jobs).where(eq(jobs.id, job.id)).get();
    const others = d.registry
      .all()
      .filter(
        (l) =>
          l.id !== leg.legId &&
          !l.paused &&
          (!job.allowedLegIds.length || job.allowedLegIds.includes(l.id)),
      );
    const dropped = dependentsOf(d.db, job.id, taskId);
    const asking = keepsGoingWrong({
      task: task.title,
      leg: `${leg.legName} · ${leg.model}`,
      evidence: drift.evidence,
      escalations,
      others: others.map((l) => ({ id: l.id, name: l.name })),
      dropped: dropped.map((t) => t.title),
      folder: ws.cwd,
      branch: jobRow?.branch ?? null,
    });
    // Withdrawn if the attempt stops before I answer (Audit 1 → D1-07).
    const { itemId, answer: text } = (await gate.askOwner(
      "keeps-going-wrong",
      {
        kind: "question",
        jobId: job.id,
        taskId,
        raisedBy: "eye",
        title: asking.title,
        detail: asking.detail,
        options: [],
        defaultOption: null,
        questions: asking.questions,
      },
      {
        // Asked in the project's conversation too (ADR-045); answering there answers the item.
        opened: (id) =>
          conversationAsks(
            `“${task.title}” keeps going wrong on ${leg.legName}: ${drift.evidence}. What should I do?`,
            asking.questions,
            id,
          ),
        // The session is closed: nothing to watch for a stall meanwhile.
        waits: false,
        throwOnStop: true,
      },
    )) as { itemId: string; answer: string };
    const answered = d.inbox.get(itemId);
    const choice = readKeepsGoingWrong(text, answered?.answers ?? null);
    // My choices, not the model's failures (bug 11).
    if (choice.kind === "mine") throw new EndAttempt({ kind: "owner-held" }, false, true);
    if (choice.kind === "leave-out")
      throw new EndAttempt({ kind: "skipped", dependents: choice.dependents }, false, true);
    if (choice.kind === "stop")
      throw new EndAttempt(
        {
          kind: "cancel-job",
          reason: `Stopped by me after "${task.title}" kept going wrong; the work so far stays on its branch.`,
        },
        false,
        true,
      );
    if (choice.advice) {
      d.silk.add({
        jobId: job.id,
        taskId,
        kind: "decision",
        title: `Guidance for ${task.title}`,
        body: choice.advice,
        authoredBy: "owner",
      });
    }
    d.db
      .update(tasks)
      .set({ stepUp: 0, escalation: 0, avoid: [] })
      .where(eq(tasks.id, taskId))
      .run();
    if (choice.kind === "another-leg") {
      giveToLeg(d.db, job.id, taskId, leg.legId, choice.legId);
      throw new EndAttempt(
        {
          kind: "retry",
          reason: choice.legId
            ? `given to ${d.registry.get(choice.legId)?.name ?? "another Leg"} by me`
            : "given to another Leg by me",
        },
        false,
        true,
      );
    }
    throw new EndAttempt(
      { kind: "retry", reason: choice.advice ? "retrying with my advice" : "retrying, as I asked" },
      false,
      true,
    );
  };

  /** Climbs one step of the ladder for the worst drift seen. `failure` is the last check's output, if it failed. */
  const escalate = async (drifts: Drift[], failure = "") => {
    const drift = [...drifts].sort(
      (a, b) => SEVERITY.indexOf(a.code) - SEVERITY.indexOf(b.code),
    )[0] as Drift;
    const next = nextEscalation(level, drift.code);
    level = next.level;
    escalations.push(`${drift.code}:${next.step}`);
    d.db.update(tasks).set({ escalation: level }).where(eq(tasks.id, taskId)).run();
    event("task.drift", { code: drift.code, evidence: drift.evidence, step: next.step, level });
    // Detections are consumed: the same evidence doesn't trigger twice (Audit 1 → Q1-01).
    observed.forbidden = [];
    observed.gateBypass = [];
    observed.falseClaim = null;
    observed.commands = [];
    observed.verifyFailures = [];
    tokensBaseline = sessionTokens;
    observed.tokensSinceProgress = 0;
    observed.lastActivityAt = now();

    // Edits outside the task's scope are put back whatever the step: left
    // there, the next attempt starts out of scope and trips D1 again.
    if (drift.code === "D1") {
      const outside = (await ws.tree.changedSince(scopeBase)).filter(
        (p) => !inTaskScope(p, scopeOf(task)),
      );
      ws.tree.restorePaths(scopeBase, outside, ws.trash);
    }
    switch (next.step) {
      case "correct": {
        await session?.session.send(
          `${correctivePrompt(drift, scopeOf(task), task.verify)}${failure ? `\n\n${failure}` : ""}`,
        );
        return;
      }
      case "reset":
        await handOff(true);
        await closeSession();
        await openSession(
          "Continue the task. The handoff above says where the last session stopped.",
        );
        return;
      case "step-up":
        await handOff(true);
        await closeSession();
        d.db
          .update(tasks)
          .set({ stepUp: task.stepUp + 1 })
          .where(eq(tasks.id, taskId))
          .run();
        throw new EndAttempt({ kind: "retry", reason: `stepping up after ${drift.code}` });
      case "reassign":
        await handOff(true);
        await closeSession();
        d.db
          .update(tasks)
          .set({ avoid: [...new Set([...task.avoid, leg.legModelId])] })
          .where(eq(tasks.id, taskId))
          .run();
        throw new EndAttempt({ kind: "retry", reason: `reassigning after ${drift.code}` });
      case "kill":
        await closeSession("kill");
        await ws.tree.rollback(ckpt, ws.trash);
        d.db
          .update(tasks)
          .set({ avoid: [...new Set([...task.avoid, leg.legModelId])] })
          .where(eq(tasks.id, taskId))
          .run();
        await handOff(false);
        throw new EndAttempt({ kind: "retry", reason: `killed after ${drift.code}` });
      case "ask":
        await closeSession();
        await ask(drift);
    }
  };

  const finish = (
    outcome: "succeeded" | "failed" | "reassigned" | "redirected" | "abandoned" | "unavailable",
    success: boolean,
    /** What came of it says something of the model: learned from (the ladder's trust). */
    learn = true,
  ) => {
    release();
    gate.withdrawAsked();
    d.db
      .update(attempts)
      .set({ endedAt: now(), outcome, escalations })
      .where(eq(attempts.id, attemptId))
      .run();
    const m = d.registry.model(leg.legModelId);
    // Its provider failing says nothing of what the model can do (M13.22).
    if (m && outcome !== "unavailable" && learn) {
      const stored = record(d.registry.storedProfile(m), task.kind as TaskKind, {
        success,
        tokens: observed.tokensSinceProgress,
        ms: now() - started,
        escalations: escalations.length,
      });
      d.registry.saveProfile(m.id, stored);
    }
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
    let turns = 0;
    for (;;) {
      if (!session) throw new Error("no session");
      const end = await nextTurnEnd(session, signal, d.stallCheckMs ?? 30_000, watch);
      if (!end) {
        // No turn end yet: look for a stall or burn. Waiting for me is neither.
        if (gate.waiting() > 0) {
          observed.lastActivityAt = now();
          continue;
        }
        const drifts = detect(observed, now(), DEFAULT_THRESHOLDS);
        if (drifts.length) await escalate(drifts);
        continue;
      }
      turns++;
      // What the Stop hook ran as it let this turn end, if it did: used once (bug 5).
      const ranAtStop = stopRun;
      stopRun = null;
      // The job's folder is still a worktree of the project, else put back and the attempt fails
      // (Jobs-and-Projects → Ending a job, after the piano job).
      const strayed = safeStrayed(ws.tree);
      if (strayed.length) {
        await closeSession("kill");
        const why = strayed.map((x) => x.problem).join("; ");
        let restored = true;
        try {
          ws.tree.putBack(ws.trash);
        } catch (error) {
          restored = false;
          event("task.folder-not-restored", {
            reason: error instanceof Error ? error.message : String(error),
          });
        }
        const reason = `The job's folder stopped belonging to the project: ${why}. ${
          restored
            ? "Oraknid put it back as a worktree of the project, its files kept, and the task starts again."
            : "Oraknid couldn't put it back."
        }`;
        event("task.folder-restored", { problems: strayed, restored });
        d.silk.add({
          jobId: job.id,
          taskId,
          kind: "issue",
          title: `Folder put back: ${task.title}`,
          body: `${reason} Never run git init, nor move, delete or edit a .git: Oraknid commits the work on the job's branch, and merges and pushes at the end.`,
          authoredBy: "eye",
        });
        d.db
          .update(tasks)
          .set({ avoid: [...new Set([...task.avoid, leg.legModelId])] })
          .where(eq(tasks.id, taskId))
          .run();
        finish("failed", false);
        if (!restored) return { kind: "blocked", reason, until: null };
        return { kind: "retry", reason };
      }
      if (end.reason === "rate-limited") {
        await handOff(false);
        await closeSession();
        // Its own words say until when: kept until then, never routed to before (ADR-052 §4).
        const limit = usageLimitOf(end.error, now());
        if (limit?.until) notTheTask(end.error);
        else markLimited();
        // A usage limit is the account's, not the task failing: not counted against it (M13.22).
        finish("unavailable", false);
        return { kind: "retry", reason: `${leg.legName} hit a usage limit` };
      }
      if (end.reason === "error") {
        await handOff(false);
        await closeSession();
        // Its provider failed, not the task (M13.22): the model (or the Leg) rests, a deprecated
        // model is replaced, a quota is kept until its reset (ADR-052 §4); the attempt isn't
        // counted against the task, and routing tries elsewhere next.
        const unusable = notTheTask(end.error);
        if (unusable) {
          finish("unavailable", false);
          return unusable;
        }
        d.db
          .update(tasks)
          .set({ avoid: [...new Set([...task.avoid, leg.legModelId])] })
          .where(eq(tasks.id, taskId))
          .run();
        finish("failed", false);
        return { kind: "retry", reason: `${leg.legName} failed: ${end.error ?? "unknown error"}` };
      }

      // Cut short before it finished (bug 14): not a turn to judge. Stopped by me or its job,
      // the stop goes on; otherwise it is told to go on where it was.
      if (end.reason === "interrupted") {
        if (signal.aborted) throw signal.reason;
        event("task.turn-interrupted", {});
        if (turns >= (d.maxTurns ?? 25)) {
          await escalate([{ code: "D6", evidence: `took ${turns} turns without finishing one` }]);
          continue;
        }
        await session?.session.send(
          "Your last turn was interrupted before it finished. Go on with the task where you were; say DONE when it is finished.",
        );
        continue;
      }
      /** Stopped at its own limit of steps in a turn (bug 14): checked, its words not a claim. */
      const cutShort = end.reason === "max_turns";
      if (cutShort) event("task.turn-limit", {});

      // A turn went through: its provider works (M13.22).
      d.registry.providerWorked(leg.legId, leg.legModelId);

      // My messages to The Eye for the work now (Talking to The Eye) go on before any check.
      const told = takeGuidance(job.id, guidanceSeen);
      if (told.text && session) {
        guidanceSeen = told.mark;
        event("task.guided", {});
        await session.session.send(told.text);
        continue;
      }

      observed.changedPaths = await ws.tree.changedSince(scopeBase);
      observed.scope = scopeOf(task);
      let verified = task.verify.length === 0 && !cutShort;
      let failure =
        cutShort && !task.verify.length
          ? "Its turn reached its limit of steps before it finished."
          : "";
      if (task.verify.length) {
        event("task.verifying", {});
        // A check that is wrong is The Eye's to fix, not the Leg's (The-Eye → A check that is
        // wrong); so is one the agent shows is broken (ADR-052 §2).
        // Run once per turn end: what the Stop hook just ran on this same work stands (bug 5).
        const same =
          ranAtStop &&
          ranAtStop.verify.join("\n") === task.verify.join("\n") &&
          ranAtStop.tree === (await treeState());
        const results = await repairBroken(
          same ? ranAtStop.results : await runChecks(),
          end.text,
          () => runChecks(),
        );
        const failed = results.find((r) => !r.ok);
        verified = !failed;
        event("task.verified", {
          ok: verified,
          results: results.map((r) => ({ command: r.command, ok: r.ok, exitCode: r.exitCode })),
        });
        if (failed) {
          failure = `${fence(failed.command)}\nfailed (exit ${failed.exitCode}):\n${fence(failed.output.slice(-3000))}`;
          observed.verifyFailures.push(failed.signature ?? "");
          if (claimsDone(end.text) && !cutShort)
            observed.falseClaim = `said it was done, but \`${failed.command}\` failed`;
          // It says it can't finish without me (a guard blocked it, only I can do or allow it):
          // that is asked, specifically, before any ladder or "keeps going wrong" (ADR-053). So is
          // being stuck on its own auto mode's refusals with nothing after them (bug 7).
          const byLeg = gate.takeStuck();
          const said = cutShort
            ? null
            : (saysOwnerNeeded(end.text) ??
              (byLeg ? `${byLeg.why} by its own auto mode: “${end.text.slice(0, 300)}”` : null));
          if (said && (await askOwnerNeeded(said, end.text, failed))) continue;
        }
      }

      // No verify command (research, plan): a second reasoning look decides (The-Eye → Planning).
      if (!task.verify.length && d.brain && !cutShort) {
        event("task.evaluating", {});
        try {
          const review = await d.brain.evaluate({
            jobId: job.id,
            cwd: ws.cwd,
            task: { title: task.title, instructions: task.instructions, kind: task.kind },
            report: end.text,
            changes: await ws.tree.diffStatSince(ckpt),
            ...(job.skillChecks ? { criteria: job.skillChecks } : {}),
          });
          verified = review.accepted;
          event("task.evaluated", { accepted: review.accepted, reason: review.reason });
          if (!review.accepted) {
            failure = `The Eye reviewed the work: ${review.reason}${review.missing.length ? `\nStill missing:\n${review.missing.map((m) => `- ${m}`).join("\n")}` : ""}`;
            observed.verifyFailures.push(`evaluate:${review.missing.join("|") || review.reason}`);
            if (claimsDone(end.text))
              observed.falseClaim = "said it was done, but the review found work missing";
          }
        } catch (error) {
          // I stopped The Eye's thinking (M13.25): the job pauses here, to review it on resume.
          if (error instanceof BrainStopped) throw error;
          // No Leg could review it: accepted as before, and said so.
          event("task.evaluated", {
            accepted: true,
            reason: `not reviewed: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }

      const drifts = detect(observed, now(), DEFAULT_THRESHOLDS);
      if (verified && !drifts.some((x) => x.code === "D1")) {
        await closeSession();
        // One commit per repo the task changed, each with its own message (ADR-042).
        const subject = `${task.title.charAt(0).toLowerCase()}${task.title.slice(1)}`;
        const made = await ws.tree.commit((repo, several) =>
          several && repo
            ? `${PREFIX[task.kind as TaskKind]}(${repo}): ${subject}`
            : `${PREFIX[task.kind as TaskKind]}: ${subject}`,
        );
        const commit = made[0]?.sha ?? null;
        const said = ws.tree.several
          ? made.length
            ? ` ${made.length === 1 ? "Commit" : "Commits"} ${made.map((c) => `${c.repo} ${c.sha.slice(0, 10)}`).join(", ")}.`
            : ""
          : commit
            ? ` Commit ${commit.slice(0, 10)}.`
            : "";
        d.silk.add({
          jobId: job.id,
          taskId,
          kind: "progress",
          title: `Done: ${task.title}`,
          body: `${task.verify.length ? `Verified by ${task.verify.map((v) => `\`${v}\``).join(", ")}` : "No verify command (a planning task)"} on ${leg.legName} · ${leg.model}${pick.effort ? ` (${pick.effort})` : ""}.${said}\n\n${(await ws.tree.diffStatSince(ckpt)).trim() || "No file changes."}`,
          authoredBy: "eye",
        });
        d.db.update(tasks).set({ escalation: 0 }).where(eq(tasks.id, taskId)).run();
        finish("succeeded", true);
        return {
          kind: "done",
          commit,
          commits: ws.tree.several ? made.map((c) => ({ repo: c.repo as string, sha: c.sha })) : [],
        };
      }
      // The ladder (ADR-052 §3): the work isn't done after the agent ended its turn (its checks
      // fail, the review says it's wrong): one failure moves it up a rung at once, with a
      // handoff, while a stronger model is allowed. Precedence (ADR-056 stage 1, bug 13):
      // security and scope first — a forbidden action (D7), a refused gate tried again (D8),
      // edits outside the task's scope (D1) are the drift ladder's, which puts the scope back
      // before anyone works on; then the climb on a failed check; then the other drifts
      // (D2–D6), whose ladder runs where there is no rung left to climb.
      const first = drifts.some((x) => x.code === "D7" || x.code === "D8" || x.code === "D1");
      // A turn cut at its limit of steps isn't its answer: it goes on in its session first.
      if (!verified && !first && !cutShort) {
        const up = higherRung();
        if (up) {
          event("task.climbing", {
            from: `${leg.legName} · ${leg.model}`,
            to: `${up.candidate.legName} · ${up.candidate.model}`,
            work,
          });
          await handOff(false, failure);
          await closeSession();
          task.avoid = [...new Set([...task.avoid, leg.legModelId])];
          d.db.update(tasks).set({ avoid: task.avoid }).where(eq(tasks.id, taskId)).run();
          finish("failed", false);
          return {
            kind: "retry",
            reason: `${leg.legName} · ${leg.model} didn't get it done; it climbs to ${up.candidate.legName} · ${up.candidate.model}`,
          };
        }
      }
      if (drifts.length) {
        await escalate(drifts, failure);
        continue;
      }
      if (turns >= (d.maxTurns ?? 25)) {
        await escalate([
          { code: "D6", evidence: `took ${turns} turns without passing verification` },
        ]);
        continue;
      }
      // Self-prompting (The-Eye → Self-prompting): the exact failure goes back.
      await session?.session.send(
        cutShort
          ? `Your turn reached its limit of steps before you finished.${task.verify.length ? ` Oraknid ran the checks and the task is not done yet:\n${failure}\n` : " "}Go on with the task, then say DONE.`
          : `Oraknid ran the checks and the task is not done yet.\n${failure}\nFix it, then say DONE.`,
      );
      if (shouldRotate(usage, d.rotateAt ?? 0.6)) {
        event("task.rotating", {
          contextTokens: usage?.contextTokens,
          contextWindow: usage?.contextWindow,
        });
        // The turn being finished is watched like any other (Audit 1 → Q1-23).
        await nextTurnEnd(session as Supervised, signal, 600_000, watch);
        await handOff(true);
        await closeSession();
        await openSession(
          "Continue the task. The handoff above says where the last session stopped. Say DONE when it is finished.",
        );
      }
    }
  } catch (error) {
    if (error instanceof EndAttempt) {
      finish(
        error.unavailable
          ? "unavailable"
          : error.outcome.kind === "retry"
            ? // My "try again": redirected by me, not a failure spending the task's attempts.
              error.byOwner
              ? "redirected"
              : "reassigned"
            : "abandoned",
        false,
        // What I chose (skip it, take it over, stop, try again) says nothing of the model.
        !error.byOwner,
      );
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
    finish("abandoned", false, !signal.aborted);
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

function shouldRotate(u: UsageSnapshot | null, at: number): boolean {
  return !!u?.contextTokens && !!u.contextWindow && u.contextTokens > u.contextWindow * at;
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

const inTaskScope = (path: string, scope: string[]) => oraknidOwn(path) || inScope(path, scope);

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
