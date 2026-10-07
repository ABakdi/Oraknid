import { join } from "node:path";
import { choiceQuestion } from "@oraknid/contracts";
import {
  allowRuleFor,
  blockedMessage,
  decide,
  fence,
  type GateBy,
  type GatedAction,
  type GateFacts,
  type GateSource,
  type GateStep,
  type Grant,
  type GrantScope,
  gateStep,
  onceGrantFor,
  type PolicyContext,
  type PolicyVerdict,
  programsOf,
  refusalKey,
  taskScope,
} from "@oraknid/core";
import type { Blocked } from "@oraknid/guard";
import {
  type PermissionDecision,
  type PermissionRequest,
  type PreToolDecision,
  SHELL_TOOL,
  toolClass,
} from "@oraknid/leg-sdk";
import { eq } from "drizzle-orm";
import type { Db } from "../db/open.ts";
import { jobs, tasks } from "../db/schema.ts";
import type { EventBus } from "../events/bus.ts";
import { waitForAnswer } from "../eye/approvals.ts";
import {
  forgetJobVerdicts,
  guardContext,
  judgeAction,
  layer1,
  logDecision,
  ownerWords,
  shapeApproved,
  shapeRuleFor,
  stuck,
} from "../eye/auto-mode.ts";
import type { EyeBrain } from "../eye/brain.ts";
import { approveAllLikeThis, policyFor } from "../eye/policy.ts";
import { addMessage } from "../eye/talk.ts";
import { forgetTaskMemory, readTaskMemory } from "../eye/task-memory.ts";
import type { InboxStore, NewInboxItem } from "../inbox/store.ts";
import { jobHomeDir, scratchFor } from "../legs/job-home.ts";
import {
  type JobServerRef,
  namedIn,
  parseSsh,
  plainServerCheck,
  removalTargets,
  serverVerdict,
} from "../servers/remote.ts";
import { jobPlan } from "../servers/server-jobs.ts";
import type { SilkStore } from "../silk/store.ts";
import type { McpDeclaration, ToolRegistry, ToolRow } from "../tools/registry.ts";
import { githubLinksOf } from "../workspace/github-tool.ts";
import { type AttemptEventData, AttemptLog } from "./log.ts";

// The Gate (ADR-056 §3): every action of an agent, from every source — the
// Leg's permission prompt, Claude Code's PreToolUse hook, the MCP broker,
// a command on one of the job's servers, a check's command — decided on
// one path: the rules (layer 1, once) → the grants → the judge → the
// autonomy level → me. It keeps the grants, the refusals and the stuck
// count (durable, in the task's memory), raises the stuck question, and
// asks me through one helper that records what it asked for withdrawal.
// The decision itself is `gateStep` (@oraknid/core), pure.

/** The answers to a Leg's permission request (Approvals → The inbox). */
export const ALL_LIKE_THIS = "Approve all like this for this job";
/** The answers when an agent is stuck on blocks (ADR-053). */
export const LET_IT_RUN = "Let it run this one";
export const KEEP_BLOCKED = "Keep it blocked";
/** Letting one blocked command run, once: a change the plan names, what the agent needs (ADR-049). */
export const ALLOW = "Allow";

/** A shell tool's command is read by layer 1 (ADR-053); the tools' names are the Leg SDK's. */
const isShell = (tool: string) => toolClass(tool) === "shell";
/** A tool that only reads: its allows aren't each in the audit log. */
const isRead = (tool: string) => toolClass(tool) === "read";

/** One action, from one source. */
export interface GateAction {
  source: Exclude<GateSource, "check">;
  request: PermissionRequest;
  /** What Oraknid's own tool made of this very call (ADR-038). */
  judged?: McpDeclaration;
}

/** The Gate's answer. */
export interface GateDecision {
  verdict: "allow" | "deny" | "ask";
  by: GateBy;
  reason: string;
  scope?: GrantScope;
  /** What the agent is told when it is refused. */
  message?: string;
  /** The decision's layer and reason, for the Leg's log. */
  why?: string;
  /** The hook has no opinion: the Leg's own classifier decides. */
  leaveToLeg?: boolean;
}

/** The questions I'm asked about a task's actions, and the attempt's own. */
export type OwnerAsk = "plan-change" | "stuck" | "approval" | "agent-needs" | "keeps-going-wrong";

/** What the Gate needs of the attempt it serves. */
export interface GateContext {
  db: Db;
  bus: EventBus;
  inbox: InboxStore;
  silk: SilkStore;
  now: () => number;
  /** The judge (ADR-053); without one, what the rules leave counts as blocked. */
  brain?: EyeBrain;
  tools?: ToolRegistry;
  toolRows: ToolRow[];
  legsDir: string;
  job: { id: string; goal: string };
  /** The task as the attempt holds it: its checks may be corrected while it runs. */
  task: {
    id: string;
    title: string;
    instructions: string;
    kind: string;
    scope: string[];
    verify: string[];
  };
  leg: { legId: string; legName: string };
  /** The attempt it serves: its decisions go to the attempt log (ADR-056 §1). */
  attemptId?: string | null;
  cwd: string;
  /** The job's servers, filled in when the attempt prepares them. */
  servers: JobServerRef[];
  signal: AbortSignal;
  /** What the attempt's drift detectors and stall watch hear of the Gate. */
  on: {
    activity: () => void;
    forbidden: (what: string) => void;
    gateBypass: (what: string) => void;
    event: (type: string, payload: Record<string, unknown>) => void;
    /** The attempt starts or stops waiting on my answer (the controller's AwaitingOwner). */
    owner?: (waiting: boolean) => void;
  };
}

