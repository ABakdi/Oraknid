import { claimsDone, type Escalation, nextEscalation, worstDrift } from "../drift.ts";
import { deprecationOf, saysCheckBroken, usageLimitOf } from "../harness.ts";
import { type ProviderFailure, providerFailure } from "../provider-failures.ts";
import { fence } from "../scrub.ts";
import { type TooLarge, tooLargeOf } from "../tokens.ts";
import { type Drift, driftOf, isSuspicion, type Signal, signalKey } from "./monitors.ts";

// The only place an attempt's turn is decided (ADR-056 §6): pure, from the
// facts the attempt gathered — how the turn stopped, the checks' verdict,
// the monitors' signals, what the agent says it needs, the rung, the
// history and the policy — to one Outcome. The attempt does what it says
// (`harness/apply.ts`). Precedence and counting are written here once, and
// nowhere else.

/** How the agent's turn stopped; "none" when it hasn't (the attempt looks for a stall). */
export type StopReason =
  | "completed"
  | "interrupted"
  | "error"
  | "max_turns"
  | "rate-limited"
  | "none";

/** What an agent's own words say makes it unusable for now, not the task failing (ADR-052 §4). */
export type Unusable =
  | { kind: "deprecated"; model: string | null; replacement: string | null }
  | { kind: "limit"; until: number | null; reason: string }
  /** A request larger than the model takes (ADR-066 §1): another model, never a quota. */
  | ({ kind: "too-large" } & TooLarge)
  | { kind: "provider"; failure: ProviderFailure };

/**
 * An end that isn't the task's, read from the agent's own words: a model
 * its provider deprecated (the one named, or none named), a usage limit, its
 * provider or its program failing (and any failure to start). Null: the
 * task's own failure.
 */
export function unusableOf(
  error: string | null,
  model: string,
  now: number,
  atStart = false,
): Unusable | null {
  if (!error) return null;
  const old = deprecationOf(error);
  if (old && (!old.model || model === old.model || model.endsWith(`/${old.model}`)))
    return { kind: "deprecated", ...old };
  const big = tooLargeOf(error);
  if (big) return { ...big, kind: "too-large" };
  const limit = usageLimitOf(error, now);
  if (limit) return { kind: "limit", ...limit };
  const failure =
    providerFailure(error) ??
    (atStart
      ? {
          scope: "leg" as const,
          restMs: 2 * 60_000,
          reason: `could not start: ${error}`.slice(0, 160),
        }
      : null);
  return failure ? { kind: "provider", failure } : null;
}

/** A failed check as the verdict reads it. */
export interface FailedCheck {
  command: string;
  exitCode: number | null;
  output: string;
  signature?: string | null;
}

/** The Eye's review of work without checks (The-Eye → Planning). */
export interface Review {
  accepted: boolean;
  reason: string;
  missing: string[];
}

/** Whether the turn's work is done, and what goes on record of it. */
export interface TurnVerdict {
  verified: boolean;
  /** The failure in words for the agent and the handoff; "" when none. */
  failure: string;
  failed: FailedCheck | null;
  /** Kept for D3 (the same failure again) and D4 (a false claim). */
  record: { failure: string | null; falseClaim: string | null };
}

/**
 * The verdict of a turn: its checks' first failure (`checks`), or The
 * Eye's review when it has none (`review`; null when the review couldn't
 * run, which accepts), or neither. A turn cut at its limit of steps
 * (`cutShort`) isn't done without checks, and its words are no claim.
 */
export function verdictOf(v: {
  hasChecks: boolean;
  failed?: FailedCheck | null;
  review?: Review | null;
  cutShort: boolean;
  text: string;
}): TurnVerdict {
  const out: TurnVerdict = {
    verified: !v.hasChecks && !v.cutShort,
    failure:
      v.cutShort && !v.hasChecks ? "Its turn reached its limit of steps before it finished." : "",
    failed: null,
    record: { failure: null, falseClaim: null },
  };
  if (v.hasChecks) {
    const f = v.failed ?? null;
    out.verified = !f;
    if (f) {
      out.failed = f;
      out.failure = `${fence(f.command)}\nfailed (exit ${f.exitCode}):\n${fence(f.output.slice(-3000))}`;
      out.record.failure = f.signature ?? "";
      if (claimsDone(v.text) && !v.cutShort)
        out.record.falseClaim = `said it was done, but \`${f.command}\` failed`;
    }
  } else if (v.review) {
    out.verified = v.review.accepted;
    if (!v.review.accepted) {
      out.failure = `The Eye reviewed the work: ${v.review.reason}${v.review.missing.length ? `\nStill missing:\n${v.review.missing.map((m) => `- ${m}`).join("\n")}` : ""}`;
      out.record.failure = `evaluate:${v.review.missing.join("|") || v.review.reason}`;
      if (claimsDone(v.text))
        out.record.falseClaim = "said it was done, but the review found work missing";
    }
  }
  return out;
}

