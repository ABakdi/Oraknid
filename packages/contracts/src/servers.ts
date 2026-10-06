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

/**
 * A server changed after it was added (Servers → Editing a server): what is
 * given changes, what is left out stays. A new private key or password
 * replaces the kept credentials; a passphrase alone goes with the kept key.
 */
export const ServerPatch = z.object({
  id: Id,
  name: z.string().min(1).max(60).optional(),
  description: z.string().optional(),
  host: z.string().min(1).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  user: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
  privateKey: z.string().min(1).optional(),
  passphrase: z.string().min(1).optional(),
});
export type ServerPatch = z.infer<typeof ServerPatch>;

/**
 * Test connection (Servers → Testing the connection): the form as it is,
 * nothing saved. With `id`, credentials left out are the kept ones, and the
 * pinned host key is checked while the address is the same.
 */
export const ServerTest = z.object({
  id: Id.optional(),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(22),
  user: z.string().min(1),
  password: z.string().min(1).optional(),
  privateKey: z.string().min(1).optional(),
  passphrase: z.string().min(1).optional(),
});
export type ServerTest = z.infer<typeof ServerTest>;

export const ServerTestResult = z.object({
  ok: z.boolean(),
  /** In plain words: what it found, or why it couldn't. */
  said: z.string(),
  /** `uname -sr` there, when it got in. */
  system: z.string().nullable(),
  hostname: z.string().nullable(),
  /** The host key it presented (a new one, when it changed). */
  fingerprint: z.string().nullable(),
});
export type ServerTestResult = z.infer<typeof ServerTestResult>;

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
  /** Projects that may use it (its own server project left out). */
  projectIds: z.array(Id),
  /** Its own project, for its conversation and its jobs (ADR-049); null until the first. */
  projectId: Id.nullable().default(null),
  /** Marked production on the server itself: every job that reaches it asks before a change (ADR-049). */
  production: z.boolean().default(false),
  /** The projects where its role makes it production (ADR-042). */
  productionIn: z.array(Id).default([]),
  createdAt: Timestamp,
});
export type ServerView = z.infer<typeof ServerView>;

export const ServerState = z.object({
  version: z.number().int(),
  body: z.string(),
  source: z.enum(["eye", "owner"]),
  /** The job whose end wrote it from a new discovery (ADR-049). */
  jobId: Id.nullable().default(null),
  createdAt: Timestamp,
});
export type ServerState = z.infer<typeof ServerState>;

/** A version of a state document in its history, without its body (ADR-049). */
export const ServerStateVersion = ServerState.omit({ body: true }).extend({
  /** The job's title, when a job's end wrote it. */
  jobTitle: z.string().nullable().default(null),
});
export type ServerStateVersion = z.infer<typeof ServerStateVersion>;
