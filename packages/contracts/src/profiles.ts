import { z } from "zod";
import { Capability, Difficulty, TaskKind } from "./entities.ts";

// Capability profiles (docs/01-Specification/Legs-and-Capability-Profiles.md):
// defaults per agent and model, learned values from outcomes, and my
// overrides, which always win.

export const Strengths = z.partialRecord(Capability, z.number().min(0).max(5));
export type Strengths = z.infer<typeof Strengths>;

export const CostModel = z.enum(["subscription", "free", "local", "per-token"]);
export type CostModel = z.infer<typeof CostModel>;

export const Observation = z.object({
  attempts: z.number().int().nonnegative(),
  successes: z.number().int().nonnegative(),
  tokens: z.number().nonnegative(),
  ms: z.number().nonnegative(),
  escalations: z.number().int().nonnegative(),
});
export type Observation = z.infer<typeof Observation>;

export const ProfileSettings = z.object({
  strengths: Strengths,
  contextWindow: z.number().int().positive().nullable(),
  costModel: CostModel,
  /** How fast this model burns the shared window relative to the Leg's cheapest model (ADR-013). */
  quotaWeight: z.number().positive(),
  /** Token multiplier per effort level, e.g. { high: 2 }. */
  effortMultipliers: z.record(z.string(), z.number().positive()),
  /** My estimate of a window's token allowance, used when the provider reports no utilization. */
  windowLimits: z.record(z.string(), z.number().positive()),
  /** Prices per million tokens, for per-token Legs. */
  prices: z.object({ input: z.number(), output: z.number() }).nullable(),
  tools: z.object({
    edits: z.boolean(),
    shell: z.boolean(),
    mcp: z.boolean(),
    browse: z.boolean(),
  }),
  knownFailures: z.array(z.string()),
  /** The highest difficulty this model should take on its own. */
  maxDifficulty: Difficulty,
});
export type ProfileSettings = z.infer<typeof ProfileSettings>;

/** Stored per Leg model: defaults are recomputed, so only learning and overrides persist. */
export const StoredProfile = z.object({
  overrides: ProfileSettings.partial(),
  observed: z.partialRecord(TaskKind, Observation),
});
export type StoredProfile = z.infer<typeof StoredProfile>;

export const EffectiveProfile = ProfileSettings.extend({
  /** Strength values learned from outcomes, before overrides, for the UI to show side by side. */
  learned: Strengths,
  observed: z.partialRecord(TaskKind, Observation),
});
export type EffectiveProfile = z.infer<typeof EffectiveProfile>;