/**
 * Whether the first failing check looks broken itself (ADR-052 §2): the
 * Verifier's hint for it, else the agent's words that it is. Null: the
 * work's failure.
 */
export function repairHintOf(
  report: { failures: { command: string }[]; broken: { command: string; hint: string }[] },
  text: string,
): { command: string; hint: string } | null {
  const bad = report.failures[0];
  if (!bad) return null;
  const own = report.broken.find((b) => b.command === bad.command)?.hint ?? null;
  const said = saysCheckBroken(text);
  const hint = own ?? (said ? `the agent says the check is broken: “${said}”` : null);
  return hint ? { command: bad.command, hint } : null;
}

/**
 * A suspicion's verdict as the decision reads it (ADR-056 → Monitors
 * suspect, a model confirms): a by-product of doing the task, drift, not
 * sure (the agent is asked once), or not judged (the judge failed or was
 * too slow: acted on at the gentlest step).
 */
export type Confirmation =
  | { verdict: "expected"; reason: string }
  | { verdict: "drift"; reason: string }
  | { verdict: "unsure"; reason: string; question: string }
  | { verdict: "unjudged"; reason: string };

/** What the drift judge said so far in this attempt. */
export interface Confirming {
  /** Verdicts by the suspicion's `signalKey`. */
  judged: Record<string, Confirmation>;
  /** The codes the agent was already asked about: unsure again, it is acted on gently. */
  asked: string[];
}

/** Everything a turn's end is decided from. */
export interface OutcomeInput {
  stop: { reason: StopReason; text: string };
  /** The job's folder stopped being a worktree of the project: why. */
  strayed: string | null;
  /** What the agent's error says, when it is not the task's. */
  unusable: Unusable | null;
  /** The attempt waits on my answer: no stall. */
  ownerWaiting: boolean;
  /** My messages to the work, not passed on yet. */
  guidance: string | null;
  /** The turn's verdict; null until the work is verified. */
  verdict: TurnVerdict | null;
  /** A failing check that looks broken, while it isn't repaired yet and The Eye can look at it. */
  repair: { command: string; hint: string } | null;
  /** What the agent says it needs of me (`key`: the command or its words), and whether I was asked. */
  agentNeeds: { said: string; asked: boolean } | null;
  signals: Signal[];
  /**
   * The drift judge's verdicts on the suspicions (D1–D6, stuck). Null or
   * left out: there is no judge, and every signal acts as it did before.
   */
  confirm?: Confirming | null;
  /**
   * Actions a restart left uncertain whose effect only the agent can look
   * at (ADR-056 §1): how many are open, whether it was asked already, and
   * the question. Null (or none open) when there is nothing to reconcile.
   */
  uncertain?: { open: number; asked: boolean; question: string } | null;
  rung: { higher: { legName: string; model: string } | null };
  history: {
    turns: number;
    /** Ladder steps taken since the last verified progress. */
    level: number;
    /** A stuck pattern was already nudged in this attempt. */
    nudged: boolean;
  };
  policy: { maxTurns: number; rotateAt: number };
  usage: { contextTokens?: number | null; contextWindow?: number | null } | null;
}

/** A step of the drift ladder that leaves my questions out (the last step asks: AskOwner). */
export type LadderStep = Exclude<Escalation, "ask">;

