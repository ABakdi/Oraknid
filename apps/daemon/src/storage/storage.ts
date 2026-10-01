import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { ACTIVE_JOB_STATES, type PruneRequest, type StorageUsage } from "@oraknid/contracts";
import { inArray } from "drizzle-orm";
import type { Db } from "../db/open.ts";
import { jobs } from "../db/schema.ts";
import type { EventBus } from "../events/bus.ts";
import type { Paths } from "../paths.ts";

// Storage use, pruning and nightly backups (Persistence-and-Recovery →
// Backups and pruning). Silk, stats and the audit log are never pruned
// here: only raw Leg logs, for jobs I choose.

const size = (path: string) => (existsSync(path) ? statSync(path).size : 0);

function walk(dir: string): { path: string; bytes: number; mtime: number }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return walk(path);
    const s = statSync(path);
    return [{ path, bytes: s.size, mtime: s.mtimeMs }];
  });
}

const jobLogs = (paths: Paths) => join(paths.logs, "jobs");

export function storageUsage(db: Db, paths: Paths): StorageUsage {
  const backups = walk(paths.backups);
  const titles = new Map(
    db
      .select({ id: jobs.id, title: jobs.title, state: jobs.state })
      .from(jobs)
      .all()
      .map((j) => [j.id, j]),
  );
  const perJob = existsSync(jobLogs(paths))
    ? readdirSync(jobLogs(paths), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => {
          const files = walk(join(jobLogs(paths), e.name));
          const job = titles.get(e.name);
          return {
            jobId: e.name,
            title:
              job?.title ??
              (e.name === "no-job" ? "Not in a job (health checks)" : "A deleted job"),
            state: job?.state ?? "unknown",
            bytes: files.reduce((n, f) => n + f.bytes, 0),
            files: files.length,
            oldest: files.length ? Math.min(...files.map((f) => f.mtime)) : null,
          };
        })
        .sort((a, b) => b.bytes - a.bytes)
    : [];
  return {
    dataDir: paths.dataDir,
    database: size(paths.db) + size(`${paths.db}-wal`),
    backups: {
      bytes: backups.reduce((n, f) => n + f.bytes, 0),
      files: backups.map((f) => f.path.slice(paths.backups.length + 1)).sort(),
    },
    audit: walk(join(paths.logs, "audit")).reduce((n, f) => n + f.bytes, 0),
    daemonLog: size(paths.daemonLog),
    jobs: perJob,
  };
}

/** Drops the raw Leg logs of chosen jobs last written before a date; never a running job's. */
export function pruneLogs(db: Db, bus: EventBus, paths: Paths, r: PruneRequest) {
  const active = db
    .select({ id: jobs.id, title: jobs.title })
    .from(jobs)
    .where(inArray(jobs.state, [...ACTIVE_JOB_STATES]))
    .all()
    .filter((j) => r.jobIds.includes(j.id));
  if (active.length)
    throw new Error(`"${active[0]?.title}" is running; its logs can be pruned once it ends.`);
  let files = 0;
  let bytes = 0;
  for (const jobId of r.jobIds) {
    if (!/^[\w-]+$/.test(jobId)) continue;
    for (const f of walk(join(jobLogs(paths), jobId))) {
      if (f.mtime >= r.before) continue;
      rmSync(f.path);
      files++;
      bytes += f.bytes;
    }
  }
  bus.publish({
    type: "storage.pruned",
    topic: "overview",
    jobId: null,
    payload: { jobIds: r.jobIds, before: r.before, files, bytes },
    actor: "owner",
  });
  return { files, bytes };
}

/** One backup a day, seven kept: `.backup()` is consistent while the database is open. */
export async function nightlyBackup(db: Db, dir: string, now = Date.now(), keep = 7) {
  if (db.$client.memory) return null;
  mkdirSync(dir, { recursive: true });
  const name = `nightly-${new Date(now).toISOString().slice(0, 10)}.db`;
  if (existsSync(join(dir, name))) return null;
  await db.$client.backup(join(dir, name));
  for (const f of readdirSync(dir)
    .filter((f) => f.startsWith("nightly-") && f.endsWith(".db"))
    .sort()
    .slice(0, -keep))
    rmSync(join(dir, f));
  return name;
}

export function startNightlyBackups(db: Db, dir: string, now: () => number) {
  const run = () =>
    void nightlyBackup(db, dir, now()).catch((e) => console.error("nightly backup failed", e));
  run();
  const timer = setInterval(run, 3_600_000);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
