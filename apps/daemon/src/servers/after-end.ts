import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/open.ts";
import { attempts, jobs, projects, tasks } from "../db/schema.ts";
import type { EventBus } from "../events/bus.ts";
import { readSetting, writeSetting } from "../settings.ts";
import type { Servers } from "./service.ts";

// A job that had servers and ended without completing (Servers → The state
// document, ADR-026): cancelled, or stopped by a failure (blocked), its
// work may still have changed them. Their state documents are refreshed as
// after a successful job: a new discovery, and the tasks that ran there
// named. Once per stop: the attempts since the last refresh say whether
// anything new ran. A completed job's refresh is the program's own step.

/** When this job's servers were last refreshed after it stopped. */
export const refreshedKey = (jobId: string) => `servers.refreshedAfter.${jobId}`;

/** Tasks that only look change nothing (ADR-049). */
const LOOKS = new Set(["research", "plan"]);

export interface AfterEndDeps {
  db: Db;
  bus: EventBus;
  servers: Pick<Servers, "discover">;
  now?: () => number;
}

/** The servers whose documents are refreshed, and how many tasks ran there; null: nothing to do. */
export async function refreshAfterStop(
  d: AfterEndDeps,
  jobId: string,
  why: "cancelled" | "failed",
): Promise<string[] | null> {
  const job = d.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!job) return null;
  const place = d.db.select().from(projects).where(eq(projects.id, job.projectId)).get();
  const serverIds = place?.serverIds ?? [];
  if (!serverIds.length) return null;
  const since = readSetting(d.db, refreshedKey(jobId), z.number(), 0);
  const changing = d.db
    .select({ id: tasks.id, title: tasks.title, kind: tasks.kind, state: tasks.state })
    .from(tasks)
    .where(eq(tasks.jobId, jobId))
    .orderBy(asc(tasks.position))
    .all()
    .filter((t) => !LOOKS.has(t.kind));
  if (!changing.length) return null;
  const ran = d.db
    .select({ taskId: attempts.taskId })
    .from(attempts)
    .where(
      and(
        eq(attempts.jobId, jobId),
        inArray(
          attempts.taskId,
          changing.map((t) => t.id),
        ),
        gt(attempts.startedAt, since),
      ),
    )
    .all();
  if (!ran.length) return null;
  const touched = new Set(ran.map((r) => r.taskId));
  writeSetting(d.db, refreshedKey(jobId), z.number(), d.now?.() ?? Date.now());
  const lines = changing
    .filter((t) => touched.has(t.id))
    .map((t) => `${t.title} (${t.state === "done" ? "done" : `not finished: ${t.state}`})`);
  const said =
    why === "cancelled"
      ? `The job "${job.title}" was cancelled; what its tasks may have changed is still there.`
      : `The job "${job.title}" stopped on a failure; what its tasks may have changed is still there.`;
  const done: string[] = [];
  for (const id of serverIds) {
    try {
      await d.servers.discover(
        id,
        `${said} Its goal: ${job.goal}\nIts tasks that ran:\n${lines.map((l) => `- ${l}`).join("\n")}`,
        {
          id: job.id,
          title: job.title,
          // A project's job names its changes only when it is the server's own (its tasks may be code).
          changes: place?.serverId === id ? lines : null,
        },
      );
      done.push(id);
    } catch {
      // A server not reached keeps its last document, marked stale (ADR-026).
    }
  }
  return done;
}

/** Listens for jobs that stop without completing. */
export function startRefreshAfterStop(d: AfterEndDeps): () => void {
  return d.bus.subscribe((e) => {
    if (e.type !== "job.state" || !e.jobId) return;
    const p = (e.payload ?? {}) as { to?: string; reason?: string };
    // Blocked by an error is a failure; blocked for quota or a budget is waiting, not one.
    const failed =
      p.to === "blocked" && !/quota|budget|rate.?limit|resets? /i.test(String(p.reason ?? ""));
    if (p.to !== "cancelled" && !failed) return;
    void refreshAfterStop(d, e.jobId, failed ? "failed" : "cancelled").catch((error) =>
      console.error("refreshing servers after a job failed", error),
    );
  });
}