export type Outcome =
  | { kind: "Done" }
  /** Go on in this session, with these words (none: keep watching). */
  | {
      kind: "Continue";
      why: "guidance" | "self-prompt" | "owner" | "wait" | "watch" | "reconcile" | "confirm";
      feedback: string | null;
      /** The suspicion the judge is unsure of, asked of the agent once (`why: "confirm"`). */
      confirming?: { key: string; code: string };
      /** The context is nearly full: a fresh session with a handoff once this turn ends. */
      rotate?: boolean;
      /** I let this command run once. */
      grant?: string;
      /** A stuck pattern, said to the agent once. */
      nudge?: Signal;
    }
  /** The turn's work is to be verified: its checks, or The Eye's review. */
  | { kind: "Verify" }
  /** The drift judge is to look at these suspicions before anything acts on them; then decide again. */
  | { kind: "Confirm"; signals: Signal[] }
  | { kind: "RepairChecks"; command: string; hint: string }
  | { kind: "AskOwner"; question: "agent-needs"; said: string }
  | {
      kind: "AskOwner";
      question: "keeps-going-wrong";
      drift: Drift;
      level: number;
      failure: string;
    }
  /** Again: in the same session (a turn cut short), or a new attempt as I said. */
  | { kind: "Retry"; session: "same"; feedback: string }
  | {
      kind: "Retry";
      session: "new";
      byOwner: true;
      reason: string;
      advice: string;
      legId?: string | null;
    }
  | { kind: "Climb"; to: { legName: string; model: string }; failure: string }
  | {
      kind: "Escalate";
      step: LadderStep;
      level: number;
      drift: Drift;
      failure: string;
      /** Not confirmed by the judge (it failed, or stayed unsure): the gentlest step, never more. */
      gentle?: true;
    }
  | { kind: "Unavailable"; cause: "limit" | "error" }
  | { kind: "Fail"; why: "strayed" | "error"; reason: string }
  /** Mine to do: the job waits for me. */
  | { kind: "OwnerTakes" }
  | { kind: "LeaveOut"; dependents: boolean }
  | { kind: "CancelJob"; reason: string };

/** Security and scope: a forbidden action, a refused gate tried again, edits outside the scope. */
const SECURITY = new Set(["D7", "D8", "D1"]);

/**
 * The precedence of a turn's end, written once (ADR-056 §6; stage 1's
 * order, kept):
 *
 *  1. not the task's: the folder left the project; a usage limit; the
 *     agent's error that its own words say isn't the task's (else the
 *     error is a failure);
 *  2. a turn cut short (interrupted) isn't judged: it goes on in its
 *     session, unless its turns are spent;
 *  3. my messages to the work go on before anything is checked;
 *  4. the work verified (its checks, or The Eye's review);
 *  5. a failing check that looks broken is repaired, not held against anyone;
 *  6. what the agent says it needs of me is asked before any ladder;
 *  7. security and scope (D7, D8, D1) go to the drift ladder, before any
 *     climb and whether the checks pass or not;
 *  7b. what a restart left uncertain and only the agent can look at is
 *     asked of it once, to look and never run it again (stage 5);
 *  8. done, when verified;
 *  9. a real failure climbs a rung when a higher one exists (ADR-052 §3;
 *     not a turn stopped at its limit of steps);
 * 10. the other drifts (D2–D6) on the rung where it is;
 * 11. the turns spent;
 * 12. at the top: the failure goes back in the session, then the ladder
 *     corrects, resets, steps up, kills and asks me.
 *
 * With no turn's end yet: waiting on me is no stall; any drift goes to
 * the ladder.
 *
 * Wherever drift would act (7, 10, 12's nudge, and with no turn's end),
 * its suspicions are resolved first when there is a judge (`confirm`):
 * `Confirm` the ones not judged, ask the agent once about one the judge is
 * unsure of, drop the expected ones; only confirmed drift, D7 and D8 reach
 * the ladder, and what couldn't be judged is corrected, never more.
 */
