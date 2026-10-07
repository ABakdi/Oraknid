import { oraknidOwn } from "../harness.ts";
import { inScope } from "../web.ts";

// The monitors (ADR-056 §5): pure functions over what an attempt did — its
// log's actions, results and words, and what The Eye observed of its work —
// to `Signal`s. They never act: `decideOutcome` reads the signals, the
// attempt writes each new one to its log. Stuck is OpenHands' patterns
// over the log; drift is D1–D8 (Drift-Control.md); budget is the tokens
// and turns spent without progress; stall is no activity at all.

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

/** Stuck's patterns, after OpenHands' stuck detector. */
export type StuckPattern = "repeat" | "error" | "talk" | "alternate";

/** What a monitor saw. `code`: the drift (D1–D8), the stuck pattern, or "turns" for the turn budget. */
export type Signal =
  | { kind: "drift"; code: DriftCode; evidence: string }
  | { kind: "stall"; code: "D5"; evidence: string }
  | { kind: "budget"; code: "D6" | "turns"; evidence: string }
  | { kind: "stuck"; code: StuckPattern; evidence: string };

// ── Drift: D1–D4, D7, D8 ─────────────────────────────────────────────

/** Scope, repetition, the same failure, a false claim, forbidden actions, a refused gate tried again. */
export function drift(o: Observed, t: DriftThresholds = DEFAULT_THRESHOLDS): Signal[] {
  const found: Signal[] = [];
  // Oraknid's own files (its folder, the handoff note it asked for) are never drift (ADR-052).
  const outside = o.changedPaths.filter((p) => !oraknidOwn(p) && !inScope(p, o.scope));
  if (outside.length)
    found.push({
      kind: "drift",
      code: "D1",
      evidence: `changed files outside its scope: ${outside.slice(0, 5).join(", ")}`,
    });

  const recent = o.commands.slice(-t.repeatWindow);
  const counts = new Map<string, number>();
  for (const c of recent) {
    const key = `${c.command}\u0000${c.outputHash}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const loop = [...counts].find(([, n]) => n >= t.repeats);
  if (loop)
    found.push({
      kind: "drift",
      code: "D2",
      evidence: `ran \`${loop[0].split("\u0000")[0]}\` ${loop[1]} times with the same result`,
    });

  const tail = o.verifyFailures.slice(-t.sameFailure);
  if (tail.length >= t.sameFailure && tail.every((s) => s === tail[0]))
    found.push({
      kind: "drift",
      code: "D3",
      evidence: `verification failed the same way ${t.sameFailure} times: ${tail[0]}`,
    });

  if (o.falseClaim) found.push({ kind: "drift", code: "D4", evidence: o.falseClaim });
  for (const f of o.forbidden) found.push({ kind: "drift", code: "D7", evidence: f });
  for (const g of o.gateBypass) found.push({ kind: "drift", code: "D8", evidence: g });
  return found;
}

// ── Stall: D5 ────────────────────────────────────────────────────────

/** No output, edit or tool call for too long; a local model gets twice as long. */
export function stall(o: Observed, now: number, t: DriftThresholds = DEFAULT_THRESHOLDS): Signal[] {
  const limit = o.local ? t.stallMs * 2 : t.stallMs;
  if (now - o.lastActivityAt <= limit) return [];
  return [
    {
      kind: "stall",
      code: "D5",
      evidence: `no output, edit or tool call for ${Math.round((now - o.lastActivityAt) / 60_000)} min`,
    },
  ];
}

// ── Budget: D6, and the turns ────────────────────────────────────────

/**
 * Tokens since the last verified progress past the task's share (D6), and,
 * when `turns` is given, the attempt's turns at its limit.
 */
export function budget(
  o: Pick<Observed, "tokensSinceProgress" | "taskBudgetTokens">,
  t: DriftThresholds = DEFAULT_THRESHOLDS,
  turns?: { turns: number; max: number },
): Signal[] {
  const found: Signal[] = [];
  const limit = o.taskBudgetTokens ? o.taskBudgetTokens * t.burnShare : t.burnTokens;
  if (o.tokensSinceProgress > limit)
    found.push({
      kind: "budget",
      code: "D6",
      evidence: `${o.tokensSinceProgress} tokens since the last verified progress`,
    });
  if (turns && turns.turns >= turns.max)
    found.push({ kind: "budget", code: "turns", evidence: `took ${turns.turns} turns` });
  return found;
}

