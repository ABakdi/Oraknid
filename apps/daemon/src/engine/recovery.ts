import { ACTIVE_JOB_STATES } from "@oraknid/contracts";
import { inArray } from "drizzle-orm";
import type { Db } from "../db/open.ts";
import { jobs, tasks } from "../db/schema.ts";
import type { EventBus } from "../events/bus.ts";
import type { SideEffects } from "./effects.ts";
import type { JobStore } from "./jobs.ts";
import type { StepJournal } from "./journal.ts";
import type { JobRunner } from "./runner.ts";

export interface RecoverySummary {
  unfinishedSteps: number;
  tasksReset: number;
  effectsNeedingMe: number;
  jobsResumed: string[];
}

/** Hooks later milestones add to recovery: e.g. killing orphaned Leg processes (M1.4). */
export type RecoveryHook = () => Promise<void> | void;

/**
 * Runs before anything else at start (docs/01-Specification/Durability.md):
 * unfinished steps are forgotten so they run again, running tasks go back
 * to ready, actions caught mid-way are reconciled or asked about, and
 * active jobs resume. Paused jobs stay paused.
 */
export async function recover(o: {
  db: Db;
  bus: EventBus;
  jobs: JobStore;
  journal: StepJournal;
  effects: SideEffects;
  runner: JobRunner;
  hooks?: RecoveryHook[];
}): Promise<RecoverySummary> {
  for (const hook of o.hooks ?? []) await hook();

  const unfinishedSteps = o.journal.forgetUnfinished();

  const interrupted = o.db
    .select({ id: tasks.id, jobId: tasks.jobId, state: tasks.state })
    .from(tasks)
    .where(inArray(tasks.state, ["assigned", "running", "verifying"]))
    .all();
  o.bus.atomically(() => {
    for (const t of interrupted) {
      o.db
        .update(tasks)
        .set({ state: "ready", leaseUntil: null })
        .where(inArray(tasks.id, [t.id]))
        .run();
      o.bus.publish({
        type: "task.state",
        topic: `job:${t.jobId}`,
        jobId: t.jobId,
        payload: { taskId: t.id, from: t.state, to: "ready", reason: "Recovered after a stop." },
      });
    }
  });

  const needMe = await o.effects.reconcileAll();
  for (const row of needMe) {
    o.effects.askWhetherItHappened(row);
    const job = o.jobs.require(row.jobId);
    if ((ACTIVE_JOB_STATES as readonly string[]).includes(job.state)) {
      o.jobs.transition(
        row.jobId,
        "waiting",
        `Waiting for me to say whether "${row.action}" happened.`,
      );
    }
  }

  const active = o.db
    .select({ id: jobs.id })
    .from(jobs)
    .where(inArray(jobs.state, [...ACTIVE_JOB_STATES]))
    .all();
  for (const { id } of active) o.runner.start(id);

  const summary: RecoverySummary = {
    unfinishedSteps,
    tasksReset: interrupted.length,
    effectsNeedingMe: needMe.length,
    jobsResumed: active.map((j) => j.id),
  };
  const recoveredSomething =
    summary.unfinishedSteps +
      summary.tasksReset +
      summary.effectsNeedingMe +
      summary.jobsResumed.length >
    0;
  if (recoveredSomething) {
    o.bus.publish({ type: "system.recovered", topic: "overview", jobId: null, payload: summary });
  }
  return summary;
}
