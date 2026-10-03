import { z } from "zod";
import { Id, Timestamp } from "./common.ts";

// Scheduled, encrypted database backups (ADR-044, docs/01-Specification/Servers.md → Backups).

export const DbKind = z.enum(["postgres", "mysql", "mongodb", "redis", "sqlite"]);
export type DbKind = z.infer<typeof DbKind>;

/** A database on one of my servers: in a container (by its name) or on the host. */
export const BackupTarget = z.object({
  serverId: Id,
  kind: DbKind,
  /** The Docker (or Podman) container it runs in; null: on the host itself. */
  container: z.string().min(1).max(128).nullable().default(null),
  /** Where the dump connects; null: the default (a local socket, or 127.0.0.1). */
  host: z.string().min(1).max(255).nullable().default(null),
  port: z.number().int().min(1).max(65535).nullable().default(null),
  /** One database (a Redis index, for Redis); null: all of them. */
  database: z.string().min(1).max(255).nullable().default(null),
  /** The login; null: the tool's default. */
  user: z.string().min(1).max(255).nullable().default(null),
  /** SQLite: the database file's path on the server (or in the container). */
  path: z.string().min(1).max(1024).nullable().default(null),
});
export type BackupTarget = z.infer<typeof BackupTarget>;

const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "a time like 03:30");

/** When, in this computer's time. */
export const BackupSchedule = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("hourly"), minute: z.number().int().min(0).max(59) }),
  z.object({ kind: z.literal("daily"), at: Time }),
  z.object({ kind: z.literal("weekly"), day: z.number().int().min(0).max(6), at: Time }),
  /** Five fields: minute hour day-of-month month day-of-week. */
  z.object({ kind: z.literal("cron"), line: z.string().min(9).max(200) }),
]);
export type BackupSchedule = z.infer<typeof BackupSchedule>;

export const BackupDestination = z.discriminatedUnion("kind", [
  /** A folder on this computer. */
  z.object({ kind: z.literal("local"), folder: z.string().min(1) }),
  /** A folder on another of my servers, streamed there through Oraknid. */
  z.object({ kind: z.literal("server"), serverId: Id, folder: z.string().min(1) }),
]);
export type BackupDestination = z.infer<typeof BackupDestination>;

/** How many to keep: the newest `count`, none older than `days`; the newest good one always stays. */
export const BackupRetention = z.object({
  count: z.number().int().min(1).max(10_000).nullable(),
  days: z.number().int().min(1).max(36_500).nullable(),
});
export type BackupRetention = z.infer<typeof BackupRetention>;

export const NewBackupPlan = z.object({
  name: z.string().min(1).max(80),
  target: BackupTarget,
  schedule: BackupSchedule,
  destination: BackupDestination,
  retention: BackupRetention,
  /** The age key it encrypts with; null: not encrypted. */
  keyId: Id.nullable(),
  enabled: z.boolean().default(true),
  /** The database's password: kept in the keychain, never shown again. */
  password: z.string().min(1).max(1024).optional(),
});
export type NewBackupPlan = z.infer<typeof NewBackupPlan>;

export const BackupPlanPatch = NewBackupPlan.partial().extend({
  id: Id,
  /** Forget the kept password. */
  clearPassword: z.boolean().optional(),
});
export type BackupPlanPatch = z.infer<typeof BackupPlanPatch>;

export const BackupRunState = z.enum(["running", "ok", "failed"]);
export type BackupRunState = z.infer<typeof BackupRunState>;

export const BackupRunView = z.object({
  id: Id,
  planId: Id,
  state: BackupRunState,
  /** schedule: at its time; missed: Oraknid was off at its time; manual: Run now. */
  trigger: z.enum(["schedule", "missed", "manual"]),
  startedAt: Timestamp,
  endedAt: Timestamp.nullable(),
  /** Bytes written (compressed, encrypted). */
  size: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  /** SHA-256 of the file as stored, hex. */
  checksum: z.string().nullable(),
  /** Where, in words: "this computer" or a server's name. */
  location: z.string(),
  path: z.string().nullable(),
  keyId: Id.nullable(),
  /** What went wrong, in plain words. */
  error: z.string().nullable(),
  verifiedAt: Timestamp.nullable(),
  verifyOk: z.boolean().nullable(),
  verifyNote: z.string().nullable(),
  /** Removed by retention (or by hand). */
  prunedAt: Timestamp.nullable(),
});
export type BackupRunView = z.infer<typeof BackupRunView>;

export const BackupPlanView = z.object({
  id: Id,
  name: z.string(),
  target: BackupTarget,
  schedule: BackupSchedule,
  destination: BackupDestination,
  retention: BackupRetention,
  keyId: Id.nullable(),
  enabled: z.boolean(),
  /** A password is in the keychain for it. */
  hasPassword: z.boolean(),
  nextRunAt: Timestamp.nullable(),
  running: z.boolean(),
  lastRun: BackupRunView.nullable(),
  createdAt: Timestamp,
});
export type BackupPlanView = z.infer<typeof BackupPlanView>;

/** An age key: its public half here; the private half only in the keychain. */
export const BackupKeyView = z.object({
  id: Id,
  name: z.string(),
  /** age1… */
  publicKey: z.string(),
  imported: z.boolean(),
  /** When I took its private key away (once); null: not yet. */
  exportedAt: Timestamp.nullable(),
  createdAt: Timestamp,
  /** Plans encrypting with it. */
  planCount: z.number().int(),
});
export type BackupKeyView = z.infer<typeof BackupKeyView>;

/** What a restore will do, said before it does it (the first of its two steps). */
export const RestorePreview = z.object({
  token: z.string(),
  summary: z.string(),
  /** Typed back to confirm: the database's name, or the server's for "all". */
  confirmWord: z.string(),
  expiresAt: Timestamp,
});
export type RestorePreview = z.infer<typeof RestorePreview>;