// ── Stuck: OpenHands' patterns over the log ──────────────────────────

/** One step of an attempt as the log has it: an action, its result, the agent's words at a turn's end. */
export type Step =
  | { kind: "action"; id: string; action: string }
  | { kind: "result"; id: string; ok: boolean; out?: string | null }
  | { kind: "text"; text: string };

export interface StuckThresholds {
  /** The same action with the same result, in a row. */
  repeat: number;
  /** The same action failing, in a row. */
  errors: number;
  /** Turns of words with no action between them. */
  talk: number;
  /** Two actions taking turns, steps in all (A B A B A B). */
  alternate: number;
}

export const STUCK_THRESHOLDS: StuckThresholds = { repeat: 4, errors: 3, talk: 3, alternate: 6 };

type Item =
  | { kind: "action"; action: string; result: string | null; ok: boolean | null }
  | { kind: "text" };

/**
 * Whether the agent is going round in circles (OpenHands' stuck detector):
 * the same action with the same result again and again; the same action
 * failing again and again; turns of words with no action; two actions
 * taking turns with the same results. Read over the steps given (the
 * attempt's, since the last nudge or ladder step). Empty when none.
 */
export function stuck(steps: Step[], t: StuckThresholds = STUCK_THRESHOLDS): Signal[] {
  const items: Item[] = [];
  const byId = new Map<string, Extract<Item, { kind: "action" }>>();
  for (const s of steps) {
    if (s.kind === "action") {
      const it = { kind: "action" as const, action: s.action, result: null, ok: null };
      items.push(it);
      byId.set(s.id, it);
    } else if (s.kind === "result") {
      const it = byId.get(s.id);
      if (it) {
        it.result = `${s.ok}:${s.out ?? ""}`;
        it.ok = s.ok;
      }
    } else items.push({ kind: "text" });
  }
  const actions = (n: number) => {
    const tail = items.slice(-n);
    return tail.length === n && tail.every((i) => i.kind === "action" && i.result !== null)
      ? (tail as Extract<Item, { kind: "action" }>[])
      : null;
  };
  const found: Signal[] = [];
  const errors = actions(t.errors);
  if (errors?.every((i) => i.action === errors[0]?.action && i.ok === false))
    found.push({
      kind: "stuck",
      code: "error",
      evidence: `ran \`${errors[0]?.action}\` ${t.errors} times in a row and it failed each time`,
    });
  const same = actions(t.repeat);
  if (
    same?.every((i) => i.action === same[0]?.action && i.result === same[0]?.result) &&
    !found.length
  )
    found.push({
      kind: "stuck",
      code: "repeat",
      evidence: `ran \`${same[0]?.action}\` ${t.repeat} times in a row with the same result`,
    });
  const talk = items.slice(-t.talk);
  if (talk.length === t.talk && talk.every((i) => i.kind === "text"))
    found.push({
      kind: "stuck",
      code: "talk",
      evidence: `ended ${t.talk} turns in a row with words and no action`,
    });
  const alt = actions(t.alternate);
  if (
    alt &&
    alt[0]?.action !== alt[1]?.action &&
    alt.every(
      (i, n) => n < 2 || (i.action === alt[n - 2]?.action && i.result === alt[n - 2]?.result),
    )
  )
    found.push({
      kind: "stuck",
      code: "alternate",
      evidence: `went back and forth between \`${alt[0]?.action}\` and \`${alt[1]?.action}\` ${t.alternate / 2} times`,
    });
  return found;
}

// ── Together ─────────────────────────────────────────────────────────

/** The drift a signal stands for on the ladder (Drift-Control); none for the turn budget or stuck. */
export function driftOf(s: Signal): Drift | null {
  if (s.kind === "stuck" || s.code === "turns") return null;
  return { code: s.code, evidence: s.evidence };
}