export function decideOutcome(i: OutcomeInput): Outcome {
  const failure = i.verdict?.failure ?? "";
  const drifts: Pool = i.signals.flatMap((signal) => {
    const drift = driftOf(signal);
    return drift ? [{ signal, drift }] : [];
  });
  const sifted = (pool: Pool) => sift(pool, i.confirm ?? null);
  const ladder = (pool: Pool, fail: string): Outcome | null => {
    // Suspicions are confirmed before anything acts on them (ADR-056 → Monitors suspect).
    const s = sifted(pool);
    if ("outcome" in s) return s.outcome;
    const drift = worstDrift(s.acting.map((p) => p.drift));
    if (!drift) return null;
    // Not confirmed (the judge failed, or stayed unsure): corrected, never more.
    if (s.gentle.has(drift))
      return {
        kind: "Escalate",
        step: "correct",
        level: Math.max(i.history.level, 1),
        drift,
        failure: fail,
        gentle: true,
      };
    const next = nextEscalation(i.history.level, drift.code);
    if (next.step === "ask")
      return {
        kind: "AskOwner",
        question: "keeps-going-wrong",
        drift,
        level: next.level,
        failure: fail,
      };
    return { kind: "Escalate", step: next.step, level: next.level, drift, failure: fail };
  };

  if (i.stop.reason === "none") {
    if (i.ownerWaiting) return { kind: "Continue", why: "wait", feedback: null };
    return ladder(drifts, "") ?? { kind: "Continue", why: "watch", feedback: null };
  }

  // 1. Not the task's.
  if (i.strayed) return { kind: "Fail", why: "strayed", reason: i.strayed };
  if (i.stop.reason === "rate-limited") return { kind: "Unavailable", cause: "limit" };
  if (i.stop.reason === "error")
    return i.unusable
      ? { kind: "Unavailable", cause: "error" }
      : { kind: "Fail", why: "error", reason: "the agent failed" };

  // 2. Cut short before it finished: not a turn to judge (bug 14).
  if (i.stop.reason === "interrupted") {
    if (i.history.turns >= i.policy.maxTurns)
      return (
        ladder(
          [
            {
              signal: null,
              drift: {
                code: "D6",
                evidence: `took ${i.history.turns} turns without finishing one`,
              },
            },
          ],
          "",
        ) ?? unreachable()
      );
    return {
      kind: "Retry",
      session: "same",
      feedback:
        "Your last turn was interrupted before it finished. Go on with the task where you were; say DONE when it is finished.",
    };
  }
  const cutShort = i.stop.reason === "max_turns";

  // 3. My messages, before any check.
  if (i.guidance) return { kind: "Continue", why: "guidance", feedback: i.guidance };

  // 4. Verified.
  if (!i.verdict) return { kind: "Verify" };
  // 5. A broken check is The Eye's.
  if (i.repair) return { kind: "RepairChecks", ...i.repair };
  // 6. What it needs of me (bug 7, ADR-053).
  if (i.agentNeeds && !i.agentNeeds.asked && !cutShort)
    return { kind: "AskOwner", question: "agent-needs", said: i.agentNeeds.said };

  // 7. Security and scope first, before any climb (bug 13) and when the checks pass too: a
  // forbidden action or a refused gate tried again is never "done" (the worst drift is theirs).
  // Scope (D1) only once the judge confirms it; D7 and D8 at once.
  const security = drifts.filter((p) => SECURITY.has(p.drift.code));
  const guarded = security.length ? ladder(security, failure) : null;
  if (guarded) return guarded;

  // 7b. What a restart left uncertain and only the agent can look at (ADR-056 §1): asked once,
  // to look and never run it again, before the work is done or climbs.
  if (i.uncertain && i.uncertain.open > 0 && !i.uncertain.asked)
    return { kind: "Continue", why: "reconcile", feedback: i.uncertain.question };

  // 8. Done.
  if (i.verdict.verified) return { kind: "Done" };

  // 9. A real failure climbs a rung while a higher one exists (ADR-052 §3); a turn cut at its
  // limit of steps isn't its answer: it goes on in its session first.
  if (!cutShort && i.rung.higher) return { kind: "Climb", to: i.rung.higher, failure };

  // 10. The other drifts (D2–D6), on the rung where it is; going round in circles after a
  // nudge is a repetition (D2).
  const seen = i.signals.find((s) => s.kind === "stuck");
  const circling: Pool =
    seen && i.history.nudged
      ? [{ signal: seen, drift: { code: "D2", evidence: seen.evidence } }]
      : [];
  const step = ladder([...drifts.filter((p) => !SECURITY.has(p.drift.code)), ...circling], failure);
  if (step) return step;

  // 11. The turns spent.
  if (i.history.turns >= i.policy.maxTurns)
    return (
      ladder(
        [
          {
            signal: null,
            drift: {
              code: "D6",
              evidence: `took ${i.history.turns} turns without passing verification`,
            },
          },
        ],
        "",
      ) ?? unreachable()
    );

  // 12. Self-prompting: the exact failure goes back (The-Eye → Self-prompting); going round in
  // circles (confirmed by the judge when there is one), it is nudged once.
  let stuck: Signal | undefined;
  if (seen) {
    const s = sifted([{ signal: seen, drift: { code: "D2", evidence: seen.evidence } }]);
    if ("outcome" in s) return s.outcome;
    if (s.acting.length) stuck = seen;
  }
  const feedback = cutShort
    ? `Your turn reached its limit of steps before you finished.${i.verdict.failed ? ` Oraknid ran the checks and the task is not done yet:\n${failure}\n` : " "}Go on with the task, then say DONE.`
    : `Oraknid ran the checks and the task is not done yet.\n${failure}\nFix it, then say DONE.`;
  return {
    kind: "Continue",
    why: "self-prompt",
    feedback: stuck ? `${feedback}\n\n${nudgeText(stuck)}` : feedback,
    rotate: shouldRotate(i.usage, i.policy.rotateAt),
    ...(stuck ? { nudge: stuck } : {}),
  };
}

