import { z } from "zod";
import { Id, Timestamp } from "./common.ts";

// Scheduled, encrypted database backups (ADR-044, docs/01-Specification/Servers.md → Backups).

export const DbKind = z.enum(["postgres", "mysql", "mongodb", "redis", "sqlite"]);
export type DbKind = z.infer<typeof DbKind>;

// Each kind's own fields (ADR-044 → Changed 2026-10-04: the plan form),
// under Advanced in the form, given to the dump and to Test connection
// the same way. Every field has a default, so a plan saved before them
// reads as it always ran.

/**
 * pg_dump options Oraknid passes on as written: flags that change what is
 * dumped, never where it goes or how it connects.
 */
export const PG_EXTRA_OPTION =
  /^(--(no-comments|no-publications|no-subscriptions|no-tablespaces|no-security-labels|no-unlogged-table-data|no-toast-compression|no-blobs|no-large-objects|quote-all-identifiers|inserts|column-inserts|disable-triggers|disable-dollar-quoting|load-via-partition-root|schema-only|data-only|enable-row-security|serializable-deferrable)|--(exclude-table|exclude-table-data|exclude-schema|table)=[\w.$*-]{1,255}|--(lock-wait-timeout|rows-per-insert|extra-float-digits)=\d{1,9})$/;

export const PgOptions = z.object({
  /** libpq's sslmode (PGSSLMODE); null: libpq's default (prefer). */
  sslmode: z
    .enum(["disable", "allow", "prefer", "require", "verify-ca", "verify-full"])
    .nullable()
    .default(null),
  /** Only these schemas (`-n`); empty: all of them. */
  schemas: z
    .array(z.string().regex(/^[\w$-]{1,63}$/, "a schema's name (letters, digits, _ $ -)"))
    .max(20)
    .default([]),
  /** plain: SQL text; custom: pg_dump's archive (-Fc), restored with pg_restore. */
  format: z.enum(["plain", "custom"]).default("plain"),
  /** More pg_dump options, each from PG_EXTRA_OPTION's list. */
  extra: z
    .array(z.string().regex(PG_EXTRA_OPTION, "a pg_dump option Oraknid doesn't pass on"))
    .max(20)
    .default([]),
});
export type PgOptions = z.infer<typeof PgOptions>;

export const MysqlOptions = z.object({
  /** default: the client's own; off; required: TLS; verify: TLS and the server's certificate. */
  tls: z.enum(["default", "off", "required", "verify"]).default("default"),
  singleTransaction: z.boolean().default(true),
  routines: z.boolean().default(true),
  events: z.boolean().default(false),
  triggers: z.boolean().default(true),
});
export type MysqlOptions = z.infer<typeof MysqlOptions>;

const MongoName = z.string().regex(/^[\w.-]{1,128}$/, "letters, digits, _ . -");

export const MongoOptions = z.object({
  /** The authentication database (authSource); null: admin. */
  authSource: MongoName.nullable().default(null),
  replicaSet: MongoName.nullable().default(null),
  /** off; on; insecure: TLS without checking the certificate. */
  tls: z.enum(["off", "on", "insecure"]).default("off"),
  readPreference: z
    .enum(["primary", "primaryPreferred", "secondary", "secondaryPreferred", "nearest"])
    .nullable()
    .default(null),
});
export type MongoOptions = z.infer<typeof MongoOptions>;

export const RedisOptions = z.object({
  /** off; on; insecure: TLS without checking the certificate. */
  tls: z.enum(["off", "on", "insecure"]).default("off"),
});
export type RedisOptions = z.infer<typeof RedisOptions>;

/** Each kind's own fields; only the target's kind is used. */
export const BackupOptions = z.object({
  postgres: PgOptions.optional(),
  mysql: MysqlOptions.optional(),
  mongodb: MongoOptions.optional(),
  redis: RedisOptions.optional(),
});
export type BackupOptions = z.infer<typeof BackupOptions>;

