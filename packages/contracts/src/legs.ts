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

/**
 * A Codex Leg (ADR-057): OpenAI's official `codex`, with a CODEX_HOME of its
 * own (created when empty), signed in from its card with a ChatGPT account,
 * or given an OpenAI API key (`secret`, kept in the keychain). Its models
 * come from Codex's own catalog; `models` is the fallback.
 */
export const CodexLegConfig = z.object({
  binary: z.string().min(1).default("codex"),
  /** The Leg's own CODEX_HOME; never ~/.codex. Created when empty. */
  codexHome: z.string().min(1).optional(),
  models: z.array(z.string().min(1)).default([]),
});

/** How a model calls tools, as the probe tested it (ADR-052 §6). */
export const ToolCalling = z.enum(["native", "json", "none"]);
export type ToolCalling = z.infer<typeof ToolCalling>;

/**
 * Oraknid's own agent (ADR-052 §6): its tool loop over any model behind an
 * OpenAI-compatible API, at one address (`baseUrl`) or each model at its
 * own (`endpoints`, the Local Leg the Models page keeps, ADR-054).
 */
export const OraknidAgentLegConfig = z.object({
  baseUrl: z.url().optional(),
  /** The models to offer; empty: every model the server lists. */
  models: z.array(z.string().min(1)).default([]),
  endpoints: z
    .array(
      z.object({
        model: z.string().min(1),
        baseUrl: z.url(),
        displayName: z.string().optional(),
        contextWindow: z.number().int().positive().optional(),
        toolCalls: ToolCalling.optional(),
      }),
    )
    .default([]),
  contextWindow: z.number().int().positive().optional(),
  /** Model calls in one turn before it stops (max_turns). */
  maxSteps: z.number().int().positive().optional(),
  commandTimeoutMs: z.number().int().positive().optional(),
  /** This computer's own models, kept by the Models page (ADR-054). */
  local: z.boolean().optional(),
});
export type OraknidAgentLegConfig = z.infer<typeof OraknidAgentLegConfig>;

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
    secret: z.string().trim().min(1).optional(),
  }),
  z.object({
    kind: z.literal("opencode"),
    name: z.string().min(1),
    config: OpenCodeLegConfig,
    /** The provider's API key. Goes to the secret store, never the database. */
    secret: z.string().trim().min(1).optional(),
  }),
  z.object({
    kind: z.literal("antigravity"),
    name: z.string().min(1),
    config: AntigravityLegConfig,
  }),
  z.object({
    kind: z.literal("oraknid-agent"),
    name: z.string().min(1),
    config: OraknidAgentLegConfig,
    /** The endpoint's API key, if it needs one. Goes to the secret store, never the database. */
    secret: z.string().trim().min(1).optional(),
  }),
  z.object({
    kind: z.literal("codex"),
    name: z.string().min(1),
    config: CodexLegConfig,
    /** An OpenAI API key instead of a ChatGPT sign-in. Goes to the secret store, never the database. */
    secret: z.string().trim().min(1).optional(),
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

/** One usage window of a Leg's plan, as shown (ADR-039). */
export const PlanWindowView = z.object({
  /** As the provider names it, e.g. "five_hour", "seven_day_opus". */
  name: z.string(),
  /** In words: "5 hours", "Week", "Week, Opus". */
  label: z.string(),
  scope: z.enum(["account", "model"]),
  /** Share used, 0–1; null when not known. */
  utilization: z.number().min(0).max(1).nullable(),
  resetsAt: Timestamp.nullable(),
  estimated: z.boolean(),
  /** When this figure was seen: how old it is. */
  observedAt: Timestamp,
  source: z.enum(["usage", "session"]).nullable(),
  /** Oraknid's own tokens in this window, by model, most first. */
  tokens: z.array(
    z.object({
      legModelId: Id,
      model: z.string(),
      displayName: z.string(),
      tokens: z.number().int().nonnegative(),
    }),
  ),
});
export type PlanWindowView = z.infer<typeof PlanWindowView>;

/** A Leg's plan usage: its windows, fullest first (ADR-039). */
export const LegPlanUsage = z.object({
  legId: Id,
  name: z.string(),
  kind: LegKind,
  health: LegHealth,
  windows: z.array(PlanWindowView),
  /** When Oraknid last asked for a fresh reading, if it did. */
  checkedAt: Timestamp.nullable(),
  /** What this Leg has instead of windows, or why there are none yet, in words. */
  note: z.string().nullable(),
});
export type LegPlanUsage = z.infer<typeof LegPlanUsage>;

/** How a Leg's windows moved: every reading, and when each filled and reset (ADR-039). */
export const PlanHistory = z.object({
  points: z.array(
    z.object({
      window: z.string(),
      at: Timestamp,
      utilization: z.number().min(0).max(1).nullable(),
      resetsAt: Timestamp.nullable(),
    }),
  ),
  marks: z.array(
    z.object({
      window: z.string(),
      kind: z.enum(["filled", "reset"]),
      at: Timestamp,
    }),
  ),
});
export type PlanHistory = z.infer<typeof PlanHistory>;

export const ProfileOverrides = ProfileSettings.partial().extend({
  strengths: Strengths.optional(),
});
export type ProfileOverrides = z.infer<typeof ProfileOverrides>;

/** An agent or model server found on this machine, ready to become a Leg (Legs → Finding agents). */
export const FoundAgent = z.object({
  kind: LegKind,
  /** What it is, e.g. "Claude Code 2.4.1", "Ollama, 3 models". */
  label: z.string(),
  /** Where: the program's path or the server's address. */
  where: z.string(),
  detail: z.string(),
  /** The name a new Leg gets, unique among my Legs. */
  suggestedName: z.string(),
  /** What `legs.create` takes for it. */
  config: z.record(z.string(), z.unknown()),
  /** Legs already using it (another account can still be added). */
  usedBy: z.array(z.string()),
});
export type FoundAgent = z.infer<typeof FoundAgent>;