/** Drifts the ladder may act on, each with the signal it came from (none: a limit of the attempt's). */
type Pool = { signal: Signal | null; drift: Drift }[];

/**
 * The suspicions among drifts resolved before the ladder acts (ADR-056 →
 * Monitors suspect, a model confirms): any not judged yet are to be
 * confirmed; one the judge is unsure of is asked of the agent once; those
 * judged expected are dropped; drift acts, and what couldn't be judged acts
 * gently. D7, D8 and the attempt's limits always act. With no judge, all act.
 */
function sift(
  pool: Pool,
  c: Confirming | null,
): { outcome: Outcome } | { acting: Pool; gentle: Set<Drift> } {
  const gentle = new Set<Drift>();
  if (!c) return { acting: pool, gentle };
  // A hard rule (D7, D8, a limit) acts at once; the suspicions wait their turn.
  const hard = pool.filter((p) => !p.signal || !isSuspicion(p.signal));
  if (hard.length) return { acting: hard, gentle };
  const suspected = pool.filter(
    (p): p is { signal: Signal; drift: Drift } => !!p.signal && isSuspicion(p.signal),
  );
  const pending = suspected.filter((p) => !c.judged[signalKey(p.signal)]).map((p) => p.signal);
  if (pending.length) return { outcome: { kind: "Confirm", signals: [...new Set(pending)] } };
  for (const p of suspected) {
    const key = signalKey(p.signal);
    const v = c.judged[key];
    if (v?.verdict === "unsure" && !c.asked.includes(p.signal.code))
      return {
        outcome: {
          kind: "Continue",
          why: "confirm",
          feedback: v.question,
          confirming: { key, code: p.signal.code },
        },
      };
  }
  const acting = pool.filter((p) => {
    if (!p.signal || !isSuspicion(p.signal)) return true;
    const v = c.judged[signalKey(p.signal)];
    if (v?.verdict === "expected") return false;
    if (v?.verdict !== "drift") gentle.add(p.drift);
    return true;
  });
  return { acting, gentle };
}

/** The nudge for a stuck pattern, said once before the ladder acts on it. */
export const nudgeText = (s: Signal) =>
  `Oraknid noticed: you ${s.evidence}. You seem to be going round in circles: stop, read the last result carefully, and try a different approach.`;

function unreachable(): never {
  throw new Error("the ladder has a step for every drift");
}

/** The context window past its share (BR-3): time for a fresh session. */
export function shouldRotate(u: OutcomeInput["usage"], at: number): boolean {
  return !!u?.contextTokens && !!u.contextWindow && u.contextTokens > u.contextWindow * at;
}

// ── My answers ──────────────────────────────────────────────────────

/** The other answers when the agent says it can't finish without me (the first: the Gate's Allow). */
export const ILL_DO_IT = "I'll do it";
export const LEAVE_IT_OUT = "Leave it out";
export const STOP_JOB = "Stop the job";

