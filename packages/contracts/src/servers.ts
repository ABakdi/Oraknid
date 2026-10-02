import { z } from "zod";
import { Id, Timestamp } from "./common.ts";

// My servers (docs/01-Specification/Servers.md, ADR-026/027).

export const NewServer = z.object({
  name: z.string().min(1).max(60),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(22),
  user: z.string().min(1),
  /** In my words: what it is and what it has. */
  description: z.string().default(""),
  /** A password, used once to install Oraknid's own key, then deleted. */
  password: z.string().min(1).optional(),
  /** Or a private key of mine (OpenSSH or PEM), kept in the keychain. */
  privateKey: z.string().min(1).optional(),
  /** The key's passphrase, if it has one: kept in the keychain with it. */
  passphrase: z.string().min(1).optional(),
});
export type NewServer = z.infer<typeof NewServer>;

/** One reading of oraknid-monitor. */
export const ServerSample = z.object({
  at: Timestamp,
  cpuPercent: z.number(),
  load1: z.number(),
  memUsed: z.number(),
  memTotal: z.number(),
  diskUsed: z.number(),
  diskTotal: z.number(),
  rxBytes: z.number(),
  txBytes: z.number(),
  connections: z.number(),
  uptimeSec: z.number(),
  services: z.array(z.string()),
  ports: z.array(z.string()),
});
export type ServerSample = z.infer<typeof ServerSample>;

export const ServerView = z.object({
  id: Id,
  name: z.string(),
  host: z.string(),
  port: z.number(),
  user: z.string(),
  description: z.string(),
  auth: z.enum(["oraknid-key", "my-key", "password"]),
  setup: z.enum(["new", "ready"]),
  hostKey: z.string().nullable(),
  /** A different host key was presented: nothing connects until I accept it. */
  hostKeyOffered: z.string().nullable(),
  lastSeenAt: Timestamp.nullable(),
  error: z.string().nullable(),
  /** Working on it now: setting up or discovering. */
  busy: z.string().nullable(),
  stateVersion: z.number().int(),
  latest: ServerSample.nullable(),
  /** Projects that may use it. */
  projectIds: z.array(Id),
  createdAt: Timestamp,
});
export type ServerView = z.infer<typeof ServerView>;

export const ServerState = z.object({
  version: z.number().int(),
  body: z.string(),
  source: z.enum(["eye", "owner"]),
  createdAt: Timestamp,
});
export type ServerState = z.infer<typeof ServerState>;
