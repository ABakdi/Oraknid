import {
  ACTIVE_JOB_STATES,
  type Budget,
  choiceQuestion,
  ProjectBudget,
  type ProjectBudgetView,
} from "@oraknid/contracts";
import { type BudgetDimension, checkBudget, raiseBudget } from "@oraknid/core";
import { eq, inArray, like, sql, sum } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/open.ts";
import { jobs, projects, sessions, settings } from "../db/schema.ts";
import type { JobRunner } from "../engine/runner.ts";
import type { EventBus } from "../events/bus.ts";
import type { InboxStore } from "../inbox/store.ts";
import {
  projectBudget,
  projectBudgetKey,
  projectBudgetStateKey,
  readSetting,
  writeSetting,
} from "../settings.ts";

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

/** Tokens all of a project's jobs used, counted as for one job (ADR-034). */
export function projectTokens(db: Db, projectId: string): number {
  const r = db
    .select({
      i: sum(sessions.inputTokens),
      o: sum(sessions.outputTokens),
      w: sum(sessions.cacheWriteTokens),
    })
    .from(sessions)
    .innerJoin(jobs, eq(jobs.id, sessions.jobId))
    .where(eq(jobs.projectId, projectId))
    .get();
  return Number(r?.i ?? 0) + Number(r?.o ?? 0) + Number(r?.w ?? 0);
}

/**
 * Where a project's budget stands: findings already reported (a hard limit
 * reached is `<dimension>:limit`, so it is enforced at every check while the
 * project is past it), the open question and the jobs it paused.
 */
const ProjectBudgetState = z.object({
  flags: z.array(z.string()).default([]),
  question: z.string().nullable().default(null),
  paused: z.array(z.string()).default([]),
});
type ProjectBudgetState = z.infer<typeof ProjectBudgetState>;
const readState = (db: Db, projectId: string): ProjectBudgetState =>
  readSetting(db, projectBudgetStateKey(projectId), ProjectBudgetState, {
    flags: [],
    question: null,
    paused: [],
  });
const writeState = (db: Db, projectId: string, st: ProjectBudgetState) =>
  writeSetting(db, projectBudgetStateKey(projectId), ProjectBudgetState, st);

/** A project's limits as a job's budget, for the shared rules. */
const asBudget = (p: ProjectBudget): Budget => ({
  tokens: p.tokens,
  quotaShare: null,
  wallClockMs: null,
  money: p.money ?? { limit: 0, hard: true },
});

export function projectBudgetView(db: Db, projectId: string): ProjectBudgetView {
  return {
    budget: projectBudget(db, projectId),
    used: { tokens: projectTokens(db, projectId), money: 0 },
    asking: !!readState(db, projectId).question,
  };
}

