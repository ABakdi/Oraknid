import {
  budget,
  drift,
  type Observed,
  type OutcomeInput,
  type Review,
  type RouteCandidate,
  repairHintOf,
  type Signal,
  type StopReason,
  saysOwnerNeeded,
  stall,
  stuck,
  type TurnVerdict,
  unusableOf,
  verdictOf,
  type WorkKind,
} from "@oraknid/core";
import type { LegEvent, UsageSnapshot } from "@oraknid/leg-sdk";
import type { AttemptDeps, AttemptJob, TaskRow } from "../eye/attempt.ts";
import { takeGuidance } from "../eye/talk.ts";
import type { Supervised } from "../legs/supervisor.ts";
import { parseSsh } from "../servers/remote.ts";
import type { WorkTree } from "../workspace/tree.ts";
import type { Gate } from "./gate.ts";
import type { AttemptLog } from "./log.ts";
import { stepsOf } from "./record.ts";
import type { CheckReport, RunOptions } from "./verifier.ts";

// What an attempt knows at a turn's end, gathered for `decideOutcome`
// (ADR-056 §6): how the turn stopped, the verdict on its work, what the
// monitors signal, what the agent says it needs, the rung, the history.
// Reading only; `apply.ts` does what the decision says.

export type TurnEnded = Extract<LegEvent, { type: "turn.ended" }>;

/** What an attempt carries from turn to turn: the ladder, what was observed, what was asked. */
export interface AttemptState {
  /** Ladder steps taken since the last verified progress. */
  level: number;
  escalations: string[];
  observed: Observed;
  /** Tokens of the session when progress was last made or a drift was acted on (D6 counts from here). */
  tokensBaseline: number;
  sessionTokens: number;
  usage: UsageSnapshot | null;
  turns: number;
  /** What the agent said it needs of me, asked once each (by command, or its words). */
  ownerAsked: Set<string>;
  /** My messages passed on up to here. */
  guidanceSeen: number;
  /** The log's id after which stuck patterns are read: the last nudge or ladder step. */
  stuckFrom: number;
  /** A stuck pattern was nudged since the last ladder step. */
  nudged: boolean;
  /** Signals written to the log since the last ladder step, by what they say. */
  signalled: Set<string>;
}

/** One turn's end (or none, when looking for a stall), as it is decided. */
export interface Turn {
  end: TurnEnded | null;
  stop: StopReason;
  text: string;
  cutShort: boolean;
  /** The folder's problems when it stopped being a worktree of the project. */
  strayed: { folder: string; problem: string }[];
  /** What the Stop hook ran as it let this turn end: it stands when the work is the same (bug 5). */
  ranAtStop: { verify: string[]; tree: string; report: CheckReport } | null;
  /** The work was verified (its checks run, or reviewed). */
  checked: boolean;
  report: CheckReport | null;
  /** The Eye's review of work without checks; null when it couldn't review. */
  review: Review | null;
  repaired: boolean;
  /** The verdict was put on record. */
  settled: boolean;
  signals: Signal[];
  /** What the agent needs of me, with the command it names. */
  need: { said: string; key: string; command: string | null; blocked: Blocked | null } | null;
  guidance: { text: string | null; mark: number };
}

type Blocked = ReturnType<Gate["blocked"]>[number];

/** What an attempt's turn-end handling works with: the attempt's own parts and side effects. */
export interface AttemptCtx {
  d: AttemptDeps;
  job: AttemptJob;
  task: TaskRow;
  leg: RouteCandidate;
  effort: string | null;
  work: WorkKind;
  ws: { cwd: string; tree: WorkTree; tmpDir: string; trash: string };
  gate: Gate;
  log: AttemptLog;
  trail: ReturnType<AttemptLog["at"]>;
  attemptId: string;
  ckpt: string;
  scopeBase: string;
  signal: AbortSignal;
  servers: { alias: string; name: string }[];
  st: AttemptState;
  event: (type: string, payload: Record<string, unknown>) => void;
  session: () => Supervised | null;
  handOff: (askLeg: boolean, failed?: string) => Promise<void>;
  closeSession: (how?: "close" | "kill" | "stop") => Promise<void>;
  openSession: (prompt: string) => Promise<unknown>;
  /** Waits for the session's turn to end (rotation). */
  turnEnd: (ms: number) => Promise<unknown>;
  runChecks: (commands: string[], o?: RunOptions) => Promise<CheckReport>;
  repairBroken: (
    checked: CheckReport,
    report: string,
    rerun: () => Promise<CheckReport>,
  ) => Promise<CheckReport>;
  treeState: () => Promise<string>;
  /** A higher rung that may take the task now (ADR-052 §3), or none. */
  higher: () => { legName: string; model: string } | null;
  /** A question of mine said in the project's conversation too (ADR-045). */
  conversationAsks: (text: string, questions: unknown[], itemId: string) => unknown;
  scope: () => string[];
}

/**
 * A turn's end begins (or the wait for one timed out): what is known at
 * once — the folder still the project's, how it stopped — said in the
 * job's events as before, and its provider marked working.
 */