/**
 * My answer to what the agent needs: allowed, the command it names runs
 * once and it goes on; my own words go to it; the task mine, left out, or
 * the job stopped.
 */
export function agentNeedsAnswer(
  answer: string,
  command: string | null,
  task: string,
  allow: string,
): Outcome {
  if (answer === allow && command)
    return {
      kind: "Continue",
      why: "owner",
      grant: command,
      feedback: `The owner allows \`${command}\` to run once. Run it now exactly as written, then finish the task and say DONE.`,
    };
  if (answer === ILL_DO_IT) return { kind: "OwnerTakes" };
  if (answer === LEAVE_IT_OUT) return { kind: "LeaveOut", dependents: true };
  if (answer === STOP_JOB)
    return { kind: "CancelJob", reason: `Stopped by me: "${task}" couldn't finish without me.` };
  return { kind: "Continue", why: "owner", feedback: `The owner answers: ${answer}` };
}

/** My choice when a task keeps going wrong (eye/questions.ts reads it from my answer). */
export type WrongChoiceRead =
  | { kind: "advice"; advice: string }
  | { kind: "another-leg"; legId: string | null; advice: string; legName?: string | null }
  | { kind: "mine" }
  | { kind: "leave-out"; dependents: boolean }
  | { kind: "stop" };

/** My answer to "keeps going wrong", as an outcome. */
export function keepsGoingWrongAnswer(choice: WrongChoiceRead, task: string): Outcome {
  switch (choice.kind) {
    case "mine":
      return { kind: "OwnerTakes" };
    case "leave-out":
      return { kind: "LeaveOut", dependents: choice.dependents };
    case "stop":
      return {
        kind: "CancelJob",
        reason: `Stopped by me after "${task}" kept going wrong; the work so far stays on its branch.`,
      };
    case "another-leg":
      return {
        kind: "Retry",
        session: "new",
        byOwner: true,
        advice: choice.advice,
        legId: choice.legId,
        reason: choice.legId
          ? `given to ${choice.legName ?? "another Leg"} by me`
          : "given to another Leg by me",
      };
    case "advice":
      return {
        kind: "Retry",
        session: "new",
        byOwner: true,
        advice: choice.advice,
        reason: choice.advice ? "retrying with my advice" : "retrying, as I asked",
      };
  }
}

// ── Counting ────────────────────────────────────────────────────────

/** How an attempt is recorded. */
export type AttemptRecord =
  | "succeeded"
  | "failed"
  | "reassigned"
  | "redirected"
  | "abandoned"
  | "unavailable";

/** Only these spend the task's limit of attempts: real failures (ADR-056 §6). */
export const SPENDS_ATTEMPT: readonly AttemptRecord[] = ["failed", "reassigned"];

/** An attempt's end, as counted. */
export type Ending =
  | Outcome
  /** Its agent couldn't start a session: not the task's. */
  | { kind: "CouldNotStart" }
  /** Stopped by me, its job or its Leg (a pause, a cancel, a restart). */
  | { kind: "Stopped"; byJob: boolean };

/**
 * Counting, written once (ADR-056 §6): how each end is recorded, whether
 * it spends the task's attempts, and whether the model's record learns
 * from it. My choices are never the model's failure (bug 11); my "try
 * again" spends nothing (bug 10); an agent out of use isn't learned from.
 */
export function countOf(e: Ending): {
  record: AttemptRecord;
  success: boolean;
  learn: boolean;
  spends: boolean;
} {
  const as = (record: AttemptRecord, learn: boolean) => ({
    record,
    success: record === "succeeded",
    learn,
    spends: SPENDS_ATTEMPT.includes(record),
  });
  switch (e.kind) {
    case "Done":
      return as("succeeded", true);
    case "Fail":
    case "Climb":
      return as("failed", true);
    case "Escalate":
      return as("reassigned", true);
    case "Unavailable":
    case "CouldNotStart":
      return as("unavailable", false);
    case "Retry":
      return e.session === "new" ? as("redirected", false) : as("abandoned", true);
    case "OwnerTakes":
    case "LeaveOut":
    case "CancelJob":
    case "AskOwner":
      return as("abandoned", false);
    case "Stopped":
      return as("abandoned", !e.byJob);
    default:
      return as("abandoned", true);
  }
}
