import { type Budget, DEFAULT_BUDGET, NO_PROJECT_BUDGET, ProjectBudget } from "@oraknid/contracts";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./db/open.ts";
import { settings } from "./db/schema.ts";

/** Since when a job's failed attempts count: set when I resume it after it hit the limit. */
export const attemptsFromKey = (jobId: string) => `job.attemptsFrom.${jobId}`;

/** Typed access to the settings table: each key has a schema and a default. */
export function readSetting<T extends z.ZodType>(
  db: Db,
  key: string,
  schema: T,
  fallback: z.infer<T>,
): z.infer<T> {
  const row = db.select().from(settings).where(eq(settings.key, key)).get();
  if (!row) return fallback;
  const parsed = schema.safeParse(row.value);
  // A setting that no longer parses (an old shape) falls back rather than crashing the daemon.
  return parsed.success ? parsed.data : fallback;
}

export function writeSetting<T extends z.ZodType>(
  db: Db,
  key: string,
  schema: T,
  value: z.infer<T>,
  now = Date.now(),
) {
  const checked = schema.parse(value);
  // A cleared setting (null) is no row: reading it gives its default, null for every nullable one.
  if (checked === null) {
    db.delete(settings).where(eq(settings.key, key)).run();
    return;
  }
  db.insert(settings)
    .values({ key, value: checked, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value: checked, updatedAt: now } })
    .run();
}

/** How many jobs run at once (ADR-016). */
export const MAX_RUNNING_JOBS = "jobs.maxRunning";
/**
 * Jobs side by side unless I set it: four, since a job's tasks are what
 * load the machine, and those are admitted by resources across all jobs (ADR-050).
 */
export const DEFAULT_RUNNING_JOBS = 4;

/**
 * How many tasks of one job run at once, when I set a limit for one job
 * (ADR-016); absent, a job runs as many as are admitted (ADR-050).
 */
export const MAX_TASKS_PER_JOB = "jobs.maxTasks";

/**
 * Every job's Claude share unless its budget says otherwise (ADR-052 §3,
 * Settings → Work): the most of a job's attempts (0–1) that may run on
 * Claude when tasks climb. Null: as needed.
 */
export const CLAUDE_SHARE = "work.claudeShare";

/** How many rounds an interview may take (Skills → The interview); 3 unless I set it. */
export const INTERVIEW_ROUNDS = "eye.interviewRounds";
export const DEFAULT_INTERVIEW_ROUNDS = 3;

/** The branch a follow-up job starts from: the one the job it follows built (Jobs-and-Projects). */
export const followUpKey = (jobId: string) => `job.startFrom.${jobId}`;

/**
 * The server a job's work on a server goes to, as I chose or confirmed it
 * (ADR-042): its id, or "none" when I said to go on without one; and one I
 * said no to, which isn't proposed again.
 */
export const jobServerKey = (jobId: string) => `job.server.${jobId}`;
export const JobServer = z.object({
  serverId: z.string().nullable(),
  declined: z.array(z.string()).default([]),
});

/** A project's ports on this computer its jobs' sandboxes may reach (Sandboxing → network). */
export const projectPortsKey = (projectId: string) => `project.localPorts.${projectId}`;

export const projectPorts = (db: Db, projectId: string): number[] =>
  readSetting(db, projectPortsKey(projectId), z.array(z.number().int()), []);

/** A project's budget across its jobs (ADR-034). */
export const projectBudgetKey = (projectId: string) => `project.budget.${projectId}`;

/**
 * Where a project's budget stands: findings already reported ("tokens:warning"),
 * the open question (`<inbox item>:<dimension>`) and the jobs it paused.
 */
export const projectBudgetStateKey = (projectId: string) => `project.budgetState.${projectId}`;

export const projectBudget = (db: Db, projectId: string): ProjectBudget =>
  readSetting(db, projectBudgetKey(projectId), ProjectBudget, NO_PROJECT_BUDGET);

/**
 * The budget a new job in a project starts with (ADR-034): the project's
 * limits on tokens and money, the rest as for any job.
 */
export function jobBudgetFor(db: Db, projectId: string): Budget {
  const p = projectBudget(db, projectId);
  return {
    ...DEFAULT_BUDGET,
    tokens: p.tokens ?? DEFAULT_BUDGET.tokens,
    money: p.money ?? DEFAULT_BUDGET.money,
  };
}
