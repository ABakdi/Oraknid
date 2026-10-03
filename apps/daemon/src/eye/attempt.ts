import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Autonomy, Budget, Difficulty, MetricsSample, TaskKind } from "@oraknid/contracts";
import {
  allowRuleFor,
  buildContextPack,
  busyMachine,
  claimsDone,
  correctivePrompt,
  DEFAULT_THRESHOLDS,
  type Drift,
  type DriftCode,
  decide,
  detect,
  fence,
  type GatedAction,
  guidanceFromOthers,
  HANDOFF_REQUEST,
  inScope,
  nextEscalation,
  type Observed,
  type PolicyVerdict,
  type RouteCandidate,
  record,
  route,
  skillExcerpt,
} from "@oraknid/core";
import type {
  LegEvent,
  PermissionDecision,
  PermissionRequest,
  UsageSnapshot,
} from "@oraknid/leg-sdk";
import type { Sandbox } from "@oraknid/os";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/open.ts";
import { attempts, jobs, sessions, tasks } from "../db/schema.ts";
import { SideEffects } from "../engine/effects.ts";
import type { EventBus } from "../events/bus.ts";
import { newId } from "../ids.ts";
import type { InboxStore } from "../inbox/store.ts";
import { sandboxPlan } from "../legs/plan.ts";
import type { LegRegistry } from "../legs/registry.ts";
import type { LegSupervisor, Supervised } from "../legs/supervisor.ts";
import type { Servers } from "../servers/service.ts";
import { readSetting } from "../settings.ts";
import { handoffFromLog } from "../silk/handoff.ts";
import type { SilkStore } from "../silk/store.ts";
import type { BrokerSession, McpBroker } from "../tools/broker.ts";
import {
  BUILT_IN,
  type McpDeclaration,
  type ToolRegistry,
  type ToolRow,
} from "../tools/registry.ts";
import {
  changedSince,
  checkpoint,
  commitAll,
  diffStatSince,
  type Git,
  hasRef,
  restorePaths,
  rollback,
} from "../workspace/git.ts";
import { githubLinkOf } from "../workspace/github-tool.ts";
import { waitForAnswer } from "./approvals.ts";
import type { CheckRepair, EyeBrain } from "./brain.ts";

/** The providers (Leg kinds) for which I allowed same-provider fallback (ADR-009). */
export const SAME_PROVIDER_FALLBACK = "fallback.sameProvider";

import { approveAllLikeThis, policyFor } from "./policy.ts";

/** The third answer to a Leg's permission request (Approvals → The inbox). */
export const ALL_LIKE_THIS = "Approve all like this for this job";

import { summarizeShortened } from "../silk/summarize.ts";
import { guidanceMark, takeGuidance } from "./talk.ts";
import { looksBroken, runVerify, verifyRefusal } from "./verify.ts";

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
  /** Auto approval (ADR-014); without one, a classify verdict asks me. */
  brain?: EyeBrain;
  /** Tools for skills (ADR-021): the job's MCP servers, run by the daemon. */
  tools?: { registry: ToolRegistry; broker: McpBroker };
  /** The outbox: a tool's sends happen at most once (BR-6). */
  effects?: SideEffects;
  /** My servers, for a job whose project has some (ADR-026). */
  servers?: Servers;
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
  /** Its project's ports on this computer its sandboxes may reach (Sandboxing → network). */
  localPorts?: number[];
  /** The project's other skills, whose guidance a task may get (Skills → Skills per project). */
  otherSkills?: { name: string; body: string }[];
  /** The job's inputs, rendered for context packs. */
  inputs: string;
}

export type AttemptOutcome =
  | { kind: "done"; commit: string | null }
  | { kind: "retry"; reason: string }
  | { kind: "blocked"; reason: string; until: number | null }
  | { kind: "skipped" }
  | { kind: "owner-held" }
  | { kind: "cancel-job"; reason: string };

