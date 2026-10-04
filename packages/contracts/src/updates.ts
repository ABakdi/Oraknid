import { z } from "zod";
import { Timestamp } from "./common.ts";

// Updates from inside Oraknid (docs/04-Decisions/ADR-048-Updates.md).

/** Which releases count as updates: `dev` (pre-releases and new work on dev) or `stable` (releases only). */
export const UpdateChannel = z.enum(["dev", "stable"]);
export type UpdateChannel = z.infer<typeof UpdateChannel>;

/** What install.sh wrote in `<app>/.oraknid-install.json`. */
export const InstallRecord = z.object({
  /** The branch or tag asked for (`--ref`, `--dev`). */
  ref: z.string().min(1),
  channel: UpdateChannel,
  commit: z.string(),
  version: z.string(),
  installedAt: z.string(),
  /** The repository it came from (`--from`). */
  from: z.string(),
  /** Whether the background service was installed (not `--no-service`). */
  service: z.boolean().default(true),
});
export type InstallRecord = z.infer<typeof InstallRecord>;

/** How this Oraknid runs: installed by the script, or from a developer's clone. */
export const InstallInfo = z.discriminatedUnion("mode", [
  InstallRecord.extend({ mode: z.literal("script"), appDir: z.string() }),
  z.object({
    mode: z.literal("clone"),
    appDir: z.string(),
    /** Installed by an install.sh from before the record (v0.1.0): run once more, it updates itself. */
    unrecorded: z.boolean().optional(),
  }),
]);
export type InstallInfo = z.infer<typeof InstallInfo>;

export const ReleaseView = z.object({
  tag: z.string(),
  version: z.string(),
  name: z.string(),
  prerelease: z.boolean(),
  publishedAt: Timestamp.nullable(),
  /** The release's notes, as written on GitHub (markdown). */
  notes: z.string(),
  url: z.string(),
});
export type ReleaseView = z.infer<typeof ReleaseView>;

/** Commits on dev past the installed one (the dev channel). */
export const DevAhead = z.object({
  count: z.number().int().nonnegative(),
  /** The newest first, at most 20. */
  commits: z.array(z.object({ sha: z.string(), message: z.string() })),
  url: z.string(),
});
export type DevAhead = z.infer<typeof DevAhead>;

export const UpdateRunState = z.enum([
  "running",
  "succeeded",
  /** It failed, and the version before was built again. */
  "rolled-back",
  "failed",
  /** Its process is gone without a word (the computer stopped). */
  "interrupted",
]);
export type UpdateRunState = z.infer<typeof UpdateRunState>;

/** The last update started from Oraknid, followed from its status file and log. */
export const UpdateRun = z.object({
  state: UpdateRunState,
  startedAt: Timestamp,
  finishedAt: Timestamp.nullable(),
  fromVersion: z.string(),
  fromCommit: z.string(),
  /** What it installs: a tag (`v0.2.0`) or `dev`. */
  target: z.string(),
  /** The version installed once it succeeded. */
  toVersion: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  /** The database's copy made first, in the data folder's backups. */
  backup: z.string().nullable(),
  log: z.array(z.string()),
});
export type UpdateRun = z.infer<typeof UpdateRun>;

export const UpdatesView = z.object({
  /** The version running now. */
  version: z.string(),
  install: InstallInfo,
  checkedAt: Timestamp.nullable(),
  /** Why the last check didn't reach GitHub, in words; null when it did. */
  error: z.string().nullable(),
  /** Releases newer than this one on its channel, the newest first. */
  newer: z.array(ReleaseView),
  /** The dev channel: new commits on dev. */
  devAhead: DevAhead.nullable(),
  /** Whether there is something to update to. */
  available: z.boolean(),
  /** What Update now installs: a tag, `dev`, or null. */
  target: z.string().nullable(),
  runningJobs: z.number().int().nonnegative(),
  /** Whether this device may update (ADR-030), and why not. */
  canUpdate: z.boolean(),
  whyNot: z.string().nullable(),
  run: UpdateRun.nullable(),
});
export type UpdatesView = z.infer<typeof UpdatesView>;
