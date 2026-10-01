import { ACTIVE_JOB_STATES, type Budget } from "@oraknid/contracts";
import { type BudgetDimension, checkBudget, raiseBudget } from "@oraknid/core";
import { eq, inArray, sql, sum } from "drizzle-orm";
import type { Db } from "../db/open.ts";
import { jobs, sessions } from "../db/schema.ts";
import type { JobRunner } from "../engine/runner.ts";
import type { EventBus } from "../events/bus.ts";
import type { InboxStore } from "../inbox/store.ts";

const logError = (error: unknown) => console.error("budget watch failed", error);

export const RAISE_HALF = "Raise it by half";
export const RAISE_DOUBLE = "Double it";
export const KEEP_PAUSED = "Keep it paused";

/** Tokens a job used: what went in and out, and what was written to cache (reads are left out). */
export function jobTokens(db: Db, jobId: string): number {
  const r = db
    .select({
      i: sum(sessions.inputTokens),
      o: sum(sessions.outputTokens),
      w: sum(sessions.cacheWriteTokens),
    })
    .from(sessions)
    .where(eq(sessions.jobId, jobId))
    .get();
  return Number(r?.i ?? 0) + Number(r?.o ?? 0) + Number(r?.w ?? 0);
}

/**
 * Watches every active job's budget (Budgets-and-Quotas): warnings and
 * alarms become events (and notifications), a hard limit pauses the job
 * and asks me whether to raise it.
 */
export function startBudgetWatch(o: {
  db: Db;
  bus: EventBus;
  inbox: InboxStore;
  runner: JobRunner;
  now: () => number;
  intervalMs?: number;
}) {
  const { db, bus } = o;

  const check = async (jobId: string) => {
    const job = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    if (!job || !(ACTIVE_JOB_STATES as readonly string[]).includes(job.state)) return;
    const use = {
      tokens: jobTokens(db, jobId),
      wallClockMs: job.startedAt ? o.now() - job.startedAt : 0,
      money: 0,
    };
    const findings = checkBudget(job.budget as Budget, use, new Set(job.budgetFlags));
    if (findings.length === 0) return;
    db.update(jobs)
      .set({
        budgetFlags: [...job.budgetFlags, ...findings.map((f) => `${f.dimension}:${f.kind}`)],
      })
      .where(eq(jobs.id, jobId))
      .run();
    for (const f of findings) {
      const type =
        f.kind === "warning" ? "budget.warning" : f.hard ? "budget.reached" : "budget.alarm";
      bus.publish({ type, topic: `job:${jobId}`, jobId, payload: { ...f } });
      bus.publish({ type, topic: "overview", jobId, payload: { ...f } });
      if (f.kind === "reached" && f.hard) {
        await o.runner.pause(jobId, f.message);
        const itemId = o.inbox.open({
          kind: "question",
          jobId,
          raisedBy: "eye",
          title: `Raise the ${f.dimension === "wallClockMs" ? "time" : f.dimension} budget of "${job.title}"?`,
          detail: f.message,
          options: [RAISE_HALF, RAISE_DOUBLE, KEEP_PAUSED],
          defaultOption: RAISE_HALF,
        });
        db.update(jobs)
          .set({ budgetQuestion: `${itemId}:${f.dimension}` })
          .where(eq(jobs.id, jobId))
          .run();
      }
    }
  };

  /** My answer: raise the limit (and clear its findings) and resume, or leave it paused. */
  const answered = async (itemId: string, answer: string) => {
    const job = db
      .select()
      .from(jobs)
      .where(sql`${jobs.budgetQuestion} like ${`${itemId}:%`}`)
      .get();
    if (!job?.budgetQuestion) return;
    // A job that ended meanwhile has nothing to raise (Audit 1 → D1-02).
    if (job.state === "completed" || job.state === "cancelled") return;
    const dimension = job.budgetQuestion.split(":")[1] as BudgetDimension;
    db.update(jobs).set({ budgetQuestion: null }).where(eq(jobs.id, job.id)).run();
    if (answer === KEEP_PAUSED) return;
    const factor = answer === RAISE_DOUBLE ? 2 : 1.5;
    db.update(jobs)
      .set({
        budget: raiseBudget(job.budget as Budget, dimension, factor),
        budgetFlags: job.budgetFlags.filter((f) => !f.startsWith(`${dimension}:`)),
      })
      .where(eq(jobs.id, job.id))
      .run();
    bus.publish({
      type: "budget.raised",
      topic: `job:${job.id}`,
      jobId: job.id,
      payload: { dimension, factor },
    });
    await o.runner.resume(job.id);
  };

  const off = bus.subscribe((e) => {
    if (e.type === "session.usage" && e.jobId && e.topic.startsWith("job:"))
      void check(e.jobId).catch(logError);
    if (e.type === "inbox.answered") {
      const { id, answer } = e.payload as { id: string; answer: string };
      void answered(id, answer).catch(logError);
    }
  });
  const timer = setInterval(() => {
    for (const j of db
      .select({ id: jobs.id })
      .from(jobs)
      .where(inArray(jobs.state, [...ACTIVE_JOB_STATES]))
      .all())
      void check(j.id).catch(logError);
  }, o.intervalMs ?? 30_000);
  timer.unref();
  return {
    check,
    stop: () => {
      off();
      clearInterval(timer);
    },
  };
}

/**
 * My new budget for a job, at any time (Checkpoint 1 hardening): a changed
 * dimension starts its warnings afresh. A job paused at a limit stays
 * paused until I resume it.
 */
export function setBudget(db: Db, bus: EventBus, jobId: string, budget: Budget) {
  const job = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!job) throw new Error(`No job ${jobId}.`);
  if (job.state === "completed" || job.state === "cancelled")
    throw new Error("The job has ended; its budget can't change.");
  const old = job.budget as Budget;
  const changed = (Object.keys(budget) as (keyof Budget)[]).filter(
    (k) => JSON.stringify(old[k]) !== JSON.stringify(budget[k]),
  );
  db.update(jobs)
    .set({
      budget,
      budgetFlags: job.budgetFlags.filter((f) => !changed.some((k) => f.startsWith(`${k}:`))),
    })
    .where(eq(jobs.id, jobId))
    .run();
  bus.publish({
    type: "budget.changed",
    topic: `job:${jobId}`,
    jobId,
    payload: { changed },
    actor: "owner",
  });
  return { changed };
}