export type Gate = ReturnType<typeof createGate>;

/** A stuck question to raise at the agent's next action (it couldn't be held for my answer). */
type Pending = { why: string; blocks: Blocked[]; by: Blocked["layer"] };

export function createGate(c: GateContext) {
  const { db, bus, job, task, leg, servers } = c;
  /**
   * The attempt log (ADR-056 §1): every decision, question and mark is
   * written there, and what the task remembers is read back from it.
   */
  const log = new AttemptLog(db, c.now).at({
    jobId: job.id,
    taskId: task.id,
    attemptId: c.attemptId ?? null,
  });
  const memory = readTaskMemory(db, task.id);
  /** What I refused (D8), kept across attempts and restarts. */
  const denied = new Set<string>(memory.denied);
  /** The grants I gave and not used yet (ADR-056 §3): durable, in the log. */
  const grants: Grant[] = [...memory.grants];
  let decisions = 0;
  type Decided = Omit<AttemptEventData["GateDecision"], "actionId" | "tool" | "action">;
  /** A decision, in the log: what the task remembers is read back from these. */
  const record = (r: PermissionRequest | null, d: Decided, action?: string) =>
    log.append("GateDecision", {
      actionId: `${c.attemptId ?? task.id}:g${++decisions}`,
      tool: r?.tool ?? SHELL_TOOL,
      action: (action ?? (r ? (r.command ? plain(r.command) : (r.path ?? r.tool)) : "")).slice(
        0,
        200,
      ),
      ...d,
    });
  /** Planned changes and commands I kept blocked when asked: not asked again in this attempt. */
  const keptBlocked = new Set<string>();
  /** What was blocked in this attempt, oldest first: for the agent's "the owner must…". */
  const blockedHere: { command: string; reason: string; byLeg?: boolean }[] = [];
  /** What the hook sent on to the permission prompt to be asked of me there, by plain form. */
  const deferred = new Map<string, () => Promise<PermissionDecision>>();
  /** A stuck question not asked yet: raised at the agent's next action through Oraknid. */
  let pending = null as Pending | null;
  /** What this attempt asked me: withdrawn if it ends before I answer, or after a crash (bug 9). */
  const asked: string[] = [];
  let waitingOnOwner = 0;
  /** The task read something from outside: untrusted from here on, in every later attempt (BR-15). */
  let untrusted = memory.untrusted !== null;

  const brokered = c.toolRows.map((t) => `oraknid-${t.name}`);
  const aliases = () => servers.map((s) => s.alias);

  /** The stuck rule's key: blocks are counted per task (ADR-053), kept across a restart (bug 8). */
  const stuckKey = `${job.id}:${task.id}`;
  stuck.restore(stuckKey, memory.stuck);
  /** A block counted toward the stuck rule, in the log with its decision; stuck, said so. */
  const count = (b: Blocked, r: PermissionRequest | null, d: Omit<Decided, "counts">) => {
    record(r, { ...d, counts: b.layer }, b.action);
    const s = stuck.blocked(stuckKey, b);
    if (s) log.append("Signal", { kind: "stuck", code: null, evidence: s.why });
    return s;
  };
  /**
   * I refused an action (Deny, kept blocked, refused again at once): a block
   * like any other. Stuck by it, I'm asked at the agent's next action, not
   * on top of the answer I just gave.
   */
  const ownerBlocked = (r: PermissionRequest, reason: string, refusal?: string) => {
    const s = count(
      {
        action: (r.command ? plain(r.command) : r.tool).slice(0, 200),
        reason,
        layer: "owner",
      },
      r,
      { source: "owner", by: "owner", verdict: "deny", reason, ...(refusal ? { refusal } : {}) },
    );
    if (s) pending = { ...s, by: "owner" };
  };
  /** An action ran: the row ends. The decision that let it run says so in the log (`endsRow`). */
  const endRow = () => stuck.allowed(stuckKey);
  /** I let it run: the owner's decision, in the log; the row ends. */
  const ownerAllowed = (r: PermissionRequest, reason: string, scope?: GrantScope) => {
    record(r, {
      source: "owner",
      by: "owner",
      verdict: "allow",
      reason,
      endsRow: true,
      ...(scope ? { scope } : {}),
    });
    endRow();
  };

  const audit = (
    r: PermissionRequest,
    p: {
      verdict: "allow" | "block" | "ask";
      layer: "rules" | "judge" | "owner" | "leg";
      reason: string;
    },
    action = r.command ?? r.path ?? r.tool,
  ) => logDecision(bus, job.id, { taskId: task.id, tool: r.tool, action, ...p });

  /** A command in its plain form (`ssh <alias>` alone, ADR-049): how what I let run is matched. */
  const plain = (command: string) =>
    servers.length ? plainServerCheck(command.trim(), aliases()) : command.trim();
  /** An action as the after-the-fact audit matches it to a decision made before it ran. */
  const actionKey = (r: PermissionRequest) =>
    r.command ? `$ ${plain(r.command)}` : `${r.path ?? r.tool}`;
  /** What the Gate decided in this attempt before it ran: not audited again after. */
  const decidedHere = new Set<string>();

  const markUntrusted = (reason: string) => {
    if (untrusted) return;
    untrusted = true;
    log.append("Signal", { kind: "untrusted", code: null, evidence: reason });
    c.on.event("task.untrusted", { reason });
  };

  /** What layer 1 knows of this attempt: the folder, its scratch, the job's servers, the task. */
  const guardCtx = () =>
    guardContext({
      cwd: c.cwd,
      scratch: scratchFor(c.legsDir, leg.legId, job.id),
      home: jobHomeDir(c.legsDir, leg.legId, job.id),
      servers: servers.map((s) => ({ alias: s.alias, name: s.name, production: s.production })),
      sshConfig: servers.length
        ? join(jobHomeDir(c.legsDir, leg.legId, job.id), ".ssh", "config")
        : null,
      taskText: [
        job.goal,
        task.title,
        task.instructions,
        ...(task.scope ?? []),
        ...ownerWords(db, job.id),
      ].join("\n"),
      verify: task.verify ?? [],
    });

  /** The rules (layer 1 and the policy, a server's own reading), run once per action. */
  const rulesOf = async (r: PermissionRequest, judged?: McpDeclaration) => {
    const policy = policyFor(db, job.id, c.cwd);
    // Its own /tmp, this job's home and the Leg's tmp and cache are its scratch (M13.22).
    policy.scratch = scratchFor(c.legsDir, leg.legId, job.id);
    if (untrusted) policy.untrusted = true;
    if (c.toolRows.length) {
      const declared = c.tools?.declarations(c.toolRows) ?? new Map();
      if (judged) declared.set(r.tool, judged);
      policy.mcp = declared;
    }
    // Layer 1: the guard reads the command as the shell does, before the policy (ADR-053).
    if (r.command && isShell(r.tool)) policy.layer1 = await layer1(r.command, guardCtx());
    // A command on one of the job's servers is judged as what runs there; production asks (ADR-049).
    const first =
      (r.command && servers.length ? serverVerdict(r.command, servers, policy) : null) ??
      decide(r, policy);
    const fetches =
      (r.tool === "WebFetch" && !ownRepoPage(fetchedUrl(r), githubLinksOf(db, job.id))) ||
      r.tool === "WebSearch" ||
      (r.command ? /\b(curl|wget)\b/.test(r.command) : false);
    if (fetches && first.verdict !== "deny")
      markUntrusted(`read from the web (${r.tool}): gated actions ask me from now on`);
    return { first, policy };
  };

  /** A block of layer 1's own: CC Safety Net or our rules, not a secret going out (ADR-049). */
  const ownBlock = (v: PolicyVerdict, policy: PolicyContext) =>
    v.verdict === "deny" &&
    v.drift === null &&
    policy.layer1?.verdict === "block" &&
    !(policy.layer1.rule ?? "").startsWith("secret.");

  /**
   * A change on one of the job's servers that its plan names (ADR-049): it
   * removes only paths, a compose project, volumes or containers, each named
   * in the plan. Null for anything else.
   */
  const plannedChange = (command: string) => {
    if (!servers.length) return null;
    const ssh = parseSsh(command, aliases());
    if (!ssh?.whole) return null;
    const targets = removalTargets(ssh.remote);
    if (!targets) return null;
    const plan = jobPlan(db, c.silk, job.id);
    const named = targets.map((t) => namedIn(t, plan.text));
    if (named.some((x) => !x)) return null;
    return {
      server: servers.find((s) => s.alias === ssh.alias) as JobServerRef,
      remote: ssh.remote.trim(),
      quote: (named[0] as string).replace(/^[-*\s]+/, "").slice(0, 200),
      approved: plan.approved,
    };
  };
  type Planned = NonNullable<ReturnType<typeof plannedChange>>;

  /** The once-grant this command would use, or -1. */
  const onceFor = (command: string) => {
    if (!grants.length) return -1;
    const p = plain(command);
    const ssh = servers.length ? parseSsh(p, aliases()) : null;
    return onceGrantFor(grants, p, ssh?.whole ? ssh.remote.trim() : null);
  };
  /** Layer 2: the judge, reasoning-blind (ADR-053); its silence or error is a block. */
  const askJudge = async (r: PermissionRequest, first: PolicyVerdict, policy: PolicyContext) => {
    const row = db
      .select({ allowRules: jobs.allowRules })
      .from(jobs)
      .where(eq(jobs.id, job.id))
      .get();
    const verdict = await judgeAction(
      c.brain,
      {
        ownerMessages: ownerWords(db, job.id),
        goal: job.goal,
        task: task.title,
        scope: taskScope(task),
        action: { tool: r.tool, command: r.command, input: r.command ? undefined : r.input },
        workspace: c.cwd,
        servers: servers.map((s) => ({ name: s.name, alias: s.alias, production: s.production })),
        repos: githubLinksOf(db, job.id)
          .map((x) => (x.github ? `${x.github.owner}/${x.github.name}` : ""))
          .filter(Boolean),
        notes: {
          allow: (row?.allowRules ?? []).filter((x) => !x.startsWith("shape:")),
          deny: policy.rules?.flatMap((l) => l.deny) ?? [],
        },
        why: first.reason,
      },
      { jobId: job.id, taskId: task.id, cwd: c.cwd },
    );
    bus.publish({
      type: "policy.judged",
      topic: `job:${job.id}`,
      jobId: job.id,
      payload: {
        taskId: task.id,
        action: (r.command ?? r.tool).slice(0, 300),
        decision: verdict.verdict,
        reason: verdict.reason,
        stage: verdict.stage,
        cached: verdict.cached,
        timedOut: verdict.verdict === "block" ? !!verdict.timedOut : false,
      },
      actor: "eye",
    });
    return { verdict: verdict.verdict, reason: verdict.reason };
  };

  /**
   * Asks me (ADR-045): one inbox item, recorded for withdrawal, the attempt
   * waiting on me meanwhile. Null when the attempt is stopped first, unless
   * `throwOnStop`.
   */
  const askOwner = async (
    _kind: OwnerAsk,
    item: NewInboxItem,
    o: {
      reason?: string;
      /** Said in the project's conversation too, once the item is open. */
      opened?: (itemId: string) => void;
      /** The attempt waits on me (not a stall); false when no session runs meanwhile. */
      waits?: boolean;
      throwOnStop?: boolean;
    } = {},
  ): Promise<{ itemId: string; answer: string | null }> => {
    const itemId = c.inbox.open(item);
    o.opened?.(itemId);
    asked.push(itemId);
    log.append("QuestionAsked", { itemId, ask: _kind, title: item.title.slice(0, 200) });
    const waits = o.waits !== false;
    if (waits) {
      c.on.event("task.waiting", { itemId, reason: o.reason ?? "" });
      if (waitingOnOwner++ === 0) c.on.owner?.(true);
    }
    let answer: string | null;
    try {
      answer = await waitForAnswer(c.inbox, bus, itemId, c.signal);
    } catch (error) {
      if (o.throwOnStop) throw error;
      answer = null;
    } finally {
      if (waits && --waitingOnOwner === 0) c.on.owner?.(false);
    }
    if (answer !== null) log.append("QuestionAnswered", { itemId, answer: answer.slice(0, 500) });
    if (waits && answer !== null) c.on.activity();
    return { itemId, answer };
  };
  const PAUSING: PermissionDecision = { allow: false, message: "Oraknid is pausing this session." };

  /**
   * A block of layer 1 on a change the plan names (ADR-049): one specific
   * approval, at once. Allowed, the exact command runs once; kept blocked,
   * the agent is told so and it isn't asked again in this attempt.
   */
  const askPlanned = async (
    r: PermissionRequest,
    p: Planned,
    reason: string,
  ): Promise<PermissionDecision> => {
    const where = p.approved ? "in the plan you approved" : "in the job's plan";
    const prompt = `${leg.legName} wants to run \`${p.remote}\` on ${p.server.name} (${where}: “${p.quote}”). Run it?`;
    const { answer } = await askOwner(
      "plan-change",
      {
        kind: "approval",
        jobId: job.id,
        taskId: task.id,
        raisedBy: { legId: leg.legId },
        title: `${leg.legName} wants to run \`${p.remote.slice(0, 80)}\` on ${p.server.name}, as the plan says`,
        detail: `${prompt}\n\nOraknid's rules block it on their own (${reason}); the plan names what it removes, so it is yours to allow. Task: ${task.title}.${p.server.production ? ` ${p.server.name} is production.` : ""}\n\n${fence(r.command ?? "")}\n\n**If you keep it blocked:** ${leg.legName} is told so and finds another way, or says the task can't be done without it.`,
        options: [ALLOW, KEEP_BLOCKED],
        defaultOption: null,
        questions: [
          choiceQuestion(prompt, [
            { label: ALLOW, detail: "It runs once, exactly as written; the task goes on." },
            {
              label: KEEP_BLOCKED,
              detail: `${leg.legName} goes another way, or says it can't be done without it.`,
            },
          ]),
        ],
      },
      { reason: `the plan names it: ${reason}` },
    );
    if (answer === null) return PAUSING;
    const action = r.command ?? r.tool;
    if (answer === ALLOW) {
      audit(r, { verdict: "allow", layer: "owner", reason: `allowed once: ${where}` }, action);
      ownerAllowed(r, `allowed once: ${where}`, "once");
      return { allow: true, why: `owner: allowed once, ${where}` };
    }
    keptBlocked.add(plain(action));
    ownerBlocked(r, "kept blocked, though the plan names it");
    audit(
      r,
      { verdict: "block", layer: "owner", reason: "kept blocked, though the plan names it" },
      action,
    );
    return {
      allow: false,
      message: `${blockedMessage(reason)} The owner was asked and keeps it blocked: find another way, or say the task can't be done without it and why, then stop.`,
    };
  };

  /**
   * The agent is stuck on blocks (ADR-053): I'm asked, with the blocked
   * actions and their reasons. The Leg waits: "Let it run this one" runs
   * the last one; "Keep it blocked" tells it to go another way.
   */
  const askStuck = async (
    r: PermissionRequest,
    s: { why: string; blocks: Blocked[] },
    refused: PermissionDecision,
  ): Promise<PermissionDecision> => {
    const by = (l: Blocked["layer"]) =>
      l === 1
        ? "rules"
        : l === 2
          ? "judge"
          : l === "owner"
            ? "you"
            : `${leg.legName}'s own auto mode`;
    const list = s.blocks
      .slice(-10)
      .map(
        (b) => `- \`${b.action.replace(/`/g, "'").slice(0, 160)}\` — ${b.reason} (${by(b.layer)})`,
      )
      .join("\n");
    const { answer } = await askOwner(
      "stuck",
      {
        kind: "approval",
        jobId: job.id,
        taskId: task.id,
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
      },
      { reason: s.why },
    );
    if (answer === null) return PAUSING;
    if (answer === LET_IT_RUN) {
      audit(r, { verdict: "allow", layer: "owner", reason: "let it run, stuck on blocks" });
      ownerAllowed(r, "let it run, stuck on blocks", "once");
      return { allow: true };
    }
    audit(r, { verdict: "block", layer: "owner", reason: "kept blocked, stuck on blocks" });
    record(r, {
      source: "owner",
      by: "owner",
      verdict: "deny",
      reason: "kept blocked, stuck on blocks",
    });
    return {
      allow: false,
      message: `${refused.allow ? "" : refused.message} The owner looked at what was blocked and keeps it so: find another way, or say the task can't be done without it and why, then stop.`,
    };
  };

  /** A gated action, mine to approve (Careful, a production change, what is never automatic). */
  const askApproval = async (
    r: PermissionRequest,
    reason: string,
    gated: GatedAction | null,
  ): Promise<PermissionDecision> => {
    const what = r.command ? `run \`${r.command.slice(0, 80)}\`` : `use ${r.tool}`;
    const action = r.command ?? r.path ?? r.tool;
    // "Approve all like this": a gate becomes a waiver; a command, its shape at Careful (ADR-053).
    const shape = !gated && r.command ? await shapeRuleFor(r.command) : null;
    const { answer } = await askOwner(
      "approval",
      {
        kind: "approval",
        jobId: job.id,
        taskId: task.id,
        raisedBy: { legId: leg.legId },
        title: `${leg.legName} wants to ${what}`,
        detail: `Task: ${task.title}\nWhy it asks: ${reason}.\n\n${r.command ? fence(r.command) : fence(JSON.stringify(r.input, null, 2), "json")}\n\n**If you deny it:** ${leg.legName} is told no and tries another way; if the task can't be done without it, it keeps going wrong and I ask you what to do.`,
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
              detail: gated
                ? `Every ${gated} in this job runs without asking from now on.`
                : shape
                  ? `Every command shaped like this one (${shape.slice("shape:".length)}) runs without asking in this job.`
                  : `Every command using ${(r.command ? [...new Set(programsOf(r.command))].join(", ") : r.tool) || "this"} runs without asking in this job.`,
            },
          ]),
        ],
      },
      { reason },
    );
    // Paused or stopped while waiting: a permission hook always answers; the attempt stops anyway.
    if (answer === null) return PAUSING;
    if (answer === ALL_LIKE_THIS) {
      // A grant for the job: kept with it (its waivers and allow rules), read by the rules.
      approveAllLikeThis(
        db,
        bus,
        job.id,
        gated ? { gated } : { allowRule: shape ?? allowRuleFor(r.command ?? r.tool) },
      );
      audit(r, { verdict: "allow", layer: "owner", reason: "approved, with all like it" }, action);
      ownerAllowed(r, "approved, with all like it", "job");
      return { allow: true };
    }
    if (answer === "Approve") {
      audit(r, { verdict: "allow", layer: "owner", reason: "approved" }, action);
      ownerAllowed(r, "approved", "once");
      return { allow: true };
    }
    audit(r, { verdict: "block", layer: "owner", reason: "denied" }, action);
    denied.add(refusalKey(r));
    ownerBlocked(r, "denied", refusalKey(r));
    // The consequence, said in the project's conversation (ADR-045).
    addMessage(
      c,
      job.id,
      "eye",
      `You said no to ${leg.legName}'s request to ${what} (“${task.title}”). I told it, and it tries another way; if the task can't be done without it, I'll ask you what to do.`,
      {
        intent: "report",
        did: [],
        silkIds: [],
        taskIds: [task.id],
        jobId: null,
        report: { kind: "denied", taskId: task.id, facts: [], todo: [] },
      },
    );
    return {
      allow: false,
      message:
        "The owner denied it. Don't try it again: find another way to finish the task, or, if it can't be done without it, say so and why, then stop.",
    };
  };

  const fromPermission = (p: PermissionDecision, by: GateBy, reason: string): GateDecision =>
    p.allow
      ? { verdict: "allow", by, reason, ...(p.why ? { why: p.why } : {}) }
      : { verdict: "deny", by, reason, message: p.message, ...(p.why ? { why: p.why } : {}) };
  const ASK: GateDecision = { verdict: "ask", by: "owner", reason: "asked through the prompt" };

  /** One action, one path (ADR-056 §3). */
  const decideAction = async (a: GateAction): Promise<GateDecision> => {
    const r = a.request;
    const hook = a.source === "hook";
    decidedHere.add(actionKey(r));
    // The broker judges every call to a job's tool: the Leg's own ask for it passes (ADR-021).
    if (isBrokered(r.tool, brokered)) {
      record(r, {
        source: a.source,
        by: "rule",
        verdict: "allow",
        reason: "a job's tool, judged by its broker",
      });
      return hook
        ? {
            verdict: "allow",
            by: "rule",
            reason: "a job's tool, judged by its broker",
            leaveToLeg: true,
          }
        : { verdict: "allow", by: "rule", reason: "a job's tool, judged by its broker" };
    }
    // Stuck on blocks it couldn't be asked about at once: asked now, with this action held.
    if (pending && (!hook || r.command)) {
      const s = pending;
      pending = null;
      if (hook) {
        deferred.set(plain(r.command as string), () => askStuck(r, s, { allow: true }));
        record(r, { source: a.source, by: "owner", verdict: "ask", reason: s.why });
        return ASK;
      }
      return fromPermission(await askStuck(r, s, { allow: true }), "owner", s.why);
    }

    let rules = null as Awaited<ReturnType<typeof rulesOf>> | null;
    /** A removal the plan names, read with the facts. */
    let planned = null as Planned | null;
    const facts = async (): Promise<GateFacts> => {
      rules ??= await rulesOf(r, a.judged);
      const { first, policy } = rules;
      const own = ownBlock(first, policy);
      const p = r.command ? plain(r.command) : null;
      planned =
        own && r.command && p !== null && !keptBlocked.has(p) ? plannedChange(r.command) : null;
      return {
        source: a.source,
        rules: first,
        command: !!r.command,
        ownBlock: own,
        grants: {
          once: !!r.command && onceFor(r.command) >= 0,
          planned: !!planned,
          refused: denied.has(refusalKey(r)),
          shape:
            first.verdict === "judge" && policy.autonomy === "careful" && r.command
              ? await shapeApproved(
                  r.command,
                  db
                    .select({ allowRules: jobs.allowRules })
                    .from(jobs)
                    .where(eq(jobs.id, job.id))
                    .get()?.allowRules ?? [],
                )
              : false,
        },
        autonomy: policy.autonomy,
      };
    };

    // What I let run once runs (ADR-053), before the hook's questions waiting here.
    if (!hook && r.command && grants.length) {
      const f = await facts();
      const step = gateStep({ ...f, grants: { once: f.grants.once } });
      if (step.verdict === "allow" && step.by === "grant") return ranOnce(r, step);
    }
    // What the PreToolUse hook sent here to be asked of me (ADR-053).
    if (!hook && r.command) {
      const ask = deferred.get(plain(r.command));
      if (ask) {
        deferred.delete(plain(r.command));
        return fromPermission(await ask(), "owner", "asked of me");
      }
    }

    let f = await facts();
    if (!hook) f = { ...f, grants: { ...f.grants, once: false } };
    let step = gateStep(f);
    if (step.verdict === "judge") {
      const read = rules as unknown as Awaited<ReturnType<typeof rulesOf>>;
      f = { ...f, judge: await askJudge(r, read.first, read.policy) };
      step = gateStep(f);
    }
    if (step.verdict === "judge") throw new Error("the judge's verdict was not read");

    if (step.verdict === "allow") {
      if (step.by === "grant" && step.scope === "once") return ranOnce(r, step);
      if (step.log && (r.command || !isRead(r.tool) || hook)) audit(r, step.log);
      record(r, {
        source: a.source,
        by: step.by,
        verdict: "allow",
        reason: step.reason,
        ...(step.scope ? { scope: step.scope } : {}),
        ...(step.endsRow ? { endsRow: true } : {}),
      });
      if (step.endsRow) endRow();
      if (step.leaveToLeg)
        return { verdict: "allow", by: step.by, reason: step.reason, leaveToLeg: true };
      return {
        verdict: "allow",
        by: step.by,
        reason: step.reason,
        ...(step.scope ? { scope: step.scope } : {}),
        why: `${step.layer}: ${step.reason}`,
      };
    }

    if (step.log) audit(r, step.log);

    if (step.verdict === "ask" && step.ask === "approval") {
      if (hook) {
        record(r, { source: a.source, by: "owner", verdict: "ask", reason: step.reason });
        return ASK;
      }
      return fromPermission(await askApproval(r, step.reason, step.gated), "owner", step.reason);
    }

    if (step.verdict === "deny" && step.drift === "D8") {
      c.on.gateBypass(`tried \`${r.command ?? r.tool}\` again after I refused it`);
      ownerBlocked(r, "denied before");
      return {
        verdict: "deny",
        by: "owner",
        reason: step.reason,
        message: "I already refused that.",
      };
    }

    // Refused by the rules or the judge (a plan's change is asked of me after the same steps).
    const drift = step.verdict === "deny" ? step.drift : null;
    const message =
      step.verdict === "deny" && step.message ? step.message : `Not allowed: ${step.reason}.`;
    if (drift) c.on.forbidden(`tried \`${r.command ?? r.tool}\` (${step.reason})`);
    c.on.event("task.refused", {
      command: (r.command ?? r.tool).slice(0, 300),
      reason: step.reason,
      drift,
      layer: step.layer,
    });
    if (drift === null && r.command) blockedHere.push({ command: r.command, reason: step.reason });
    const asDecided: Omit<Decided, "counts"> = {
      source: a.source,
      by: step.by,
      verdict: step.verdict === "ask" ? "ask" : "deny",
      reason: step.reason,
    };
    const counts = step.verdict === "deny" ? step.counts : null;
    const counted = counts !== null;
    if (!counted) record(r, asDecided);
    // A change the plan names: one specific approval, at once (ADR-049).
    if (step.verdict === "ask" && planned) {
      const p = planned;
      if (hook) {
        deferred.set(plain(r.command as string), () => askPlanned(r, p, step.reason));
        return ASK;
      }
      return fromPermission(await askPlanned(r, p, step.reason), "owner", step.reason);
    }
    const refused: GateDecision = {
      verdict: "deny",
      by: step.by,
      reason: step.reason,
      message,
      why: `${step.layer}: ${step.reason}`,
    };
    // Blocks count toward the stuck rule (3 in a row, 20 in the task): stuck, I'm asked.
    if (counted) {
      const s = count(
        {
          action: (r.command ? plain(r.command) : r.tool).slice(0, 200),
          reason: step.reason,
          layer: counts as Blocked["layer"],
        },
        r,
        asDecided,
      );
      if (s) {
        const asDecision: PermissionDecision = { allow: false, message, why: refused.why };
        if (!hook) return fromPermission(await askStuck(r, s, asDecision), "owner", s.why);
        // The hook can't wait for my answer: Claude Code asks through its permission prompt.
        if (r.command) {
          deferred.set(plain(r.command), () => askStuck(r, s, asDecision));
          return ASK;
        }
        // Not a command the prompt can be asked for (a file tool): asked at the next action.
        pending = { ...s, by: counts as Blocked["layer"] };
      }
    }
    return refused;
  };

  /** Ran because I let it, once: the grant is used up, the audit log says so, the stuck row ends. */
  const ranOnce = (r: PermissionRequest, step: Extract<GateStep, { verdict: "allow" }>) => {
    const i = onceFor(r.command as string);
    const spent = grants[i]?.match;
    grants.splice(i, 1);
    audit(r, { verdict: "allow", layer: "owner", reason: "let it run once" }, r.command ?? r.tool);
    record(r, {
      source: "owner",
      by: "grant",
      verdict: "allow",
      reason: step.reason,
      scope: "once",
      endsRow: true,
      ...(spent !== undefined ? { spent } : {}),
    });
    endRow();
    return {
      verdict: "allow",
      by: "grant",
      reason: step.reason,
      scope: "once",
      why: "owner: let it run once",
    } satisfies GateDecision;
  };

  return {
    decide: decideAction,

    /**
     * A command of the task's checks (BR-1): Oraknid's own, read by the same
     * rules (without layer 1, which reads an agent's commands), a gated
     * action refused. The refusal, or null.
     */
    check(command: string, where: "local" | "server"): string | null {
      return checkRefusal(db, job.id, c.cwd, servers)(command, where);
    },

    /**
     * The Leg's own auto mode refused a call (Claude Code's classifier,
     * ADR-053): in the audit log and the job's events, and counted toward
     * the stuck rule like any other block (bug 7). It can't be held for my
     * answer: I'm asked at its next action, or at the turn's end.
     */
    legRefused(r: PermissionRequest, reason: string) {
      const action = r.command ?? r.path ?? r.tool;
      audit(r, { verdict: "block", layer: "leg", reason });
      c.on.event("task.refused", {
        command: action.slice(0, 300),
        reason,
        drift: null,
        layer: "leg",
      });
      if (r.command) blockedHere.push({ command: r.command, reason, byLeg: true });
      const s = count(
        { action: (r.command ? plain(r.command) : action).slice(0, 200), reason, layer: "leg" },
        r,
        { source: "leg", by: "leg", verdict: "deny", reason },
      );
      if (s) pending = { ...s, by: "leg" };
    },

    /** I let a command run once (ADR-053): a grant, kept until it is used. */
    grantOnce(command: string, reason: string) {
      const grant: Grant = {
        kind: "allow-once",
        scope: "once",
        match: plain(command),
        reason,
        at: c.now(),
      };
      grants.push(grant);
      record(
        null,
        { source: "owner", by: "owner", verdict: "allow", reason, scope: "once", grant },
        grant.match,
      );
      logDecision(bus, job.id, {
        taskId: task.id,
        tool: SHELL_TOOL,
        action: command,
        verdict: "allow",
        layer: "owner",
        reason,
      });
    },

    /** Something from outside came into the task (BR-15): gated actions ask me from now on. */
    markUntrusted,

    /** What was blocked in this attempt, oldest first. */
    blocked: (): readonly { command: string; reason: string; byLeg?: boolean }[] => blockedHere,

    /** A stuck question not raised yet, taken: asked at the turn's end instead. */
    takeStuck(): Pending | null {
      const s = pending;
      pending = null;
      return s;
    },
    /** The stuck question not raised yet, left in place: what the turn's end decides from. */
    peekStuck: (): Pending | null => pending,

    plain,
    askOwner,
    /** How many of my answers the attempt waits for now: waiting on me is no stall. */
    waiting: () => waitingOnOwner,

    /** The attempt ended: what it asked me and I didn't answer goes (bug 9). */
    withdrawAsked() {
      for (const itemId of asked) {
        c.inbox.withdraw(itemId);
        log.append("QuestionAnswered", { itemId, answer: null, withdrawn: true });
      }
      asked.length = 0;
    },

    /**
     * An action the Leg ran without asking (it has no inline gate, ADR-056
     * §2): read by the same rules after the fact — never the judge, never
     * asked, never counted toward the stuck rule — and written to the log.
     * What the rules would have refused or asked me is a forbidden action
     * for the drift ladder (D7). A read, or what was decided before it ran,
     * isn't audited again.
     */
    async afterTheFact(r: PermissionRequest): Promise<"allow" | "forbidden" | null> {
      if (isRead(r.tool) || decidedHere.has(actionKey(r))) return null;
      if (!r.command && !r.path) return null;
      decidedHere.add(actionKey(r));
      const { first } = await rulesOf(r);
      const forbidden = first.verdict === "deny" || first.verdict === "ask";
      const reason = forbidden
        ? `ran without being asked: ${first.reason}`
        : `ran without being asked; the rules ${first.verdict === "judge" ? "leave it to the judge" : "allow it"}: ${first.reason}`;
      record(r, { source: "audit", by: "rule", verdict: forbidden ? "deny" : "allow", reason });
      audit(r, { verdict: forbidden ? "block" : "allow", layer: "rules", reason });
      if (!forbidden) return "allow";
      c.on.forbidden(`ran \`${(r.command ?? r.path ?? r.tool).slice(0, 200)}\` (${first.reason})`);
      c.on.event("task.audited", {
        command: (r.command ?? r.path ?? r.tool).slice(0, 300),
        reason: first.reason,
      });
      return "forbidden";
    },

    /**
     * An action's result came back (ADR-056 §1): one that ran ends the stuck
     * row, also when Claude Code's hook left it to its own classifier, whose
     * "allow" Oraknid only sees here (stage 2's limit). A failed result says
     * nothing: a refusal comes back as one.
     */
    ran(actionId: string, ok: boolean, out?: string) {
      log.append("ActionResult", { actionId, ok, ...(out !== undefined ? { out } : {}) });
      if (ok) endRow();
    },
  };
}

