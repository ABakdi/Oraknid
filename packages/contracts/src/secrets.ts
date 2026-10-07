import { z } from "zod";
import { Id } from "./common.ts";

// A project's secrets per environment (ADR-059): names and when each was
// set travel; a value goes one way only, in, and is never read back.

export const SecretEnvironment = z.enum(["dev", "testing", "production"]);
export type SecretEnvironment = z.infer<typeof SecretEnvironment>;

/** An environment variable's name; names Oraknid sets itself are refused by the daemon. */
export const SecretName = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Z_][A-Z0-9_]*$/, "Use an environment variable's name: A–Z, 0–9 and _.");

export const ProjectSecretView = z.object({
  id: Id,
  projectId: Id,
  environment: SecretEnvironment,
  name: z.string(),
  /** Always masked: a value is never shown after save. */
  masked: z.literal("••••••••"),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type ProjectSecretView = z.infer<typeof ProjectSecretView>;

export const ProjectSecretsView = z.object({
  projectId: Id,
  /** The environment a new job of this project runs in. */
  defaultEnvironment: SecretEnvironment,
  secrets: z.array(ProjectSecretView),
});
export type ProjectSecretsView = z.infer<typeof ProjectSecretsView>;

export const SetProjectSecret = z.object({
  projectId: Id,
  environment: SecretEnvironment,
  name: SecretName,
  value: z
    .string()
    .min(1)
    .max(64 * 1024),
});
export type SetProjectSecret = z.infer<typeof SetProjectSecret>;

export const ImportDotEnv = z.object({
  projectId: Id,
  environment: SecretEnvironment,
  /** A `.env` file's text: `KEY=value` lines, `export`, quotes and comments understood. */
  text: z
    .string()
    .min(1)
    .max(512 * 1024),
});
export type ImportDotEnv = z.infer<typeof ImportDotEnv>;

export const ImportDotEnvResult = z.object({
  /** Names set (new or replaced). */
  set: z.array(z.string()),
  /** Lines not understood or names refused, with why (never the value). */
  skipped: z.array(z.object({ line: z.number().int(), reason: z.string() })),
});
export type ImportDotEnvResult = z.infer<typeof ImportDotEnvResult>;
