import type {
  Capability,
  Difficulty,
  EffectiveProfile,
  LegHealth,
  TaskKind,
} from "@oraknid/contracts";

// Model-aware routing (The-Eye → Routing, ADR-013, BR-21): the smallest
// model and effort that will reliably do the task, sparing scarce windows.

export interface RouteCandidate {
  legId: string;
  legModelId: string;
  model: string;
  legName: string;
  health: LegHealth;
  paused: boolean;
  /** Supported effort levels, lowest first; empty when the model has none. */
  effortLevels: string[];
  profile: EffectiveProfile;
  /** Every window that applies: the account's and the model's own. */
  windows: { name: string; utilization: number | null; resetsAt: number | null }[];
}

export interface RouteTask {
  kind: TaskKind;
  difficulty: Difficulty;
  requiredCapabilities: Capability[];
  /** Tokens the task's context is expected to need. */
  estimatedTokens: number;
  /** Steps up taken after failures: each one asks for more effort or a stronger model. */
  stepUp: number;
  /** I pinned it: only this Leg model is considered. */
  pinnedModelId?: string | null;
  /** Leg models that already failed this task, avoided unless nothing else is left. */
  avoid?: string[];
}

export interface RouteOptions {
  /** Money may be spent (BR-10); without it, per-token Legs are out. */
  moneyAllowed: boolean;
  /** Below this remaining share, a window's models only take high-difficulty tasks. */
  scarceBelow?: number;
  /** The job's quota-share budget: the share (0–1) of any window it may push a Leg to. */
  quotaShare?: { limit: number; hard: boolean } | null;
  now?: number;
}

export interface Route {
  candidate: RouteCandidate;
  effort: string | null;
  score: number;
  /** Why it scored that way, for the task's routing record. */
  reasons: string[];
}

export interface RouteResult {
  ranked: Route[];
  /** Candidates left out and why, in plain words. */
  excluded: { legModelId: string; why: string }[];
}

const RANK: Record<Difficulty, number> = { low: 0, medium: 1, high: 2 };
const DEFAULT_EFFORT: Record<Difficulty, string[]> = {
  low: ["low", "medium"],
  medium: ["medium", "high"],
  high: ["high", "xhigh", "max"],
};

/** The effort for a difficulty, raised by step-ups, within what the model supports. */
export function chooseEffort(
  levels: string[],
  difficulty: Difficulty,
  stepUp: number,
): string | null {
  if (levels.length === 0) return null;
  const wanted = DEFAULT_EFFORT[difficulty].find((e) => levels.includes(e)) ?? levels[0] ?? null;
  const at = Math.max(0, levels.indexOf(wanted as string));
  return levels[Math.min(levels.length - 1, at + stepUp)] ?? null;
}

