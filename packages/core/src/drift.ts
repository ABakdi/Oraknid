import { oraknidOwn } from "./harness.ts";
import { inScope } from "./web.ts";

// Drift detectors D1–D8 and the escalation ladder (docs/01-Specification/Drift-Control.md).

export type DriftCode = "D1" | "D2" | "D3" | "D4" | "D5" | "D6" | "D7" | "D8";

export interface Drift {
  code: DriftCode;
  /** What was seen, specific enough to show me and to put in a corrective prompt. */
  evidence: string;
}

export interface DriftThresholds {
  repeats: number;
  repeatWindow: number;
  sameFailure: number;
  stallMs: number;
  burnShare: number;
  burnTokens: number;
}

export const DEFAULT_THRESHOLDS: DriftThresholds = {
  repeats: 3,
  repeatWindow: 10,
  sameFailure: 3,
  stallMs: 5 * 60_000,
  burnShare: 0.3,
  burnTokens: 150_000,
};

/** What The Eye has seen of a task's current attempt. */
export interface Observed {
  scope: string[];
  /** Paths changed in the worktree, relative to it. */
  changedPaths: string[];
  /** Commands in order, each with an output fingerprint. */
  commands: { command: string; outputHash: string }[];
  /** Verification failure signatures, in order. */
  verifyFailures: string[];
  /** The Leg claimed done and verification then failed, or the claimed command never ran. */
  falseClaim: string | null;
  lastActivityAt: number;
  /** Tokens spent since the last verified progress. */
  tokensSinceProgress: number;
  taskBudgetTokens: number | null;
  /** Policy refusals: forbidden commands and gated actions tried without approval. */
  forbidden: string[];
  gateBypass: string[];
  local: boolean;
}

export function detect(o: Observed, now: number, t: DriftThresholds = DEFAULT_THRESHOLDS): Drift[] {
  const found: Drift[] = [];

  // Oraknid's own files (its folder, the handoff note it asked for) are never drift (ADR-052).
  const outside = o.changedPaths.filter((p) => !oraknidOwn(p) && !inScope(p, o.scope));
  if (outside.length)
    found.push({
      code: "D1",
      evidence: `changed files outside its scope: ${outside.slice(0, 5).join(", ")}`,
    });

  const recent = o.commands.slice(-t.repeatWindow);
  const counts = new Map<string, number>();
  for (const c of recent)
    counts.set(
      `${c.command}\u0000${c.outputHash}`,
      (counts.get(`${c.command}\u0000${c.outputHash}`) ?? 0) + 1,
    );
  const loop = [...counts].find(([, n]) => n >= t.repeats);
  if (loop) {
    found.push({
      code: "D2",
      evidence: `ran \`${loop[0].split("\u0000")[0]}\` ${loop[1]} times with the same result`,
    });
  }

  const tail = o.verifyFailures.slice(-t.sameFailure);
  if (tail.length >= t.sameFailure && tail.every((s) => s === tail[0])) {
    found.push({
      code: "D3",
      evidence: `verification failed the same way ${t.sameFailure} times: ${tail[0]}`,
    });
  }

  if (o.falseClaim) found.push({ code: "D4", evidence: o.falseClaim });

  const stall = o.local ? t.stallMs * 2 : t.stallMs;
  if (now - o.lastActivityAt > stall) {
    found.push({
      code: "D5",
      evidence: `no output, edit or tool call for ${Math.round((now - o.lastActivityAt) / 60_000)} min`,
    });
  }

  const limit = o.taskBudgetTokens ? o.taskBudgetTokens * t.burnShare : t.burnTokens;
  if (o.tokensSinceProgress > limit) {
    found.push({
      code: "D6",
      evidence: `${o.tokensSinceProgress} tokens since the last verified progress`,
    });
  }

  for (const f of o.forbidden) found.push({ code: "D7", evidence: f });
  for (const g of o.gateBypass) found.push({ code: "D8", evidence: g });
  return found;
}

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
