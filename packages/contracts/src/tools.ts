import { z } from "zod";
import { Id, Timestamp } from "./common.ts";

// Tools for skills: MCP servers the daemon runs for a job's sessions (ADR-021).

const ToolName = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,30}$/, "lowercase letters, digits and dashes, starting with a letter");
const EnvName = z.string().regex(/^[A-Z_][A-Z0-9_]*$/, "an environment variable name");

export const NewTool = z.object({
  /** The name skills ask for in `requires.tools`, e.g. "email". */
  name: ToolName,
  description: z.string().default(""),
  /** The MCP server (stdio), run by the daemon in its own sandbox. */
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  /** Plain environment, never secret. */
  env: z.record(EnvName, z.string()).default({}),
  /** Secret environment: values go to the keychain, never the database (BR-13). */
  secrets: z.record(EnvName, z.string().min(1)).default({}),
  /** Its tools that only read; anything not listed writes. */
  reads: z.array(z.string().min(1)).default([]),
  /** Its tools that send: always asked (the gated action `send`). */
  sends: z.array(z.string().min(1)).default([]),
  /** What it returns is outside content: wrapped as data, and the task becomes untrusted (BR-15). */
  untrusted: z.boolean().default(true),
});
export type NewTool = z.infer<typeof NewTool>;

export const UpdateTool = NewTool.partial().extend({ id: Id });
export type UpdateTool = z.infer<typeof UpdateTool>;

export const ToolView = z.object({
  id: Id,
  name: z.string(),
  description: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()),
  /** The names of its secrets; never their values. */
  secretNames: z.array(z.string()),
  /** Secrets named but missing from the keychain. */
  missingSecrets: z.array(z.string()),
  reads: z.array(z.string()),
  sends: z.array(z.string()),
  untrusted: z.boolean(),
  /** Skills that ask for it. */
  usedBy: z.array(z.string()),
  /** Part of Oraknid (the email tool): run inside the daemon, not edited here. */
  builtIn: z.boolean(),
  /** Calls Oraknid itself holds for my approval (an agent's email waits as a draft). */
  held: z.array(z.string()),
  createdAt: Timestamp,
});
export type ToolView = z.infer<typeof ToolView>;
