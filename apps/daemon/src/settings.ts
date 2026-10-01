import { eq } from "drizzle-orm";
import type { z } from "zod";
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
  db.insert(settings)
    .values({ key, value: checked, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value: checked, updatedAt: now } })
    .run();
}

/** How many jobs run at once (ADR-016). */
export const MAX_RUNNING_JOBS = "jobs.maxRunning";

/** How many tasks of one job run at once (ADR-016). */
export const MAX_TASKS_PER_JOB = "jobs.maxTasks";
