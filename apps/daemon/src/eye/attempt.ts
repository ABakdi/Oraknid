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
  allowRuleFor,
  blockedMessage,
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
  programsOf,
  providerFailure,
  type RouteCandidate,
  record,
  route,
  skillExcerpt,
  taskScope,
} from "@oraknid/core";
import type {
  LegEvent,
  PermissionDecision,
  PermissionRequest,
  PreToolDecision,
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
import { jobHomeDir, scratchFor } from "../legs/job-home.ts";
import { sandboxPlan } from "../legs/plan.ts";
import type { LegRegistry } from "../legs/registry.ts";
import type { LegSupervisor, Supervised } from "../legs/supervisor.ts";
import { legSessionLimit } from "../resources/work.ts";
import { runServerCheck } from "../servers/checks.ts";
import { type JobServerRef, serverVerdict } from "../servers/remote.ts";
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
import type { GitHub } from "../workspace/github.ts";
import { githubLinkOf, githubLinksOf } from "../workspace/github-tool.ts";
import type { WorkTree } from "../workspace/tree.ts";
import { waitForAnswer } from "./approvals.ts";
import {
  type DecisionLayer,
  guardContext,
  judgeAction,
  layer1,
  logDecision,
  ownerWords,
  shapeApproved,
  shapeRuleFor,
  stuck,
} from "./auto-mode.ts";
import { BrainStopped, type CheckRepair, type EyeBrain } from "./brain.ts";
import { runBuiltinCheck } from "./builtin-checks.ts";
import { giveToLeg, LegStop, legLimits, stopWaiting, trackAttempt } from "./leg-work.ts";

/** The providers (Leg kinds) for which I allowed same-provider fallback (ADR-009). */
export const SAME_PROVIDER_FALLBACK = "fallback.sameProvider";

import { approveAllLikeThis, policyFor } from "./policy.ts";

/** The third answer to a Leg's permission request (Approvals → The inbox). */
export const ALL_LIKE_THIS = "Approve all like this for this job";
/** The answers when an agent is stuck on blocks (ADR-053). */
export const LET_IT_RUN = "Let it run this one";
export const KEEP_BLOCKED = "Keep it blocked";
/** Shell tools, whose command layer 1 reads (ADR-053). */
const SHELL_TOOLS = new Set(["Bash", "run_command"]);
/** Tools that only read: their allows aren't each in the audit log. */
const READS = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "read_file",
  "list_dir",
  "search",
  "TodoWrite",
]);

import { summarizeShortened } from "../silk/summarize.ts";
import { dependentsOf, keepsGoingWrong, readKeepsGoingWrong } from "./questions.ts";
import { addMessage, guidanceMark, takeGuidance } from "./talk.ts";
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
/** The address a fetch reads: OpenCode puts it as the request's path, Claude Code in its input. */
function fetchedUrl(r: { path: string | null; input: Record<string, unknown> }): string | null {
  const url = r.input.url;
  return typeof url === "string" ? url : r.path;
}

/**
 * A page of the project's own linked GitHub repo (its page, its API, its raw
 * files) isn't content from outside: reading it doesn't make the task
 * untrusted. Anything else on the web still does (BR-15). Seen 2026-10-04:
 * OpenCode looked at the piano repo's page and its push to that same repo
 * then asked me.
 */