/** Ladder steps that end the attempt, and why. */
class EndAttempt extends Error {
  constructor(readonly outcome: AttemptOutcome) {
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
  ws: { cwd: string; g: Git; tmpDir: string; trash: string },
  attemptNo: number,
  signal: AbortSignal,
): Promise<AttemptOutcome> {
  const task = d.db.select().from(tasks).where(eq(tasks.id, taskId)).get() as TaskRow;
  const now = d.now;

  // ── Route ───────────────────────────────────────────────────────
  // ADR-009: after a usage limit, another account of the same provider is not a fallback unless I allowed it.
  const sameProvider = new Set(readSetting(d.db, SAME_PROVIDER_FALLBACK, z.array(z.string()), []));
  // Entries are "kind:legId": the account that hit the limit may come back after its reset; others may not.
  const limited = task.limitedKinds
    .map((e) => e.split(":") as [string, string])
    .filter(([k]) => !sameProvider.has(k));
  const blockedKinds = new Set(limited.map(([k]) => k));
  const limitedLegs = new Set(limited.map(([, id]) => id));
  const all = candidatesFor(d.registry, job.allowedLegIds);
  const candidates = all.filter(
    (c) => !blockedKinds.has(d.registry.require(c.legId).kind) || limitedLegs.has(c.legId),
  );
  const heldBack = all.length - candidates.length;
  // Read now, so a budget I changed while the job runs applies to the next task.
  const quotaShare =
    (
      d.db.select({ budget: jobs.budget }).from(jobs).where(eq(jobs.id, job.id)).get()?.budget as
        | Budget
        | undefined
    )?.quotaShare ?? null;
  const estimatedTokens = 20_000 + Math.ceil(task.instructions.length / 4);
  const routeTask = {
    kind: task.kind as TaskKind,
    difficulty: task.difficulty as Difficulty,
    requiredCapabilities: task.requiredCapabilities as never,
    estimatedTokens,
    stepUp: task.stepUp,
    pinnedModelId: task.pinnedModelId,
    avoid: task.avoid,
  };
  const routeOptions = { moneyAllowed: job.moneyAllowed, quotaShare };
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
  let routed = route(routeTask, candidates.filter(free), routeOptions);
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
    routed = route(routeTask, candidates.filter(free), routeOptions);
  }
  const pick = routed.ranked[0];
  if (!pick) {
    // The earliest reset that frees a Leg: a used-up window, or one past this job's quota share.
    const share = quotaShare?.hard ? quotaShare.limit : null;
    const until = [
      ...d.registry.all().map((l) => l.limitedUntil),
      ...(share === null
        ? []
        : candidates.flatMap((c) =>
            c.windows.filter((w) => (w.utilization ?? 0) >= share).map((w) => w.resetsAt),
          )),
    ]
      .filter((t): t is number => !!t && t > now())
      .sort((a, b) => a - b)[0];
    const resets = until ? ` until ${new Date(until).toISOString()}` : "";
    return {
      kind: "blocked",
      reason: heldBack
        ? `"${task.title}" hit a usage limit on ${[...blockedKinds].join(", ")}; other accounts of the same provider are not used as fallback (ADR-009). It waits${resets}, for another provider, or for my setting.`
        : until
          ? `All allowed Legs are out of quota${resets}${routed.excluded.length ? `: ${routed.excluded.map((e) => e.why).join(" ")}` : "."}`
          : `No Leg can take "${task.title}": ${routed.excluded.map((e) => e.why).join(" ") || "there are no Legs."}`,
      until: until ?? null,
    };
  }
  const leg = pick.candidate;
  // Held from now until the attempt ends, whichever way.
  const release = d.supervisor.hold(leg.legId);
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
    await checkpoint(ws.g, ckpt, `oraknid: before ${task.title} (attempt ${attemptNo})`, ws.tmpDir);
    if (!hasRef(ws.g, scopeBase))
      await checkpoint(ws.g, scopeBase, `oraknid: before ${task.title}`, ws.tmpDir);
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