/** A database on one of my servers: in a container (by its name) or on the host. */
export const BackupTarget = z.object({
  serverId: Id,
  kind: DbKind,
  /** The Docker (or Podman) container it runs in; null: on the host itself. */
  container: z.string().min(1).max(128).nullable().default(null),
  /** Where the dump connects; null: the default (a local socket, or 127.0.0.1). */
  host: z.string().min(1).max(255).nullable().default(null),
  port: z.number().int().min(1).max(65535).nullable().default(null),
  /** One database (Redis: the database number Test connection looks at); null: all of them. */
  database: z.string().min(1).max(255).nullable().default(null),
  /** The login (Redis: its ACL user); null: the tool's default. */
  user: z.string().min(1).max(255).nullable().default(null),
  /** SQLite: the database file's path on the server (or in the container). */
  path: z.string().min(1).max(1024).nullable().default(null),
  /**
   * Each kind's own fields (Advanced). Left out of a change, the plan's
   * own stay (no default here, so a change can't reset them unseen).
   */
  options: BackupOptions.optional(),
});
export type BackupTarget = z.infer<typeof BackupTarget>;

/** The target's own fields for its kind, every default filled in. */
export function kindOptions(t: Pick<BackupTarget, "options">) {
  return {
    postgres: PgOptions.parse(t.options?.postgres ?? {}),
    mysql: MysqlOptions.parse(t.options?.mysql ?? {}),
    mongodb: MongoOptions.parse(t.options?.mongodb ?? {}),
    redis: RedisOptions.parse(t.options?.redis ?? {}),
  };
}

/** A MongoDB connection string, kept as a secret: it can hold a password. */
export const MongoUri = z
  .string()
  .max(2048)
  .regex(/^mongodb(\+srv)?:\/\/[^\s]+$/, "a mongodb:// or mongodb+srv:// address");

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
  /**
   * Cloud storage (ADR-046): one provider, or the pool (null: placed by
   * the upload rule when each backup is made). A run's own destination
   * names the provider it went to.
   */
  z.object({ kind: z.literal("cloud"), providerId: Id.nullable(), folder: z.string().min(1) }),
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
  /** MongoDB: a connection string used instead of the fields; kept in the keychain like a password. */
  uri: MongoUri.optional(),
});
export type NewBackupPlan = z.infer<typeof NewBackupPlan>;

export const BackupPlanPatch = NewBackupPlan.partial().extend({
  id: Id,
  // Left out, it stays as it is (a default here would switch a paused plan back on).
  enabled: z.boolean().optional(),
  /** Forget the kept password. */
  clearPassword: z.boolean().optional(),
  /** Forget the kept MongoDB connection string. */
  clearUri: z.boolean().optional(),
});
export type BackupPlanPatch = z.infer<typeof BackupPlanPatch>;

/**
 * Test connection (`backups.testPlan`): the form as it is, nothing saved.
 * With `planId`, a password or connection string left empty is the
 * plan's kept one.
 */
export const BackupPlanTest = NewBackupPlan.omit({ enabled: true }).extend({
  name: z.string().max(80).default(""),
  planId: Id.optional(),
  /** Not the plan's kept connection string: the fields. */
  clearUri: z.boolean().optional(),
});
export type BackupPlanTest = z.infer<typeof BackupPlanTest>;

/** One part of a test: ok, or why not in plain words; `ok: null` when it wasn't tried. */
export const BackupTestPart = z.object({ ok: z.boolean().nullable(), said: z.string() });
export type BackupTestPart = z.infer<typeof BackupTestPart>;

export const BackupTestResult = z.object({
  /** Reached over SSH. */
  server: BackupTestPart,
  /** Its own client, logged in with what was given: its version and databases. */
  database: BackupTestPart.extend({
    version: z.string().nullable(),
    databases: z.array(z.string()),
  }),
  /** A small file written there and removed. */
  destination: BackupTestPart,
});
export type BackupTestResult = z.infer<typeof BackupTestResult>;

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
  /** Where, in words: "this computer", a server's name, or a cloud provider's. */
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
  /** MongoDB: a connection string is kept for it (and used instead of the fields). */
  hasUri: z.boolean().default(false),
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