export function ownRepoPage(
  url: string | null,
  repos: { github?: { owner: string; name: string } | null }[],
): boolean {
  if (!url) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const parts = u.pathname.split("/").filter(Boolean);
  const [owner, name] =
    u.hostname === "api.github.com" && parts[0] === "repos"
      ? [parts[1], parts[2]]
      : u.hostname === "github.com" || u.hostname === "raw.githubusercontent.com"
        ? [parts[0], parts[1]]
        : [undefined, undefined];
  if (!owner || !name) return false;
  const repo = name.replace(/\.git$/, "").toLowerCase();
  return repos.some(
    (r) =>
      r.github?.owner.toLowerCase() === owner.toLowerCase() && r.github.name.toLowerCase() === repo,
  );
}

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
    const resets = until ? ` until ${new Date(until).toISOString()}` : "";
    return {
      kind: "blocked",
      reason: heldBack
        ? `"${task.title}" hit a usage limit on ${[...blockedKinds].join(", ")}; other accounts of the same provider are not used as fallback (ADR-009). It waits${resets}, for another provider, or for my setting.`
        : until
          ? `All allowed Legs are ${candidates.some((c) => c.cooldown) ? "resting after provider failures or " : ""}out of quota${resets}${routed.excluded.length ? `: ${routed.excluded.map((e) => e.why).join(" ")}` : "."}`
          : `No Leg can take "${task.title}": ${routed.excluded.map((e) => e.why).join(" ") || "there are no Legs."}`,
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
    // Claude Code's own auto mode refused a call (ADR-053): in the job's events and the audit log.
    if (e.type === "permission.denied" && e.by === "leg") {
      const action = e.request.command ?? e.request.path ?? e.request.tool;
      logDecision(d.bus, job.id, {
        taskId,
        tool: e.request.tool,
        action,
        verdict: "block",
        layer: "leg",
        reason: e.reason,
      });
      event("task.refused", {
        command: action.slice(0, 300),
        reason: e.reason,
        drift: null,
        layer: "leg",
      });
    }
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

  /** This attempt read something from the web: untrusted from here on (BR-15; Audit 1 → S1-09). */
  let readTheWeb = false;
  const toolRows = d.tools && job.tools.length ? d.tools.registry.byNames(job.tools) : [];
  const brokered = toolRows.map((t) => `oraknid-${t.name}`);
  /** The stuck rule's key: blocks are counted per task (ADR-053). */
  const stuckKey = `${job.id}:${taskId}`;
  /** What layer 1 knows of this attempt: the folder, its scratch, the job's servers, the task. */
  const guardCtx = () =>
    guardContext({
      cwd: ws.cwd,
      scratch: scratchFor(d.legsDir, leg.legId, job.id),
      home: jobHomeDir(d.legsDir, leg.legId, job.id),
      servers: servers.map((s) => ({ alias: s.alias, name: s.name, production: s.production })),
      sshConfig: servers.length
        ? join(jobHomeDir(d.legsDir, leg.legId, job.id), ".ssh", "config")
        : null,
      taskText: [
        job.goal,
        task.title,
        task.instructions,
        ...(task.scope ?? []),
        ...ownerWords(d.db, job.id),
      ].join("\n"),
      verify: task.verify ?? [],
    });
  /** Layer 1: the rules' verdict on one request of the Leg, the guard's included (ADR-053). */
  const rulesVerdict = async (r: PermissionRequest, judged?: McpDeclaration) => {
    const policy = policyFor(d.db, job.id, ws.cwd);
    // Its own /tmp, this job's home and the Leg's tmp and cache are its scratch (M13.22).
    policy.scratch = scratchFor(d.legsDir, leg.legId, job.id);
    if (readTheWeb) policy.untrusted = true;
    if (toolRows.length) {
      const declared = d.tools?.registry.declarations(toolRows) ?? new Map();
      if (judged) declared.set(r.tool, judged);
      policy.mcp = declared;
    }
    // Layer 1: the guard reads the command as the shell does, before the policy (ADR-053).
    if (r.command && SHELL_TOOLS.has(r.tool)) policy.layer1 = await layer1(r.command, guardCtx());
    // A command on one of the job's servers is judged as what runs there; production asks (ADR-049).
    const first =
      (r.command && servers.length ? serverVerdict(r.command, servers, policy) : null) ??
      decide(r, policy);
    const fetches =
      (r.tool === "WebFetch" && !ownRepoPage(fetchedUrl(r), githubLinksOf(d.db, job.id))) ||
      r.tool === "WebSearch" ||
      (r.command ? /\b(curl|wget)\b/.test(r.command) : false);
    if (fetches && first.verdict !== "deny" && !readTheWeb) {
      readTheWeb = true;
      event("task.untrusted", {
        reason: `read from the web (${r.tool}): gated actions ask me from now on`,
      });
    }
    return { first, policy };
  };
  /** Layer 1, 2 or 3 settles one request of the Leg (ADR-053). */
  const judgeRequest = async (
    r: PermissionRequest,
    judged?: McpDeclaration,
  ): Promise<{ v: Exclude<PolicyVerdict, { verdict: "judge" }>; layer: DecisionLayer }> => {
    const { first, policy } = await rulesVerdict(r, judged);
    if (first.verdict !== "judge")
      return { v: first, layer: first.verdict === "ask" ? "owner" : "rules" };
    // Careful: a shape I approved for the job passes without the judge.
    const row = d.db
      .select({ allowRules: jobs.allowRules })
      .from(jobs)
      .where(eq(jobs.id, job.id))
      .get();
    if (
      policy.autonomy === "careful" &&
      r.command &&
      (await shapeApproved(r.command, row?.allowRules ?? []))
    )
      return {
        v: { verdict: "allow", reason: "a command like one I approved for this job" },
        layer: "owner",
      };
    // Layer 2: the judge, reasoning-blind.
    const verdict = await judgeAction(
      d.brain,
      {
        ownerMessages: ownerWords(d.db, job.id),
        goal: job.goal,
        task: task.title,
        scope: scopeOf(task),
        action: { tool: r.tool, command: r.command, input: r.command ? undefined : r.input },
        workspace: ws.cwd,
        servers: servers.map((s) => ({ name: s.name, alias: s.alias, production: s.production })),
        repos: githubLinksOf(d.db, job.id)
          .map((x) => (x.github ? `${x.github.owner}/${x.github.name}` : ""))
          .filter(Boolean),
        notes: {
          allow: (row?.allowRules ?? []).filter((x) => !x.startsWith("shape:")),
          deny: policy.rules?.flatMap((l) => l.deny) ?? [],
        },
        why: first.reason,
      },
      { jobId: job.id, taskId, cwd: ws.cwd },
    );
    d.bus.publish({
      type: "policy.judged",
      topic: `job:${job.id}`,
      jobId: job.id,
      payload: {
        taskId,
        action: (r.command ?? r.tool).slice(0, 300),
        decision: verdict.verdict,
        reason: verdict.reason,
        stage: verdict.stage,
        cached: verdict.cached,
        timedOut: verdict.verdict === "block" ? !!verdict.timedOut : false,
      },
      actor: "eye",
    });
    if (verdict.verdict === "block")
      return {
        v: {
          verdict: "deny",
          reason: verdict.reason,
          drift: null,
          message: blockedMessage(verdict.reason),
        },
        layer: "judge",
      };
    // Careful: what the judge allows and the rules didn't is mine to approve (the old behaviour).
    if (policy.autonomy === "careful")
      return {
        v: {
          verdict: "ask",
          reason: `${first.reason}; the judge would allow it, and at Careful I approve it`,
          gated: null,
        },
        layer: "owner",
      };
    return {
      v: { verdict: "allow", reason: `the judge allowed it: ${verdict.reason}` },
      layer: "judge",
    };
  };

  const onPermission = async (
    r: PermissionRequest,
    /** What Oraknid's own tool made of this very call (ADR-038). */
    judged?: McpDeclaration,
  ): Promise<PermissionDecision> => {
    // The broker judges every call to a job's tool: the Leg's own ask for it passes (ADR-021).
    if (isBrokered(r.tool, brokered)) return { allow: true };
    const { v, layer } = await judgeRequest(r, judged);
    const action = r.command ?? r.path ?? r.tool;
    // Every decision but a plain read is in the audit log, with its layer and reason (ADR-053).
    if (r.command || v.verdict !== "allow" || !READS.has(r.tool))
      logDecision(d.bus, job.id, {
        taskId,
        tool: r.tool,
        action,
        verdict: v.verdict === "deny" ? "block" : v.verdict,
        layer,
        reason: v.reason,
      });
    if (v.verdict === "allow") {
      stuck.allowed(stuckKey);
      return { allow: true, why: `${layer}: ${v.reason}` };
    }
    if (v.verdict === "deny") {
      // A forbidden action counts against the Leg (D7); Oraknid's own check is only answered.
      if (v.drift) observed.forbidden.push(`tried \`${r.command ?? r.tool}\` (${v.reason})`);
      event("task.refused", {
        command: (r.command ?? r.tool).slice(0, 300),
        reason: v.reason,
        drift: v.drift,
        layer,
      });
      const refused: PermissionDecision = {
        allow: false,
        message: v.message ?? `Not allowed: ${v.reason}.`,
        why: `${layer}: ${v.reason}`,
      };
      // Stuck on blocks (3 in a row, 20 in the task): The Eye asks me, with what was blocked and why.
      if (v.drift === null && layer !== "owner") {
        const stuckNow = stuck.blocked(stuckKey, {
          action: (r.command ?? r.tool).slice(0, 200),
          reason: v.reason,
          layer: layer === "judge" ? 2 : 1,
        });
        if (stuckNow) return askWhenStuck(r, stuckNow, refused);
      }
      return refused;
    }
    // Asked once; trying the same refused action again is a gate bypass attempt (D8).
    const key = `${r.tool}:${r.command ?? r.path}`;
    if (deniedGates.has(key)) {
      observed.gateBypass.push(`tried \`${r.command ?? r.tool}\` again after I refused it`);
      return { allow: false, message: "I already refused that." };
    }
    const what = r.command ? `run \`${r.command.slice(0, 80)}\`` : `use ${r.tool}`;
    // "Approve all like this": a gate becomes a waiver; a command, its shape at Careful (ADR-053).
    const shape = !v.gated && r.command ? await shapeRuleFor(r.command) : null;
    const itemId = d.inbox.open({
      kind: "approval",
      jobId: job.id,
      taskId,
      raisedBy: { legId: leg.legId },
      title: `${leg.legName} wants to ${what}`,
      detail: `Task: ${task.title}\nWhy it asks: ${v.reason}.\n\n${r.command ? fence(r.command) : fence(JSON.stringify(r.input, null, 2), "json")}\n\n**If you deny it:** ${leg.legName} is told no and tries another way; if the task can't be done without it, it keeps going wrong and I ask you what to do.`,
      options: ["Approve", "Deny", ALL_LIKE_THIS],
      defaultOption: null,
      // What each answer does (ADR-045).
      questions: [
        choiceQuestion(`Let ${leg.legName} ${what}?`, [
          { label: "Approve", detail: "It runs this once; the task goes on." },
          {
            label: "Deny",
            detail: `${leg.legName} is told no and tries another way; if it can't, I ask you what to do.`,
          },
          {
            label: ALL_LIKE_THIS,
            detail: v.gated
              ? `Every ${v.gated} in this job runs without asking from now on.`
              : shape
                ? `Every command shaped like this one (${shape.slice("shape:".length)}) runs without asking in this job.`
                : `Every command using ${(r.command ? [...new Set(programsOf(r.command))].join(", ") : r.tool) || "this"} runs without asking in this job.`,
          },
        ]),
      ],
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
        v.gated ? { gated: v.gated } : { allowRule: shape ?? allowRuleFor(r.command ?? r.tool) },
      );
      logDecision(d.bus, job.id, {
        taskId,
        tool: r.tool,
        action,
        verdict: "allow",
        layer: "owner",
        reason: "approved, with all like it",
      });
      stuck.allowed(stuckKey);
      return { allow: true };
    }
    if (answer === "Approve") {
      logDecision(d.bus, job.id, {
        taskId,
        tool: r.tool,
        action,
        verdict: "allow",
        layer: "owner",
        reason: "approved",
      });
      stuck.allowed(stuckKey);
      return { allow: true };
    }
    logDecision(d.bus, job.id, {
      taskId,
      tool: r.tool,
      action,
      verdict: "block",
      layer: "owner",
      reason: "denied",
    });
    deniedGates.add(key);
    // The consequence, said in the project's conversation (ADR-045).
    addMessage(
      d,
      job.id,
      "eye",
      `You said no to ${leg.legName}'s request to ${what} (“${task.title}”). I told it, and it tries another way; if the task can't be done without it, I'll ask you what to do.`,
      {
        intent: "report",
        did: [],
        silkIds: [],
        taskIds: [taskId],
        jobId: null,
        report: { kind: "denied", taskId, facts: [], todo: [] },
      },
    );
    return {
      allow: false,
      message:
        "The owner denied it. Don't try it again: find another way to finish the task, or, if it can't be done without it, say so and why, then stop.",
    };
  };

  /**
   * In the Leg's own auto mode (Claude Code, ADR-053): Oraknid's rules before
   * every tool. A block is denied with its reason, a production change or
   * what is never automatic asks (through onPermission), the rest is left
   * to the Leg's own classifier.
   */
  const onPreToolUse = async (r: PermissionRequest): Promise<PreToolDecision> => {
    if (isBrokered(r.tool, brokered)) return null;
    const { first } = await rulesVerdict(r);
    if (first.verdict === "deny") {
      if (first.drift)
        observed.forbidden.push(`tried \`${r.command ?? r.tool}\` (${first.reason})`);
      logDecision(d.bus, job.id, {
        taskId,
        tool: r.tool,
        action: r.command ?? r.path ?? r.tool,
        verdict: "block",
        layer: "rules",
        reason: first.reason,
      });
      event("task.refused", {
        command: (r.command ?? r.tool).slice(0, 300),
        reason: first.reason,
        drift: first.drift,
        layer: "rules",
      });
      if (first.drift === null)
        stuck.blocked(stuckKey, {
          action: (r.command ?? r.tool).slice(0, 200),
          reason: first.reason,
          layer: 1,
        });
      return { decision: "deny", message: first.message ?? `Not allowed: ${first.reason}.` };
    }
    if (first.verdict === "ask") return { decision: "ask" };
    if (r.command && first.verdict === "allow")
      logDecision(d.bus, job.id, {
        taskId,
        tool: r.tool,
        action: r.command,
        verdict: "allow",
        layer: "rules",
        reason: first.reason,
      });
    return null;
  };

  /**
   * The agent is stuck on blocks (ADR-053): I'm asked, with the blocked
   * actions and their reasons. The Leg waits: "Let it run this one" runs
   * the last one; "Keep it blocked" tells it to go another way.
   */
  const askWhenStuck = async (
    r: PermissionRequest,
    s: { why: string; blocks: { action: string; reason: string; layer: 1 | 2 }[] },
    refused: PermissionDecision,
  ): Promise<PermissionDecision> => {
    const list = s.blocks
      .slice(-10)
      .map(
        (b) =>
          `- \`${b.action.replace(/`/g, "'").slice(0, 160)}\` — ${b.reason} (${b.layer === 1 ? "rules" : "judge"})`,
      )
      .join("\n");
    const itemId = d.inbox.open({
      kind: "approval",
      jobId: job.id,
      taskId,
      raisedBy: { legId: leg.legId },
      title: `${leg.legName} is stuck on blocked actions in “${task.title}”`,
      detail: `${s.why}, so I'm asking you. What was blocked, and why:\n\n${list}\n\nThe last one:\n\n${r.command ? fence(r.command) : fence(JSON.stringify(r.input, null, 2), "json")}\n\n**If you keep it blocked:** ${leg.legName} is told to find another way, or to say the task can't be done without it.`,
      options: [LET_IT_RUN, KEEP_BLOCKED],
      defaultOption: null,
      questions: [
        choiceQuestion(`Let ${leg.legName} run the last one?`, [
          {
            label: LET_IT_RUN,
            detail: "It runs once, this time; the rules and the judge stay as they are.",
          },
          {
            label: KEEP_BLOCKED,
            detail: `${leg.legName} goes another way, or says it can't be done without it.`,
          },
        ]),
      ],
    });
    asked.push(itemId);
    event("task.waiting", { itemId, reason: s.why });
    waitingOnOwner++;
    let answer: string;
    try {
      answer = await waitForAnswer(d.inbox, d.bus, itemId, signal);
    } catch {
      return { allow: false, message: "Oraknid is pausing this session." };
    } finally {
      waitingOnOwner--;
    }
    observed.lastActivityAt = now();
    const action = r.command ?? r.path ?? r.tool;
    if (answer === LET_IT_RUN) {
      logDecision(d.bus, job.id, {
        taskId,
        tool: r.tool,
        action,
        verdict: "allow",
        layer: "owner",
        reason: "let it run, stuck on blocks",
      });
      stuck.allowed(stuckKey);
      return { allow: true };
    }
    logDecision(d.bus, job.id, {
      taskId,
      tool: r.tool,
      action,
      verdict: "block",
      layer: "owner",
      reason: "kept blocked, stuck on blocks",
    });
    return {
      allow: false,
      message: `${refused.allow ? "" : refused.message} The owner looked at what was blocked and keeps it so: find another way, or say the task can't be done without it and why, then stop.`,
    };
  };

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
  /** The job's servers as its commands name them, production marked (ADR-049). */
  const servers: JobServerRef[] = [];
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
    serversText = `# Servers this job may use\n\nReach each with its alias (\`ssh <alias>\`, \`scp\`, \`rsync\`). Read its state document first: it says what runs there and what must not break. Change only what the task needs; anything else on the server is not yours.${named ? " Work meant for a server (a deploy) goes to the one marked as this job's, and to no other." : ""}\n\nThe aliases are in \`${cfg}\`, which ssh reads only when it is named: \`ssh -F <that file> <alias> '<command>'\` (\`scp -F\` and \`rsync -e "ssh -F …"\` the same way). Put the command run there in one pair of quotes with nothing after it on the line, \`sudo -n\` inside them when it needs root. Every command on a server goes through Oraknid's approvals; on a production server every change asks the owner first.${
      own
        ? `\n\n**This job's place is the server ${own.name}** (\`${own.alias}\`), not a repo: the workspace is a scratch folder for notes and scripts, and the work is done on the server. When the task is done, list in your last message what you changed on the server, a line each.`
        : ""
    }\n\n${docs.join("\n\n")}`;
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
      // Careful keeps every prompt Oraknid's; auto and full let Claude Code's own auto mode
      // judge, with Oraknid's rules before every tool (ADR-053). Other Legs ignore it.
      permissionMode: job.autonomy === "careful" ? "ask" : "auto",
      onPreToolUse,
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
    const itemId = d.inbox.open({
      kind: "question",
      jobId: job.id,
      taskId,
      raisedBy: "eye",
      title: asking.title,
      detail: asking.detail,
      options: [],
      defaultOption: null,
      questions: asking.questions,
    });
    // Asked in the project's conversation too (ADR-045); answering there answers the item.
    addMessage(
      d,
      job.id,
      "eye",
      `“${task.title}” keeps going wrong on ${leg.legName}: ${drift.evidence}. What should I do?`,
      {
        intent: "report",
        did: [],
        silkIds: [],
        taskIds: [taskId],
        jobId: null,
        report: { kind: "waiting", taskId, facts: [], todo: [] },
      },
      { questions: asking.questions, itemId },
    );
    // Withdrawn if the attempt stops before I answer (Audit 1 → D1-07).
    asked.push(itemId);
    const text = await waitForAnswer(d.inbox, d.bus, itemId, signal);
    const answered = d.inbox.get(itemId);
    const choice = readKeepsGoingWrong(text, answered?.answers ?? null);
    if (choice.kind === "mine") throw new EndAttempt({ kind: "owner-held" });
    if (choice.kind === "leave-out")
      throw new EndAttempt({ kind: "skipped", dependents: choice.dependents });
    if (choice.kind === "stop")
      throw new EndAttempt({
        kind: "cancel-job",
        reason: `Stopped by me after "${task.title}" kept going wrong; the work so far stays on its branch.`,
      });
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
      throw new EndAttempt({
        kind: "retry",
        reason: choice.legId
          ? `given to ${d.registry.get(choice.legId)?.name ?? "another Leg"} by me`
          : "given to another Leg by me",
      });
    }
    throw new EndAttempt({
      kind: "retry",
      reason: choice.advice ? "retrying with my advice" : "retrying, as I asked",
    });
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
    outcome: "succeeded" | "failed" | "reassigned" | "abandoned" | "unavailable",
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
    // Its provider failing says nothing of what the model can do (M13.22).
    if (m && outcome !== "unavailable") {
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
        // A usage limit is the account's, not the task failing: not counted against it (M13.22).
        finish("unavailable", false);
        return { kind: "retry", reason: `${leg.legName} hit a usage limit` };
      }
      if (end.reason === "error") {
        await handOff(false);
        await closeSession();
        // Its provider failed, not the task (M13.22): the model (or the Leg) rests, the
        // attempt isn't counted against the task, and routing tries elsewhere next.
        const infra = providerFailure(end.error);
        if (infra) {
          const { until, inARow } = d.registry.providerFailed(leg.legId, leg.legModelId, infra);
          const what = infra.scope === "leg" ? leg.legName : `${leg.legName} · ${leg.model}`;
          event("task.provider-failed", {
            legId: leg.legId,
            legModelId: leg.legModelId,
            scope: infra.scope,
            reason: infra.reason,
            until,
            inARow,
          });
          finish("unavailable", false);
          return {
            kind: "retry",
            reason: `${what} failed at its provider (${infra.reason}); it rests until ${new Date(until).toISOString()}, and the attempt doesn't count against the task`,
          };
        }
        d.db
          .update(tasks)
          .set({ avoid: [...new Set([...task.avoid, leg.legModelId])] })
          .where(eq(tasks.id, taskId))
          .run();
        finish("failed", false);
        return { kind: "retry", reason: `${leg.legName} failed: ${end.error ?? "unknown error"}` };
      }

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
      let verified = task.verify.length === 0;
      let failure = "";
      if (task.verify.length) {
        event("task.verifying", {});
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
        const check = () =>
          runVerify(task.verify, ws.cwd, plan, {
            signal,
            refuse: (command) =>
              verifyRefusal(
                decide({ tool: "Bash", command, path: null }, policyFor(d.db, job.id, ws.cwd)),
              ),
            builtin: async (command) =>
              // A check on one of the job's servers runs there, over Oraknid's connection (ADR-049).
              (servers.length && d.servers
                ? await runServerCheck(command, {
                    servers,
                    run: (id, remote) => (d.servers as Servers).run(id, remote),
                    refuse: (c) => {
                      const v = serverVerdict(c, servers, policyFor(d.db, job.id, ws.cwd));
                      return v ? verifyRefusal(v) : null;
                    },
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
              github: (() => {
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
              })(),
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
    finish("abandoned", false);
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

/**
 * A Leg's name for a call to one of Oraknid's bridges: `mcp__<server>__<tool>`
 * (Claude Code) or `<server>_<tool>` (OpenCode, which may turn `-` into `_`).
 */
export function isBrokered(tool: string, servers: string[]): boolean {
  const norm = (x: string) => x.replace(/[^A-Za-z0-9_]/g, "_");
  const t = norm(tool);
  return servers.some((s) => t.startsWith(`mcp__${norm(s)}__`) || t.startsWith(`${norm(s)}_`));
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

/** A job that ended keeps nothing in memory here (Audit 1 → Q1-19): the judge's cache is per task. */
export function forgetJob(_jobId: string) {}

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
        cooldown: registry.cooldownOf(leg.id, m.id),
        legProviderFailures: registry.providerStreak(leg.id),
      });
    }
  }
  return out;
}