/** My new budget for a project: a changed dimension starts its warnings afresh. */
export function setProjectBudget(db: Db, bus: EventBus, projectId: string, budget: ProjectBudget) {
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) throw new Error(`No project ${projectId}.`);
  const old = projectBudget(db, projectId);
  const changed = (Object.keys(budget) as (keyof ProjectBudget)[]).filter(
    (k) => JSON.stringify(old[k]) !== JSON.stringify(budget[k]),
  );
  bus.atomically(() => {
    writeSetting(db, projectBudgetKey(projectId), ProjectBudget, budget);
    const st = readState(db, projectId);
    writeState(db, projectId, {
      ...st,
      flags: st.flags.filter((f) => !changed.some((k) => f.startsWith(`${k}:`))),
    });
    bus.publish({
      type: "project.budget",
      topic: "overview",
      jobId: null,
      payload: { projectId, changed },
      actor: "owner",
    });
  });
  return { changed };
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
  /** Hard limits being acted on now, so a check meanwhile doesn't pause and ask twice. */
  const pausing = new Set<string>();

  const check = async (jobId: string) => {
    const job = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    if (!job || !(ACTIVE_JOB_STATES as readonly string[]).includes(job.state)) return;
    const use = {
      tokens: jobTokens(db, jobId),
      wallClockMs: job.startedAt ? o.now() - job.startedAt : 0,
      money: 0,
    };
    const flags = new Set(job.budgetFlags);
    const findings = checkBudget(job.budget as Budget, use, flags).filter(
      (f) => !(f.kind === "reached" && f.hard && pausing.has(`${jobId}:${f.dimension}`)),
    );
    if (findings.length === 0) return checkProject(job);
    // A hard limit is marked reached only once the job is paused and asked: a crash in between
    // means the next check finds it again, instead of letting the job run past it (Audit 1 → D1-04).
    const settled = findings.filter((f) => !(f.kind === "reached" && f.hard));
    if (settled.length)
      db.update(jobs)
        .set({
          budgetFlags: [...job.budgetFlags, ...settled.map((f) => `${f.dimension}:${f.kind}`)],
        })
        .where(eq(jobs.id, jobId))
        .run();
    for (const f of findings) {
      const type =
        f.kind === "warning" ? "budget.warning" : f.hard ? "budget.reached" : "budget.alarm";
      bus.publish({ type, topic: `job:${jobId}`, jobId, payload: { ...f } });
      bus.publish({ type, topic: "overview", jobId, payload: { ...f } });
      if (f.kind === "reached" && f.hard) {
        const key = `${jobId}:${f.dimension}`;
        pausing.add(key);
        try {
          await o.runner.pause(jobId, f.message);
          bus.atomically(() => {
            const itemId = o.inbox.open({
              kind: "question",
              jobId,
              raisedBy: "eye",
              title: `Raise the ${f.dimension === "wallClockMs" ? "time" : f.dimension} budget of "${job.title}"?`,
              detail: f.message,
              options: [RAISE_HALF, RAISE_DOUBLE, KEEP_PAUSED],
              defaultOption: RAISE_HALF,
              questions: [
                choiceQuestion(
                  "Raise the budget?",
                  [
                    { label: RAISE_HALF, detail: "The limit goes up by half and the job resumes." },
                    { label: RAISE_DOUBLE, detail: "The limit doubles and the job resumes." },
                    {
                      label: KEEP_PAUSED,
                      detail:
                        "The job stays paused; raise its budget later, or cancel it. Nothing is lost.",
                    },
                  ],
                  RAISE_HALF,
                ),
              ],
            });
            const now = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
            db.update(jobs)
              .set({
                budgetQuestion: `${itemId}:${f.dimension}`,
                budgetFlags: [...(now?.budgetFlags ?? []), `${f.dimension}:reached`],
              })
              .where(eq(jobs.id, jobId))
              .run();
          });
        } finally {
          pausing.delete(key);
        }
      }
    }
    // Still going after its own limits: the project's come next (ADR-034).
    const after = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    if (after && (ACTIVE_JOB_STATES as readonly string[]).includes(after.state))
      await checkProject(after);
  };

  /**
   * A project's budget across its jobs (ADR-034): warned at 80%, and past a
   * hard limit every job of it that runs is paused, and I'm asked once.
   */
  const checkProject = async (job: typeof jobs.$inferSelect) => {
    const limits = projectBudget(db, job.projectId);
    if (!limits.tokens && !(limits.money && limits.money.limit > 0)) return;
    const use = { tokens: projectTokens(db, job.projectId), wallClockMs: 0, money: 0 };
    const findings = checkBudget(
      asBudget(limits),
      use,
      new Set(readState(db, job.projectId).flags),
      "project",
    );
    for (const f of findings) {
      const hardLimit = f.kind === "reached" && f.hard;
      const flag = `${f.dimension}:${hardLimit ? "limit" : f.kind}`;
      const st = readState(db, job.projectId);
      if (!st.flags.includes(flag)) {
        writeState(db, job.projectId, { ...st, flags: [...st.flags, flag] });
        const type =
          f.kind === "warning" ? "budget.warning" : f.hard ? "budget.reached" : "budget.alarm";
        const payload = { ...f, projectId: job.projectId };
        bus.publish({ type, topic: `job:${job.id}`, jobId: job.id, payload });
        bus.publish({ type, topic: "overview", jobId: job.id, payload });
      }
      if (!hardLimit) continue;
      const key = `${job.id}:project`;
      if (pausing.has(key)) continue;
      pausing.add(key);
      try {
        await o.runner.pause(job.id, f.message);
        bus.atomically(() => {
          const now = readState(db, job.projectId);
          let question = now.question;
          if (!question) {
            const project = db
              .select({ name: projects.name })
              .from(projects)
              .where(eq(projects.id, job.projectId))
              .get();
            const itemId = o.inbox.open({
              kind: "question",
              jobId: job.id,
              raisedBy: "eye",
              title: `Raise the ${f.dimension} budget of the project "${project?.name ?? ""}"?`,
              detail: `${f.message} Raising it resumes the jobs it paused.`,
              options: [RAISE_HALF, RAISE_DOUBLE, KEEP_PAUSED],
              defaultOption: RAISE_HALF,
              questions: [
                choiceQuestion(
                  "Raise the budget?",
                  [
                    { label: RAISE_HALF, detail: "The limit goes up by half and its jobs resume." },
                    { label: RAISE_DOUBLE, detail: "The limit doubles and its jobs resume." },
                    {
                      label: KEEP_PAUSED,
                      detail:
                        "Its jobs stay paused; raise the project's budget later. Nothing is lost.",
                    },
                  ],
                  RAISE_HALF,
                ),
              ],
            });
            question = `${itemId}:${f.dimension}`;
          }
          writeState(db, job.projectId, {
            ...now,
            question,
            paused: [...new Set([...now.paused, job.id])],
          });
        });
      } finally {
        pausing.delete(key);
      }
      return;
    }
  };

  /** My answer to a project's question: raise its limit and resume its jobs, or leave them. */
  const answeredProject = async (itemId: string, answer: string) => {
    const prefix = projectBudgetStateKey("");
    const row = db
      .select()
      .from(settings)
      .where(like(settings.key, `${prefix}%`))
      .all()
      .map((r) => ({
        projectId: r.key.slice(prefix.length),
        st: ProjectBudgetState.safeParse(r.value),
      }))
      .find((r) => r.st.success && r.st.data.question?.startsWith(`${itemId}:`));
    if (!row?.st.success) return;
    const { projectId } = row;
    const st = row.st.data;
    const dimension = (st.question as string).split(":")[1] as "tokens" | "money";
    if (answer === KEEP_PAUSED) {
      writeState(db, projectId, { ...st, question: null });
      return;
    }
    const factor = answer === RAISE_DOUBLE ? 2 : 1.5;
    const limits = projectBudget(db, projectId);
    const raised = raiseBudget(asBudget(limits), dimension, factor);
    bus.atomically(() => {
      writeSetting(db, projectBudgetKey(projectId), ProjectBudget, {
        tokens: raised.tokens,
        money: limits.money ? raised.money : null,
      });
      writeState(db, projectId, {
        flags: st.flags.filter((f) => !f.startsWith(`${dimension}:`)),
        question: null,
        paused: [],
      });
      bus.publish({
        type: "budget.raised",
        topic: "overview",
        jobId: null,
        payload: { projectId, dimension, factor },
      });
    });
    for (const id of st.paused) {
      const job = db.select().from(jobs).where(eq(jobs.id, id)).get();
      if (job?.state === "paused") await o.runner.resume(id).catch(logError);
    }
  };

  /** My answer: raise the limit (and clear its findings) and resume, or leave it paused. */
  const answered = async (itemId: string, answer: string) => {
    const job = db
      .select()
      .from(jobs)
      .where(sql`${jobs.budgetQuestion} like ${`${itemId}:%`}`)
      .get();
    if (!job?.budgetQuestion) return answeredProject(itemId, answer);
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
