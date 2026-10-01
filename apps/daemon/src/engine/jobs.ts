import type { JobState } from "@oraknid/contracts";
import { assertJob } from "@oraknid/core";
import { eq } from "drizzle-orm";
import type { Db } from "../db/open.ts";
import { jobs } from "../db/schema.ts";
import type { EventBus } from "../events/bus.ts";

export type JobRow = typeof jobs.$inferSelect;

/** Job state changes: checked against the life cycle, committed with their event. */
export class JobStore {
  constructor(
    private readonly db: Db,
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
  transition(id: string, to: JobState, reason: string | null = null): JobRow {
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
}
