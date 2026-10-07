import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/open.ts";
import { settings } from "../db/schema.ts";
import { readSetting, writeSetting } from "../settings.ts";

// What a task's attempts learned that must outlive one of them and a restart
// of Oraknid (ADR-056 stage 1, bug 8): that it read untrusted content (a
// resumed session is not trusted again), what I let run once and what I
// refused (D8), the blocks the stuck rule counts, and what the attempt asked
// me. Kept per task until it settles. ADR-056's attempt log takes this over in a later stage.

const Blocked = z.object({
  action: z.string(),
  reason: z.string(),
  layer: z.union([z.literal(1), z.literal(2), z.literal("leg")]),
});

export const StuckState = z.object({
  row: z.array(Blocked),
  total: z.array(Blocked),
  askedAtTotal: z.boolean(),
});

export const TaskMemory = z.object({
  /** Why the task is untrusted (it read the web, a tool's outside content), or null. */
  untrusted: z.string().nullable().default(null),
  /** Commands I let run once, in their plain form, not run yet. */
  allowOnce: z.array(z.string()).default([]),
  /** Requests I refused, `tool:command-or-path`: asking again is a gate bypass (D8). */
  denied: z.array(z.string()).default([]),
  /** The stuck rule's count of blocks. */
  stuck: StuckState.nullable().default(null),
  /** What the attempt running now asked me (inbox items): withdrawn if it dies before I answer (bug 9). */
  asked: z.array(z.string()).default([]),
});
export type TaskMemory = z.infer<typeof TaskMemory>;

const keyOf = (taskId: string) => `task.memory.${taskId}`;
const EMPTY: TaskMemory = { untrusted: null, allowOnce: [], denied: [], stuck: null, asked: [] };

export function readTaskMemory(db: Db, taskId: string): TaskMemory {
  return readSetting(db, keyOf(taskId), TaskMemory, EMPTY);
}

/** Changes one part of what the task remembers. */
export function rememberForTask(db: Db, taskId: string, change: Partial<TaskMemory>) {
  writeSetting(db, keyOf(taskId), TaskMemory, { ...readTaskMemory(db, taskId), ...change });
}

/** The task settled: nothing of it is kept. */
export function forgetTaskMemory(db: Db, taskId: string) {
  db.delete(settings)
    .where(eq(settings.key, keyOf(taskId)))
    .run();
}
