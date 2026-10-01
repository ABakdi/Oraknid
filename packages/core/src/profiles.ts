import type {
  Capability,
  EffectiveProfile,
  LegKind,
  Observation,
  ProfileSettings,
  StoredProfile,
  Strengths,
  TaskKind,
} from "@oraknid/contracts";

const ALL: Capability[] = [
  "planning",
  "architecture",
  "implementation",
  "debugging",
  "refactor",
  "tests",
  "review",
  "docs",
  "mechanical",
  "summarize",
  "classify",
  "ui",
];

const flat = (n: number, extra: Strengths = {}): Strengths => ({
  ...Object.fromEntries(ALL.map((c) => [c, n])),
  ...extra,
});

const AGENT_TOOLS = { edits: true, shell: true, mcp: true, browse: true };

/**
 * Starting points, by agent and model family. They are deliberately
 * coarse: learning and my overrides refine them.
 */
export function defaultProfile(kind: LegKind, model: string): ProfileSettings {
  const m = model.toLowerCase();
  const base: ProfileSettings = {
    strengths: flat(2),
    contextWindow: null,
    costModel: "local",
    quotaWeight: 1,
    effortMultipliers: { low: 0.6, medium: 1, high: 1.8, xhigh: 2.5, max: 3.5 },
    windowLimits: {},
    prices: null,
    tools: { edits: true, shell: true, mcp: false, browse: false },
    knownFailures: [],
    maxDifficulty: "low",
  };
  if (kind === "claude-code") {
    const claude = {
      ...base,
      costModel: "subscription" as const,
      contextWindow: 200_000,
      tools: AGENT_TOOLS,
    };
    if (m.includes("opus") || m.includes("fable") || m === "default") {
      return {
        ...claude,
        strengths: flat(5, { mechanical: 4, ui: 4 }),
        quotaWeight: 5,
        maxDifficulty: "high",
      };
    }
    if (m.includes("haiku")) {
      return {
        ...claude,
        strengths: flat(2, { mechanical: 4, summarize: 4, classify: 4, docs: 3, tests: 3 }),
        quotaWeight: 1,
        maxDifficulty: "low",
      };
    }
    // Sonnet and anything else.
    return {
      ...claude,
      strengths: flat(4, { planning: 3, architecture: 3 }),
      quotaWeight: 2,
      maxDifficulty: "medium",
    };
  }
  if (kind === "opencode" || kind === "antigravity") {
    return {
      ...base,
      costModel: "subscription",
      tools: AGENT_TOOLS,
      strengths: flat(3),
      maxDifficulty: "medium",
    };
  }
  // A bare local model: good for small, mechanical and text work until it proves otherwise.
  return {
    ...base,
    strengths: flat(1, { mechanical: 3, summarize: 3, classify: 3, docs: 2 }),
    knownFailures: ["may not call tools reliably"],
  };
}

/** Which capability a task kind exercises, for learning from outcomes. */
export const CAPABILITY_OF: Record<TaskKind, Capability> = {
  plan: "planning",
  implement: "implementation",
  test: "tests",
  review: "review",
  research: "planning",
  mechanical: "mechanical",
  external: "mechanical",
};

/** Success rate the default strengths assume: above it a strength rises, below it falls. */
const EXPECTED_SUCCESS = 0.7;

/**
 * Learned strength: the default moved by how the model actually did, at
 * most ±0.5 per 20 attempts and never outside 0–5, so one bad day doesn't
 * rewrite a profile.
 */
export function learnStrength(base: number, o: Observation | undefined): number {
  if (!o || o.attempts === 0) return base;
  const rate = o.successes / o.attempts;
  const cap = 0.5 * Math.floor(o.attempts / 20);
  const shift = Math.max(-cap, Math.min(cap, (rate - EXPECTED_SUCCESS) * 2.5));
  return Math.round(Math.max(0, Math.min(5, base + shift)) * 10) / 10;
}

export function record(
  stored: StoredProfile,
  kind: TaskKind,
  outcome: { success: boolean; tokens: number; ms: number; escalations: number },
): StoredProfile {
  const o = stored.observed[kind] ?? {
    attempts: 0,
    successes: 0,
    tokens: 0,
    ms: 0,
    escalations: 0,
  };
  return {
    ...stored,
    observed: {
      ...stored.observed,
      [kind]: {
        attempts: o.attempts + 1,
        successes: o.successes + (outcome.success ? 1 : 0),
        tokens: o.tokens + outcome.tokens,
        ms: o.ms + outcome.ms,
        escalations: o.escalations + outcome.escalations,
      },
    },
  };
}

/** Defaults, then learned strengths, then my overrides, which always win. */
export function effectiveProfile(
  kind: LegKind,
  model: string,
  stored: StoredProfile,
): EffectiveProfile {
  const d = defaultProfile(kind, model);
  const learned: Strengths = { ...d.strengths };
  for (const [taskKind, cap] of Object.entries(CAPABILITY_OF) as [TaskKind, Capability][]) {
    const base = d.strengths[cap];
    if (base !== undefined) learned[cap] = learnStrength(base, stored.observed[taskKind]);
  }
  const { strengths: overridden, ...otherOverrides } = stored.overrides;
  return {
    ...d,
    ...otherOverrides,
    strengths: { ...learned, ...overridden },
    learned,
    observed: stored.observed,
  };
}

export const emptyStoredProfile = (): StoredProfile => ({ overrides: {}, observed: {} });

/**
 * A window's used share when the provider reports none (Budgets-and-Quotas):
 * my token estimate for the window against what Oraknid counted.
 */
export function estimateUtilization(
  tokensInWindow: number,
  limit: number | undefined,
): number | null {
  if (!limit) return null;
  return Math.min(1, Math.round((tokensInWindow / limit) * 1000) / 1000);
}