  const escalations: string[] = [];
  const started = now();
  /** Tokens of the current session when progress was last made or a drift was acted on (D6 counts from here). */
  let tokensBaseline = 0;
  let sessionTokens = 0;
  /** Waiting for my answer is not a stall (Audit 1 → Q1-02). */
  let waitingOnOwner = 0;
  let level = task.escalation;
  // Only messages written after this attempt began: older ones are in Silk, in its context pack.
  let guidanceSeen = guidanceAtStart;
  // Typed by assertion: they change inside closures, which narrowing cannot follow.
  let session = null as Supervised | null;
  let sessionLog: string | null = null;
  const deniedGates = new Set<string>();
  /** Approvals this attempt asked for: withdrawn if it ends before I answer. */
  const asked: string[] = [];
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
    if (e.type === "usage") {
      sessionTokens = e.usage.inputTokens + e.usage.outputTokens;
      observed.tokensSinceProgress = Math.max(0, sessionTokens - tokensBaseline);
      usage = e.usage;
    }
  };

  let usage = null as UsageSnapshot | null;

  const observed: Observed = {
    scope: task.scope,
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

  /** This attempt read something from the web: untrusted from here on (BR-15; Audit 1 → S1-09). */
  let readTheWeb = false;
  const toolRows = d.tools && job.tools.length ? d.tools.registry.byNames(job.tools) : [];
  const brokered = toolRows.map((t) => `oraknid-${t.name}`);
  const onPermission = async (
    r: PermissionRequest,
    /** What Oraknid's own tool made of this very call (ADR-038). */
    judged?: McpDeclaration,
  ): Promise<PermissionDecision> => {
    // The broker judges every call to a job's tool: the Leg's own ask for it passes (ADR-021).
    if (isBrokered(r.tool, brokered)) return { allow: true };
    const policy = policyFor(d.db, job.id, ws.cwd);
    if (readTheWeb) policy.untrusted = true;
    if (toolRows.length) {
      const declared = d.tools?.registry.declarations(toolRows) ?? new Map();
      if (judged) declared.set(r.tool, judged);
      policy.mcp = declared;
    }
    const first = decide(r, policy);
    const fetches =
      r.tool === "WebFetch" ||
      r.tool === "WebSearch" ||
      (r.command ? /\b(curl|wget)\b/.test(r.command) : false);
    if (fetches && first.verdict !== "deny" && !readTheWeb) {
      readTheWeb = true;
      event("task.untrusted", {
        reason: `read from the web (${r.tool}): gated actions ask me from now on`,
      });
    }
    const v =
      first.verdict === "classify"
        ? await classify(d, job.id, ws.cwd, task.title, r, first)
        : first;
    if (v.verdict === "allow") return { allow: true };
    if (v.verdict === "deny") {
      observed.forbidden.push(`tried \`${r.command ?? r.tool}\` (${v.reason})`);
      return { allow: false, message: `Not allowed: ${v.reason}.` };
    }
    // Asked once; trying the same refused action again is a gate bypass attempt (D8).
    const key = `${r.tool}:${r.command ?? r.path}`;
    if (deniedGates.has(key)) {
      observed.gateBypass.push(`tried \`${r.command ?? r.tool}\` again after I refused it`);
      return { allow: false, message: "I already refused that." };
    }
    const itemId = d.inbox.open({
      kind: "approval",
      jobId: job.id,
      taskId,
      raisedBy: { legId: leg.legId },
      title: `${leg.legName} wants to ${r.command ? `run \`${r.command.slice(0, 80)}\`` : `use ${r.tool}`}`,
      detail: `Task: ${task.title}\nWhy it asks: ${v.reason}.\n\n${r.command ? fence(r.command) : fence(JSON.stringify(r.input, null, 2), "json")}`,
      options: ["Approve", "Deny", ALL_LIKE_THIS],
      defaultOption: null,
    });
    asked.push(itemId);
    event("task.waiting", { itemId, reason: v.reason });
    let answer: string;
    waitingOnOwner++;
    try {
      answer = await waitForAnswer(d.inbox, d.bus, itemId, signal);
    } catch {
      // Paused or stopped while waiting: a permission hook always answers; the attempt stops anyway.
      return { allow: false, message: "Oraknid is pausing this session." };
    } finally {
      waitingOnOwner--;
    }
    observed.lastActivityAt = now();
    if (answer === ALL_LIKE_THIS) {
      approveAllLikeThis(
        d.db,
        d.bus,
        job.id,
        v.gated ? { gated: v.gated } : { allowRule: allowRuleFor(r.command ?? r.tool) },
      );
      return { allow: true };
    }
    if (answer === "Approve") return { allow: true };
    deniedGates.add(key);
    return { allow: false, message: "I denied it. Find another way, or say what you need." };
  };

  const pack = (): string => {
    const window = leg.profile.contextWindow ?? 200_000;
    const built = buildContextPack({
      task: {
        id: task.id,
        title: task.title,
        instructions: task.instructions,
        scope: task.scope,
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
    return [built.text, serversText, githubText()].filter(Boolean).join("\n\n");
  };

  /** How this job does GitHub work: through Oraknid's github tool, never a CLI or a token (ADR-038). */
  const githubText = () => {
    if (!toolRows.some((t) => t.name === "github" && t.command === BUILT_IN)) return "";
    const link = githubLinkOf(d.db, job.id);
    const where = link
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
          const v = await onPermission(
            {
              tool: `mcp__${tool.name}__${name}`,
              input: args,
              command: null,
              path: null,
            },
            judged,
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
          if (o.allowed && tool.untrusted && !readTheWeb) {
            readTheWeb = true;
            event("task.untrusted", {
              reason: `read from ${tool.name} (${name}): gated actions ask me from now on`,
            });
          }
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
    // The Leg's home outlives this job: keys another job left there go first,
    // so a job reaches only its own project's servers (Audit 2).
    const ssh = join(d.legsDir, leg.legId, "home", ".ssh");
    rmSync(ssh, { recursive: true, force: true });
    if (!d.servers || !job.serverIds?.length) return;
    mkdirSync(ssh, { recursive: true, mode: 0o700 });
    const config: string[] = [];
    const known: string[] = [];
    const docs: string[] = [];
    for (const id of job.serverIds) {
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
        docs.push(`## ${s.name} — \`ssh ${s.alias}\`\n\n${s.state}`);
      } catch (error) {
        docs.push(
          `## (a server this job can't reach: ${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }
    writeFileSync(join(ssh, "config"), `${config.join("\n\n")}\n`, { mode: 0o600 });
    writeFileSync(join(ssh, "oraknid_known_hosts"), `${known.join("\n")}\n`, { mode: 0o600 });
    serversText = `# Servers this job may use\n\nReach each with its alias (\`ssh <alias>\`, \`scp\`, \`rsync\`). Read its state document first: it says what runs there and what must not break. Change only what the task needs; anything else on the server is not yours.\n\n${docs.join("\n\n")}`;
  };

  const openSession = async (prompt: string) => {
    await prepareServers();
    observed.lastActivityAt = now();
    const tools = await openTools();
    // A new session counts its tokens from zero.
    sessionTokens = 0;
    tokensBaseline = 0;
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
      unsandboxed: job.unsandboxed,
      localPorts: job.localPorts ?? [],
      onPermission,
      ...(tools ? { tools } : {}),
    });
    const row = d.db
      .select({ logFile: sessions.logFile })
      .from(sessions)
      .where(eq(sessions.id, session.id))
      .get();
    sessionLog = row?.logFile ?? null;
    return session;
  };

  /** Writes a handoff to Silk: asked of the Leg when it can still answer, rebuilt from its log otherwise. */
  const handOff = async (askLeg: boolean) => {
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
      body,
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

  const ask = async (drift: Drift): Promise<never> => {
    const itemId = d.inbox.open({
      kind: "question",
      jobId: job.id,
      taskId,
      raisedBy: "eye",
      title: `"${task.title}" keeps going wrong`,
      detail: `${leg.legName} · ${leg.model}: ${drift.evidence}.\nEscalations so far: ${escalations.join(", ") || "none"}.\nAnswer with guidance to retry, or choose another option.`,
      options: ["Retry", "Take it over", "Skip it", "Cancel the job"],
      defaultOption: "Retry",
    });
    // Withdrawn if the attempt stops before I answer (Audit 1 → D1-07).
    asked.push(itemId);
    const answer = await waitForAnswer(d.inbox, d.bus, itemId, signal);
    if (answer === "Take it over") throw new EndAttempt({ kind: "owner-held" });
    if (answer === "Skip it") throw new EndAttempt({ kind: "skipped" });
    if (answer === "Cancel the job")
      throw new EndAttempt({
        kind: "cancel-job",
        reason: `Cancelled by me after "${task.title}" kept going wrong.`,
      });
    if (answer !== "Retry") {
      d.silk.add({
        jobId: job.id,
        taskId,
        kind: "decision",
        title: `Guidance for ${task.title}`,
        body: answer,
        authoredBy: "owner",
      });
    }
    d.db
      .update(tasks)
      .set({ stepUp: 0, escalation: 0, avoid: [] })
      .where(eq(tasks.id, taskId))
      .run();
    throw new EndAttempt({ kind: "retry", reason: "retrying with my guidance" });
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

    switch (next.step) {
      case "correct": {
        if (drift.code === "D1") {
          const outside = (await changedSince(ws.g, scopeBase, ws.tmpDir)).filter(
            (p) => !inTaskScope(p, task.scope),
          );
          restorePaths(ws.g, scopeBase, outside, ws.trash);
        }
        await session?.session.send(
          `${correctivePrompt(drift, task.scope, task.verify)}${failure ? `\n\n${failure}` : ""}`,
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
        await rollback(ws.g, ckpt, ws.tmpDir, ws.trash);
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
    outcome: "succeeded" | "failed" | "reassigned" | "abandoned",
    success: boolean,
  ) => {
    release();
    for (const id of asked) d.inbox.withdraw(id);
    d.db
      .update(attempts)
      .set({ endedAt: now(), outcome, escalations })
      .where(eq(attempts.id, attemptId))
      .run();
    const m = d.registry.model(leg.legModelId);
    if (m) {
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
    const handoff = d.silk.current(job.id).some((e) => e.kind === "handoff" && e.taskId === taskId);
    await openSession(
      handoff
        ? "Continue the task. The handoff above says where the last session stopped. Say DONE when it is finished."
        : "Do the task described above. When it is finished, say DONE and summarise what you changed.",
    );
    let turns = 0;
    for (;;) {
      if (!session) throw new Error("no session");
      const end = await nextTurnEnd(session, signal, d.stallCheckMs ?? 30_000, watch);
      if (!end) {
        // No turn end yet: look for a stall or burn. Waiting for me is neither.
        if (waitingOnOwner > 0) {
          observed.lastActivityAt = now();
          continue;
        }
        const drifts = detect(observed, now(), DEFAULT_THRESHOLDS);
        if (drifts.length) await escalate(drifts);
        continue;
      }
      turns++;
      if (end.reason === "rate-limited") {
        await handOff(false);
        await closeSession();
        d.db
          .update(tasks)
          .set({
            avoid: [...new Set([...task.avoid, leg.legModelId])],
            limitedKinds: [
              ...new Set([
                ...task.limitedKinds,
                `${d.registry.require(leg.legId).kind}:${leg.legId}`,
              ]),
            ],
          })
          .where(eq(tasks.id, taskId))
          .run();
        finish("reassigned", false);
        return { kind: "retry", reason: `${leg.legName} hit a usage limit` };
      }
      if (end.reason === "error") {
        await handOff(false);
        await closeSession();
        d.db
          .update(tasks)
          .set({ avoid: [...new Set([...task.avoid, leg.legModelId])] })
          .where(eq(tasks.id, taskId))
          .run();
        finish("failed", false);
        return { kind: "retry", reason: `${leg.legName} failed: ${end.error ?? "unknown error"}` };
      }

      // My messages to The Eye for the work now (Talking to The Eye) go on before any check.
      const told = takeGuidance(job.id, guidanceSeen);
      if (told.text && session) {
        guidanceSeen = told.mark;
        event("task.guided", {});
        await session.session.send(told.text);
        continue;
      }

      observed.changedPaths = await changedSince(ws.g, scopeBase, ws.tmpDir);
      let verified = task.verify.length === 0;
      let failure = "";
      if (task.verify.length) {
        event("task.verifying", {});
        const plan = job.unsandboxed
          ? null
          : sandboxPlan(d.registry.require(leg.legId), d.sandbox, d.legsDir, job.localPorts ?? []);
        const check = () =>
          runVerify(task.verify, ws.cwd, plan, {
            signal,
            refuse: (command) =>
              verifyRefusal(
                decide({ tool: "Bash", command, path: null }, policyFor(d.db, job.id, ws.cwd)),
              ),
          });
        let results = await check();
        // A check that is wrong is The Eye's to fix, not the Leg's (The-Eye → A check that is wrong).
        for (let repairs = 0; repairs < 2 && d.brain; repairs++) {
          const bad = results.find((r) => !r.ok);
          const hint = bad ? looksBroken(bad) : null;
          if (!bad || !hint) break;
          let repair: CheckRepair;
          try {
            repair = await d.brain.repairCheck({
              jobId: job.id,
              cwd: ws.cwd,
              task: { title: task.title, instructions: task.instructions },
              command: bad.command,
              output: bad.output,
              hint,
              report: end.text,
            });
          } catch {
            break;
          }
          event("task.check-reviewed", {
            command: bad.command,
            broken: repair.broken,
            replacement: repair.broken ? repair.command : null,
            reason: repair.reason,
          });
          if (!repair.broken) break;
          task.verify = task.verify.map((v) => (v === bad.command ? repair.command : v));
          d.db.update(tasks).set({ verify: task.verify }).where(eq(tasks.id, taskId)).run();
          d.silk.add({
            jobId: job.id,
            taskId,
            kind: "decision",
            title: `Check corrected: ${task.title}`,
            body: `\`${bad.command}\` was wrong (${repair.reason}). It is now \`${repair.command}\`.`,
            authoredBy: "eye",
          });
          results = await check();
        }
        const failed = results.find((r) => !r.ok);
        verified = !failed;
        event("task.verified", {
          ok: verified,
          results: results.map((r) => ({ command: r.command, ok: r.ok, exitCode: r.exitCode })),
        });
        if (failed) {
          failure = `${fence(failed.command)}\nfailed (exit ${failed.exitCode}):\n${fence(failed.output.slice(-3000))}`;
          observed.verifyFailures.push(failed.signature ?? "");
          if (claimsDone(end.text))
            observed.falseClaim = `said it was done, but \`${failed.command}\` failed`;
        }
      }

      // No verify command (research, plan): a second reasoning look decides (The-Eye → Planning).
      if (!task.verify.length && d.brain) {
        event("task.evaluating", {});
        try {
          const review = await d.brain.evaluate({
            jobId: job.id,
            cwd: ws.cwd,
            task: { title: task.title, instructions: task.instructions, kind: task.kind },
            report: end.text,
            changes: await diffStatSince(ws.g, ckpt, ws.tmpDir),
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
        const commit = await commitAll(
          ws.g,
          `${PREFIX[task.kind as TaskKind]}: ${task.title.charAt(0).toLowerCase()}${task.title.slice(1)}`,
        );
        d.silk.add({
          jobId: job.id,
          taskId,
          kind: "progress",
          title: `Done: ${task.title}`,
          body: `${task.verify.length ? `Verified by ${task.verify.map((v) => `\`${v}\``).join(", ")}` : "No verify command (a planning task)"} on ${leg.legName} · ${leg.model}${pick.effort ? ` (${pick.effort})` : ""}.${commit ? ` Commit ${commit.slice(0, 10)}.` : ""}\n\n${(await diffStatSince(ws.g, ckpt, ws.tmpDir)).trim() || "No file changes."}`,
          authoredBy: "eye",
        });
        d.db.update(tasks).set({ escalation: 0 }).where(eq(tasks.id, taskId)).run();
        finish("succeeded", true);
        return { kind: "done", commit };
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
        `Oraknid ran the checks and the task is not done yet.\n${failure}\nFix it, then say DONE.`,
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
      finish(error.outcome.kind === "retry" ? "reassigned" : "abandoned", false);
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
    finish("abandoned", false);
    // Nothing runs it any more: shown as ready at once, not "running" until the job resumes.
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
        payload: {
          taskId,
          to: "ready",
          reason: "Stopped at a safe point; it starts again on resume.",
        },
      });
    });
    throw error;
  } finally {
    toolsOpen?.close();
  }
}

/**
 * A Leg's name for a call to one of Oraknid's bridges: `mcp__<server>__<tool>`
 * (Claude Code) or `<server>_<tool>` (OpenCode, which may turn `-` into `_`).
 */
export function isBrokered(tool: string, servers: string[]): boolean {
  const norm = (x: string) => x.replace(/[^A-Za-z0-9_]/g, "_");
  const t = norm(tool);
  return servers.some((s) => t.startsWith(`mcp__${norm(s)}__`) || t.startsWith(`${norm(s)}_`));
}

/** A Leg's limit of task sessions at once: its own setting, else one (ADR-016). */
function legLimit(d: AttemptDeps, legId: string): number {
  const n = (d.registry.require(legId).config as { maxSessions?: unknown }).maxSessions;
  return typeof n === "number" && n >= 1 ? n : 1;
}

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
async function safeDiffStat(ws: { g: Git; tmpDir: string }, since: string): Promise<string> {
  try {
    return await diffStatSince(ws.g, since, ws.tmpDir);
  } catch {
    return "";
  }
}

/** A job that ended keeps nothing in memory here (Audit 1 → Q1-19). */
export function forgetJob(jobId: string) {
  verdicts.delete(jobId);
}

/** Per job, the classifier's "allow" for one exact command (ADR-014: cached; per command since Audit 1 → S1-07). */
const verdicts = new Map<string, Map<string, { decision: "allow" | "ask"; reason: string }>>();

async function classify(
  d: AttemptDeps,
  jobId: string,
  cwd: string,
  task: string,
  r: PermissionRequest,
  v: Extract<PolicyVerdict, { verdict: "classify" }>,
): Promise<Exclude<PolicyVerdict, { verdict: "classify" }>> {
  // The whole command, not its programs: allowing one `curl` must not allow every other.
  const key = (r.command ?? r.tool).trim().replace(/\s+/g, " ");
  const cache = verdicts.get(jobId) ?? new Map();
  verdicts.set(jobId, cache);
  let verdict = cache.get(key);
  let cached = true;
  if (!verdict) {
    cached = false;
    try {
      verdict = d.brain
        ? await d.brain.classifyCommand({
            jobId,
            cwd,
            task,
            command: r.command ?? r.tool,
            why: v.reason,
          })
        : { decision: "ask" as const, reason: "no classifier is available" };
    } catch (error) {
      // Fail safe: when nothing can judge, I'm asked.
      verdict = {
        decision: "ask",
        reason: `the classifier could not answer (${error instanceof Error ? error.message : String(error)})`,
      };
    }
    if (verdict.decision === "allow") cache.set(key, verdict);
  }
  d.bus.publish({
    type: "policy.auto",
    topic: `job:${jobId}`,
    jobId,
    payload: {
      command: (r.command ?? r.tool).slice(0, 300),
      programs: v.programs,
      decision: verdict.decision,
      reason: verdict.reason,
      cached,
    },
    actor: "eye",
  });
  return verdict.decision === "allow"
    ? { verdict: "allow", reason: `auto-approved: ${verdict.reason}` }
    : {
        verdict: "ask",
        reason: `${v.reason}, and the classifier says: ${verdict.reason}`,
        gated: null,
      };
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

const inTaskScope = (path: string, scope: string[]) =>
  path.startsWith(".oraknid/") || inScope(path, scope);

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
      });
    }
  }
  return out;
}
