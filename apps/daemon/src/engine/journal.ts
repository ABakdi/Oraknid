import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/open.ts";
import { steps } from "../db/schema.ts";

export const hashInput = (input: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(input ?? null))
    .digest("hex");

export class NonDeterministicStep extends Error {
  constructor(jobId: string, key: string) {
    super(
      `Step "${key}" of job ${jobId} was replayed with different input than it first ran with. The plan changed underneath it.`,
    );
    this.name = "NonDeterministicStep";
  }
}

/** The step journal (ADR-003): a completed step is never run again; its output is replayed. */
export class StepJournal {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  get(jobId: string, key: string) {
    return this.db
      .select()
      .from(steps)
      .where(and(eq(steps.jobId, jobId), eq(steps.stepKey, key)))
      .get();
  }

  begin(jobId: string, key: string, inputHash: string) {
    this.db
      .insert(steps)
      .values({ jobId, stepKey: key, status: "running", inputHash, startedAt: this.now() })
      .onConflictDoUpdate({
        target: [steps.jobId, steps.stepKey],
        set: {
          status: "running",
          inputHash,
          startedAt: this.now(),
          finishedAt: null,
          output: null,
        },
      })
      .run();
  }

  complete(jobId: string, key: string, output: unknown) {
    this.db
      .update(steps)
      .set({ status: "done", output: output ?? null, finishedAt: this.now() })
      .where(and(eq(steps.jobId, jobId), eq(steps.stepKey, key)))
      .run();
  }

  fail(jobId: string, key: string, message: string) {
    this.db
      .update(steps)
      .set({ status: "failed", output: { error: message }, finishedAt: this.now() })
      .where(and(eq(steps.jobId, jobId), eq(steps.stepKey, key)))
      .run();
  }

  /** At boot nothing is running: a step left "running" never finished and will run again. */
  forgetUnfinished(): number {
    return this.db.delete(steps).where(eq(steps.status, "running")).run().changes;
  }
}
