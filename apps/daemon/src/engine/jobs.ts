import type { JobState } from "@oraknid/contracts";
import { assertJob } from "@oraknid/core";
import { and, asc, desc, eq, isNotNull } from "drizzle-orm";
import type { Db } from "../db/open.ts";
import { jobs } from "../db/schema.ts";
import type { EventBus } from "../events/bus.ts";

export type JobRow = typeof jobs.$inferSelect;

/** Job state changes: checked against the life cycle, committed with their event. */
export class JobStore {
  constructor(
    readonly db: Db,
    private readonly bus: EventBus,
    private readonly now: () => number = Date.now,
  ) {}

  get(id: string): JobRow | undefined {
    return this.db.select().from(jobs).where(eq(jobs.id, id)).get();
  }

  require(id: string): JobRow {
    const job = this.get(id);
    if (!job) throw new Error(`No job ${id}.`);
    return job;
  }

  /**
   * Moves a job to `to`. Pausing or waiting remembers the active state to
   * return to; leaving pause or wait clears it.
   */
  transition(id: string, to: JobState, why: string | null = null): JobRow {
    // A reason is said in a line or two wherever it shows (the chat, Work, the inbox); a tool's
    // whole output never becomes one (3 MB of paths, 2026-10-08).
    const reason = why && why.length > 600 ? `${why.slice(0, 600).trimEnd()}… (cut short)` : why;
    return this.bus.atomically(() => {
      const job = this.require(id);
      const from = job.state as JobState;
      if (from === to) return job;
      assertJob(from, to);
      const t = this.now();
      const parks = to === "paused" || to === "waiting" || to === "blocked";
      const resumeState = parks
        ? // Parking from a parked state keeps the original active state.
          (job.resumeState ?? from)
        : null;
      const set: Partial<JobRow> = {
        state: to,
        resumeState,
        pauseReason: to === "paused" ? reason : null,
        blockedReason: to === "blocked" || to === "waiting" ? reason : null,
      };
      if (!job.startedAt && to !== "draft" && to !== "cancelled") set.startedAt = t;
      if (to === "completed" || to === "cancelled") set.finishedAt = t;
      this.db.update(jobs).set(set).where(eq(jobs.id, id)).run();
      this.bus.publish({
        type: "job.state",
        topic: `job:${id}`,
        jobId: id,
        payload: { from, to, reason },
      });
      return this.require(id);
    });
  }

  /** Puts a job in the queue for a free slot (ADR-016); its state stays as it is. */
  queue(id: string) {
    this.bus.atomically(() => {
      const job = this.require(id);
      if (job.queuedAt) return;
      this.db.update(jobs).set({ queuedAt: this.now() }).where(eq(jobs.id, id)).run();
      this.bus.publish({
        type: "job.queued",
        topic: `job:${id}`,
        jobId: id,
        payload: { reason: "Waiting for a free slot under the running-jobs limit." },
      });
    });
  }

  unqueue(id: string) {
    this.db.update(jobs).set({ queuedAt: null }).where(eq(jobs.id, id)).run();
  }

  /** The next queued job: highest priority first, then the one waiting longest. */
  nextQueued(): JobRow | undefined {
    return this.db
      .select()
      .from(jobs)
      .where(and(isNotNull(jobs.queuedAt)))
      .orderBy(desc(jobs.priority), asc(jobs.queuedAt))
      .get();
  }
}
