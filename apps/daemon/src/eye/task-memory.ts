import type { Grant } from "@oraknid/core";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/open.ts";
import { settings } from "../db/schema.ts";
import { readSetting, writeSetting } from "../settings.ts";

// What a task's attempts learned that must outlive one of them and a restart
// of Oraknid (ADR-056 stage 1, bug 8): that it read untrusted content (a
// resumed session is not trusted again), the grants I gave (what I let run
// once, ADR-056 §3) and what I refused (D8), the blocks the stuck rule
// counts, and what the attempt asked me. Kept per task until it settles.
// ADR-056's attempt log takes this over in a later stage.

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

const GrantRow: z.ZodType<Grant> = z.object({
  kind: z.enum(["allow-once", "all-like-this", "plan-change", "autonomy"]),
  scope: z.enum(["once", "task", "job", "plan"]),
  match: z.string(),
  reason: z.string(),
  at: z.number(),
});

export const TaskMemory = z.object({
  /** Why the task is untrusted (it read the web, a tool's outside content), or null. */
  untrusted: z.string().nullable().default(null),
  /** Grants I gave the task's attempts and not used yet (ADR-056 §3): what I let run once. */
  grants: z.array(GrantRow).default([]),
  /** Before grants: commands I let run once, in their plain form; read as once-grants. */
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
const EMPTY: TaskMemory = {
  untrusted: null,
  grants: [],
  allowOnce: [],
  denied: [],
  stuck: null,
  asked: [],
};

export function readTaskMemory(db: Db, taskId: string): TaskMemory {
  const m = readSetting(db, keyOf(taskId), TaskMemory, EMPTY);
  if (!m.allowOnce.length) return m;
  // Kept before grants were: each a grant to run once.
  const kept: Grant[] = m.allowOnce.map((match) => ({
    kind: "allow-once",
    scope: "once",
    match,
    reason: "let it run once",
    at: 0,
  }));
  return { ...m, grants: [...m.grants, ...kept], allowOnce: [] };
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