export function beginTurn(
  x: AttemptCtx,
  end: TurnEnded | null,
  ranAtStop: Turn["ranAtStop"],
  strayed: () => { folder: string; problem: string }[],
): Turn {
  const t: Turn = {
    end,
    stop: end ? end.reason : "none",
    text: end?.text ?? "",
    cutShort: end?.reason === "max_turns",
    strayed: end ? strayed() : [],
    ranAtStop,
    checked: false,
    report: null,
    review: null,
    repaired: false,
    settled: false,
    signals: [],
    need: null,
    guidance: { text: null, mark: x.st.guidanceSeen },
  };
  if (!end || t.strayed.length) return t;
  // Cut short before it finished (bug 14): stopped by me or its job, the stop goes on.
  if (end.reason === "interrupted") {
    if (x.signal.aborted) throw x.signal.reason;
    x.event("task.turn-interrupted", {});
  }
  if (end.reason === "max_turns") x.event("task.turn-limit", {});
  // A turn went through: its provider works (M13.22).
  if (end.reason === "completed" || end.reason === "max_turns")
    x.d.registry.providerWorked(x.leg.legId, x.leg.legModelId);
  return t;
}

/** The turn's verdict, from its checks or its review, once verified. */
export function verdictFor(x: AttemptCtx, t: Turn): TurnVerdict | null {
  if (!t.checked) return null;
  return verdictOf({
    hasChecks: x.task.verify.length > 0,
    failed: t.report?.failures[0] ?? null,
    review: t.review,
    cutShort: t.cutShort,
    text: t.text,
  });
}

/**
 * The command the agent can't finish without, and my question's key: the
 * blocked one it names, else the last one blocked, else the one its words
 * give (ADR-053).
 */
export function ownerNeedOf(
  x: AttemptCtx,
  report: string,
): Omit<NonNullable<Turn["need"]>, "said"> {
  const aliases = x.servers.map((s) => s.alias);
  const remoteOf = (command: string) =>
    aliases.length ? parseSsh(x.gate.plain(command), aliases) : null;
  const names = (b: { command: string }) => {
    const ssh = remoteOf(b.command);
    return report.includes(b.command) || (!!ssh?.remote && report.includes(ssh.remote.trim()));
  };
  const blockedHere = x.gate.blocked();
  const blocked = [...blockedHere].reverse().find(names) ?? blockedHere.at(-1) ?? null;
  const worded =
    /(?:owner action (?:is )?required|the owner (?:must|needs to|has to|should) run|you (?:can|could|need to) run)\s*:?\s*`?([^`\n]+?)`?\s*(?:$|\n)/i.exec(
      report,
    )?.[1] ?? null;
  const command = blocked?.command ?? worded?.trim() ?? null;
  return { command, blocked, key: command ? x.gate.plain(command) : "" };
}

/** Everything the turn's end is decided from (ADR-056 §6). */
export function factsOf(x: AttemptCtx, t: Turn): OutcomeInput {
  const { st, d } = x;
  const now = d.now();
  const v = verdictFor(x, t);
  t.guidance = takeGuidance(x.job.id, st.guidanceSeen);

  // What it needs of me, when a check fails: its words, or its own auto mode's refusals (bug 7).
  t.need = null;
  const failed = t.report?.failures[0];
  if (v && failed && !t.cutShort) {
    const byLeg = x.gate.peekStuck();
    const said =
      saysOwnerNeeded(t.text) ??
      (byLeg ? `${byLeg.why} by its own auto mode: “${t.text.slice(0, 300)}”` : null);
    if (said) {
      const need = ownerNeedOf(x, t.text);
      t.need = { ...need, said, key: need.key || `said:${said}` };
    }
  }

  // The monitors: over what was observed (with this turn's verdict), and the log.
  const o = st.observed;
  if (!t.end) t.signals = [...drift(o), ...stall(o, now), ...budget(o)];
  else if (v) {
    const after: Observed = {
      ...o,
      verifyFailures:
        v.record.failure === null ? o.verifyFailures : [...o.verifyFailures, v.record.failure],
      falseClaim: v.record.falseClaim ?? o.falseClaim,
    };
    t.signals = [
      ...drift(after),
      ...stall(after, now),
      ...budget(after, undefined, { turns: st.turns, max: d.maxTurns ?? 25 }),
      ...stuck(stepsOf(x.log, x.attemptId, st.stuckFrom)),
    ];
  } else t.signals = [];

  return {
    stop: { reason: t.stop, text: t.text },
    strayed: t.strayed.length ? t.strayed.map((s) => s.problem).join("; ") : null,
    unusable: t.stop === "error" ? unusableOf(t.end?.error ?? null, x.leg.model, now) : null,
    ownerWaiting: x.gate.waiting() > 0,
    // Passed on before the work is verified; what comes after waits for the next turn's end.
    guidance: t.checked ? null : t.guidance.text,
    verdict: v,
    repair: t.report && !t.repaired && d.brain ? repairHintOf(t.report, t.text) : null,
    agentNeeds: t.need ? { said: t.need.said, asked: st.ownerAsked.has(t.need.key) } : null,
    signals: t.signals,
    rung: { higher: v && !v.verified && !t.cutShort ? x.higher() : null },
    history: { turns: st.turns, level: st.level, nudged: st.nudged },
    policy: { maxTurns: d.maxTurns ?? 25, rotateAt: d.rotateAt ?? 0.6 },
    usage: st.usage,
  };
}
