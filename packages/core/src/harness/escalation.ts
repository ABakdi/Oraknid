import { type DriftCode, type Escalation, nextEscalation } from "../drift.ts";

// The escalation policy (ADR-056 §7), pure: the next rung of the ladder
// for a task's kind of work (ADR-052 §3), the next step of the drift
// ladder (Drift-Control), and whether an attempt's result is stale.

/**
 * The rung above the current one, from the routes ranked for the task
 * without the model that just failed it: the first on a higher rung.
 * "top" when there is none, and for a task I pinned to a model or gave to
 * a Leg (`held`): those don't climb.
 */
export function nextRung<R extends { rung?: number }>(
  current: number,
  ranked: readonly R[],
  held: boolean,
): R | "top" {
  if (held) return "top";
  return ranked.find((r) => (r.rung ?? 0) > current) ?? "top";
}

/** The drift ladder's next step for a drift, from the steps already taken. */
export function nextStep(level: number, drift: DriftCode): { step: Escalation; level: number } {
  return nextEscalation(level, drift);
}

/**
 * A result from an attempt that is no longer the task's latest, or whose
 * outcome was already applied, is dropped: a later attempt started (its
 * number is higher), or the task settled this one.
 */
export function isStale(
  attemptNo: number,
  task: { attemptCount: number; settledAttempt: number },
): boolean {
  return attemptNo < task.attemptCount || attemptNo <= task.settledAttempt;
}

export const EscalationPolicy = { next: nextRung, step: nextStep, stale: isStale };