/**
 * A check's command as the Gate reads it (ADR-056 §3), with or without an
 * attempt: the job's rules (no layer 1, which reads an agent's commands), a
 * gated action refused; never asked, never counted. The refusal, or null.
 */
export function checkRefusal(db: Db, jobId: string, cwd: string, servers: JobServerRef[]) {
  return (command: string, where: "local" | "server"): string | null => {
    const policy = policyFor(db, jobId, cwd);
    const rules =
      where === "server"
        ? serverVerdict(command, servers, policy)
        : decide({ tool: SHELL_TOOL, command, path: null }, policy);
    if (!rules) return null;
    const step = gateStep({
      source: "check",
      rules,
      command: true,
      ownBlock: false,
      grants: {},
      autonomy: policy.autonomy,
    });
    return step.verdict === "deny" ? step.reason : null;
  };
}

/** A Gate's decision as the Leg's permission prompt answers it. */
export function asPermission(g: GateDecision): PermissionDecision {
  if (g.verdict === "allow") return g.why ? { allow: true, why: g.why } : { allow: true };
  return {
    allow: false,
    message: g.message ?? `Not allowed: ${g.reason}.`,
    ...(g.why ? { why: g.why } : {}),
  };
}

/** A Gate's decision as Claude Code's PreToolUse hook answers it: null leaves it to the Leg. */
export function asPreTool(g: GateDecision): PreToolDecision {
  if (g.verdict === "ask") return { decision: "ask" };
  if (g.verdict === "deny")
    return { decision: "deny", message: g.message ?? `Not allowed: ${g.reason}.` };
  if (g.leaveToLeg) return null;
  return { decision: "allow", reason: "The owner let it run once." };
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

/**
 * A job that ended (done or cancelled, for good) keeps nothing (Audit 1 →
 * Q1-19; bug 6): its tasks' verdicts and counts in memory, and what they
 * kept across restarts, a task cancelled before it settled included.
 */
export function forgetJob(db: Db, jobId: string) {
  forgetJobVerdicts(jobId);
  for (const t of db.select({ id: tasks.id }).from(tasks).where(eq(tasks.jobId, jobId)).all())
    forgetTaskMemory(db, jobId, t.id, "its job ended");
}
