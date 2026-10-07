import {
  budget,
  DEFAULT_THRESHOLDS,
  type Drift,
  type DriftCode,
  type DriftThresholds,
  drift,
  driftOf,
  type Observed,
  stall,
} from "./harness/monitors.ts";

// Drift detectors D1–D8 and the escalation ladder (docs/01-Specification/Drift-Control.md).
// The detectors are the monitors' (harness/monitors.ts, ADR-056 §5); `detect` reads them as drifts.

export type { Drift, DriftCode, DriftThresholds, Observed };
export { DEFAULT_THRESHOLDS };

const ORDER: DriftCode[] = ["D1", "D2", "D3", "D4", "D5", "D6", "D7", "D8"];

/** Every drift seen, D1 to D8 in order: the drift, stall and budget monitors together. */
export function detect(o: Observed, now: number, t: DriftThresholds = DEFAULT_THRESHOLDS): Drift[] {
  return [...drift(o, t), ...stall(o, now, t), ...budget(o, t)]
    .map(driftOf)
    .filter((d): d is Drift => d !== null)
    .sort((a, b) => ORDER.indexOf(a.code) - ORDER.indexOf(b.code));
}

/** The drifts by how much they matter, the worst first: security, scope, a false claim… */
export const SEVERITY: DriftCode[] = ["D8", "D7", "D1", "D4", "D3", "D2", "D6", "D5"];

/** The worst of some drifts, by SEVERITY; the first seen among equals. */
export const worstDrift = (drifts: Drift[]): Drift | null =>
  [...drifts].sort((a, b) => SEVERITY.indexOf(a.code) - SEVERITY.indexOf(b.code))[0] ?? null;

/** A claim of being done, in a Leg's final words. */
export const claimsDone = (text: string) =>
  /\b(done|complete[d]?|finished|all (the )?tests (now )?pass(ing)?|tests (are )?(now )?passing|implemented)\b/i.test(
    text,
  );

// ── The escalation ladder ───────────────────────────────────────────

export type Escalation = "correct" | "reset" | "step-up" | "reassign" | "kill" | "ask";

/**
 * The step for a task's next drift (Drift-Control → The escalation
 * ladder). `level` is how many steps were already taken since the last
 * verified progress. D8 skips straight to killing. Step 3 steps up when
 * the task looks too hard for the model, otherwise reassigns.
 */
export function nextEscalation(
  level: number,
  drift: DriftCode,
): { step: Escalation; level: number } {
  if (drift === "D8") return { step: "kill", level: Math.max(level, 3) + 1 };
  const next = level + 1;
  switch (next) {
    case 1:
      return { step: "correct", level: next };
    case 2:
      return { step: "reset", level: next };
    case 3:
      return {
        step: drift === "D3" || drift === "D4" || drift === "D6" ? "step-up" : "reassign",
        level: next,
      };
    case 4:
      return { step: "kill", level: next };
    default:
      return { step: "ask", level: next };
  }
}

/** The corrective prompt of step 1: what was seen, and what is expected instead. */
export function correctivePrompt(d: Drift, scope: string[], verify: string[]): string {
  const expect: Record<DriftCode, string> = {
    D1: `Only change files in: ${scope.join(", ")}. The out-of-scope changes were reverted.`,
    D2: "You are repeating yourself. Stop, read the error carefully, and try a different approach.",
    D3: "The same check keeps failing. Find the root cause before changing more code.",
    D4: `Do not say the task is done until these pass when you run them: ${verify.map((v) => `\`${v}\``).join(", ")}.`,
    D5: "You stopped making progress. Continue the task, or say exactly what blocks you.",
    D6: "You have used many tokens without verified progress. Make a smaller, checkable step.",
    D7: "That command is never allowed. Find another way that stays inside the workspace.",
    D8: "That action needs my approval and was not approved.",
  };
  return `Oraknid noticed: you ${d.evidence}.\n${expect[d.code]}`;
}
