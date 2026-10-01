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
  }),
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

export const PruneRequest = z.object({
  jobIds: z.array(z.string()).min(1),
  /** Raw logs last written before this time go. */
  before: z.number(),
});
export type PruneRequest = z.infer<typeof PruneRequest>;
