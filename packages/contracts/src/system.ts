import { z } from "zod";
import { Timestamp } from "./common.ts";

export const SystemStatus = z.object({
  version: z.string(),
  startedAt: Timestamp,
  uptimeMs: z.number().int().nonnegative(),
  pid: z.number().int().positive(),
  dataDir: z.string(),
  lastSeq: z.number().int().nonnegative(),
  inhibitor: z.object({
    held: z.boolean(),
    mode: z.enum(["block", "delay"]).nullable(),
    why: z.string().nullable(),
    problem: z.string().nullable(),
  }),
  secrets: z.object({
    kind: z.enum(["keychain", "encrypted-file", "none"]),
    available: z.boolean(),
    detail: z.string(),
  }),
  sandbox: z.object({ available: z.boolean(), detail: z.string() }),
  service: z.object({
    installed: z.boolean(),
    enabled: z.boolean(),
    active: z.boolean(),
    startsAtBoot: z.boolean(),
    detail: z.string(),
    /** What to run to put it right; null when nothing is wrong. */
    fix: z.string().nullable(),
  }),
  /** Whether this Oraknid has the web UI; false on a terminal-only install (ADR-055). */
  webUi: z.boolean().default(true),
});
export type SystemStatus = z.infer<typeof SystemStatus>;

export const DoctorCheck = z.object({
  name: z.string(),
  ok: z.boolean(),
  /** What was found, in plain words (BR-17). */
  detail: z.string(),
  /** What to do about it, when not ok. */
  fix: z.string().nullable(),
});
export type DoctorCheck = z.infer<typeof DoctorCheck>;

// ── Storage (Persistence-and-Recovery → Backups and pruning, M1.9) ──

export const StorageUsage = z.object({
  dataDir: z.string(),
  /** The database file with its write-ahead log. */
  database: z.number().int().nonnegative(),
  backups: z.object({ bytes: z.number().int().nonnegative(), files: z.array(z.string()) }),
  audit: z.number().int().nonnegative(),
  daemonLog: z.number().int().nonnegative(),
  /** Raw Leg logs, per job. */
  jobs: z.array(
    z.object({
      jobId: z.string(),
      title: z.string(),
      state: z.string(),
      bytes: z.number().int().nonnegative(),
      files: z.number().int().nonnegative(),
      oldest: z.number().nullable(),
    }),
  ),
});
export type StorageUsage = z.infer<typeof StorageUsage>;

/** A finished job's worktree on disk (Sandboxing → Worktrees): its size and what removing it loses. */
export const JobWorktree = z.object({
  jobId: z.string(),
  title: z.string(),
  state: z.string(),
  folder: z.string(),
  branch: z.string().nullable(),
  into: z.string().nullable(),
  bytes: z.number().int().nonnegative(),
  /** Commits on its branch not merged into the work branch (the branch stays). */
  unmerged: z.number().int().nonnegative(),
  /** Files changed and not committed (lost with the worktree). */
  uncommitted: z.number().int().nonnegative(),
});
export type JobWorktree = z.infer<typeof JobWorktree>;

export const PruneRequest = z.object({
  jobIds: z.array(z.string()).min(1),
  /** Raw logs last written before this time go. */
  before: z.number(),
});
export type PruneRequest = z.infer<typeof PruneRequest>;
