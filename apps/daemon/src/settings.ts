import { type Budget, DEFAULT_BUDGET, NO_PROJECT_BUDGET, ProjectBudget } from "@oraknid/contracts";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./db/open.ts";
import { settings } from "./db/schema.ts";

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

/** How many tasks of one job run at once (ADR-016). */
export const MAX_TASKS_PER_JOB = "jobs.maxTasks";

/** The branch a follow-up job starts from: the one the job it follows built (Jobs-and-Projects). */
export const followUpKey = (jobId: string) => `job.startFrom.${jobId}`;

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
