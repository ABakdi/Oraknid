import { z } from "zod";
import { Id, Timestamp } from "./common.ts";
import { LegHealth, LegKind, QuotaWindow } from "./entities.ts";
import { EffectiveProfile, ProfileSettings, Strengths } from "./profiles.ts";

// The Leg registry's API shapes (docs/01-Specification/Legs-and-Capability-Profiles.md).

export const ClaudeCodeLegConfig = z.object({
  /** The official binary. */
  binary: z.string().min(1).default("claude"),
  /** The account's config directory, which I log into myself (ADR-009). Created when empty. */
  configDir: z.string().min(1).optional(),
});

export const OpenAICompatibleLegConfig = z.object({
  baseUrl: z.url(),
  maxToolCalls: z.number().int().positive().optional(),
  commandTimeoutMs: z.number().int().positive().optional(),
});

/**
 * An OpenCode Leg (ADR-015). With no provider, it uses OpenCode's own free
 * models (OpenCode Zen), as the installed OpenCode does: no account, no key.
 * Never a Claude subscription.
 */
export const OpenCodeLegConfig = z.object({
  binary: z.string().min(1).default("opencode"),
  /** Another provider's id inside OpenCode, e.g. "openrouter"; empty for the free models. */
  providerID: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and dashes")
    .optional(),
  /** The AI SDK package; OpenAI-compatible by default. */
  package: z.string().min(1).default("@opencode/ai/providers/openai-compatible"),
  baseURL: z.url().optional(),
  /** The provider's models; for the free models, found by the test. */
  models: z.array(z.string().min(1)).default([]),
  contextWindow: z.number().int().positive().optional(),
});

/**
 * An Antigravity Leg (ADR-020): the official `agy`, signed in from its
 * card. Its models come from `agy models`; `models` is the fallback.
 */
export const AntigravityLegConfig = z.object({
  binary: z.string().min(1).default("agy"),
  models: z.array(z.string().min(1)).default([]),
});

export const NewLeg = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("claude-code"),
    name: z.string().min(1),
    config: ClaudeCodeLegConfig,
  }),
  z.object({
    kind: z.literal("openai-compatible"),
    name: z.string().min(1),
    config: OpenAICompatibleLegConfig,
    /** An API key, if the server needs one. Goes to the secret store, never the database. */
    secret: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal("opencode"),
    name: z.string().min(1),
    config: OpenCodeLegConfig,
    /** The provider's API key. Goes to the secret store, never the database. */
    secret: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal("antigravity"),
    name: z.string().min(1),
    config: AntigravityLegConfig,
  }),
]);
export type NewLeg = z.infer<typeof NewLeg>;

export const LegModelView = z.object({
  id: Id,
  model: z.string(),
  displayName: z.string(),
  hidden: z.boolean(),
  effortLevels: z.array(z.string()),
  quota: z.array(QuotaWindow),
  profile: EffectiveProfile,
  /** VRAM held right now, for local models a server reports (Ollama /api/ps). */
  vramBytes: z.number().int().nonnegative().nullable(),
});
export type LegModelView = z.infer<typeof LegModelView>;

export const LegView = z.object({
  id: Id,
  name: z.string(),
  kind: LegKind,
  config: z.record(z.string(), z.unknown()),
  hasSecret: z.boolean(),
  enabled: z.boolean(),
  paused: z.boolean(),
  health: LegHealth,
  healthDetail: z.string().nullable(),
  limitedUntil: Timestamp.nullable(),
  /** Where the work runs: the provider sees what remote Legs read (Data-Map). */
  remote: z.boolean(),
  quota: z.array(QuotaWindow),
  models: z.array(LegModelView),
  /** What I still have to do, e.g. log in, in plain words. */
  setupHint: z.string().nullable(),
});
export type LegView = z.infer<typeof LegView>;

export const ProfileOverrides = ProfileSettings.partial().extend({
  strengths: Strengths.optional(),
});
export type ProfileOverrides = z.infer<typeof ProfileOverrides>;