export function route(task: RouteTask, candidates: RouteCandidate[], o: RouteOptions): RouteResult {
  const scarceBelow = o.scarceBelow ?? 0.25;
  const now = o.now ?? Date.now();
  const excluded: RouteResult["excluded"] = [];
  const routes: Route[] = [];
  // Each step-up raises the effort; every second one also the difficulty, which moves the task to a stronger model.
  const difficulty = (["low", "medium", "high"] as const)[
    Math.min(2, RANK[task.difficulty] + Math.floor(task.stepUp / 2))
  ] as Difficulty;

  for (const c of candidates) {
    const out = (why: string) =>
      excluded.push({ legModelId: c.legModelId, why: `${c.legName} · ${c.model}: ${why}` });
    if (task.pinnedModelId && c.legModelId !== task.pinnedModelId) continue;
    if (c.paused) {
      out("paused.");
      continue;
    }
    if (c.health !== "healthy" && c.health !== "degraded") {
      out(`${c.health}.`);
      continue;
    }
    const full = c.windows.find(
      (w) => (w.utilization ?? 0) >= 1 && (w.resetsAt ?? Number.POSITIVE_INFINITY) > now,
    );
    if (full) {
      out(`the ${full.name} window is used up.`);
      continue;
    }
    const share = o.quotaShare;
    const over =
      share?.hard &&
      c.windows.find(
        (w) =>
          (w.utilization ?? 0) >= share.limit && (w.resetsAt ?? Number.POSITIVE_INFINITY) > now,
      );
    if (over && share) {
      out(
        `its ${over.name} window is at ${Math.round((over.utilization ?? 0) * 100)}%, and this job may use it up to ${Math.round(share.limit * 100)}%.`,
      );
      continue;
    }
    if (c.profile.costModel === "per-token" && !o.moneyAllowed) {
      out("costs money and this job has no money budget (BR-10).");
      continue;
    }
    const reasons: string[] = [];
    let score = 0;

    // Difficulty fit: too weak is out; far too strong is penalised (BR-21).
    const gap = RANK[c.profile.maxDifficulty] - RANK[difficulty];
    if (gap < 0 && !task.pinnedModelId) {
      out(`made for ${c.profile.maxDifficulty} tasks; this one is ${difficulty}.`);
      continue;
    }
    const window = c.profile.contextWindow;
    if (window && task.estimatedTokens * 1.2 > window) {
      out(`its context window (${window}) is too small for this task.`);
      continue;
    }

    score += gap === 0 ? 3 : gap === 1 ? 1 : -1;
    reasons.push(
      gap === 0 ? "right size for the task" : gap > 0 ? "stronger than the task needs" : "pinned",
    );

    // Scarce windows are kept for hard work.
    const tightest = Math.min(...c.windows.map((w) => 1 - (w.utilization ?? 0)), 1);
    if (tightest < scarceBelow && difficulty !== "high" && !task.pinnedModelId) {
      out(`only ${Math.round(tightest * 100)}% of a window left; kept for hard tasks.`);
      continue;
    }
    score += tightest;
    if (tightest < 1) reasons.push(`${Math.round(tightest * 100)}% of its tightest window left`);

    const strengths = task.requiredCapabilities.map((cap) => c.profile.strengths[cap] ?? 0);
    const capability = strengths.length
      ? strengths.reduce((a, b) => a + b, 0) / strengths.length
      : 0;
    score += capability;
    reasons.push(`capability ${capability.toFixed(1)}/5`);

    const seen = c.profile.observed[task.kind];
    if (seen && seen.attempts >= 3) {
      const rate = seen.successes / seen.attempts;
      score += (rate - 0.7) * 4;
      reasons.push(`${Math.round(rate * 100)}% success on ${task.kind} tasks`);
    }

    const effort = chooseEffort(c.effortLevels, task.difficulty, task.stepUp);
    if (task.stepUp > 0) reasons.push(`stepped up ${task.stepUp}×`);
    const multiplier = effort ? (c.profile.effortMultipliers[effort] ?? 1) : 1;
    const cost = c.profile.quotaWeight * multiplier;
    score -= Math.log2(cost) * 0.6;
    reasons.push(`quota cost ×${cost.toFixed(1)}`);

    if (
      (c.profile.costModel === "local" || c.profile.costModel === "free") &&
      (task.kind === "mechanical" || task.difficulty === "low")
    ) {
      score += 1;
      reasons.push("free for small work");
    }
    if (c.health === "degraded") {
      score -= 1;
      reasons.push("degraded");
    }
    if (task.avoid?.includes(c.legModelId)) {
      score -= 4;
      reasons.push("already failed this task");
    }
    if (
      c.profile.knownFailures.some((f) => f.includes("tools")) &&
      task.kind !== "mechanical" &&
      c.profile.costModel === "local"
    ) {
      score -= 1;
      reasons.push("may not call tools reliably");
    }

    routes.push({ candidate: c, effort, score, reasons });
  }

  const ranked = routes.sort((a, b) => b.score - a.score);
  return { ranked, excluded };
}
