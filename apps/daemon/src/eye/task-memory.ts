import type { Grant } from "@oraknid/core";
import { StuckWatch } from "@oraknid/guard";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/open.ts";
import { settings } from "../db/schema.ts";
import { type AttemptEventKind, AttemptLog } from "../harness/log.ts";
import { readSetting } from "../settings.ts";

// What a task's attempts learned that must outlive one of them and a restart
// of Oraknid (ADR-056 stage 1, bug 8): that it read untrusted content (a
// resumed session is not trusted again), the grants I gave (what I let run
// once, ADR-056 §3) and what I refused (D8), the blocks the stuck rule
// counts, and what the attempt asked me. Kept per task until it settles.
//
// A view over the attempt log (ADR-056 §1, stage 3): the log is the source
// of truth; this folds the task's Gate decisions, signals and questions
// since it was last forgotten. Read when an attempt's Gate starts and when
// its job starts again, never per action. What an older Oraknid kept as a
// setting is read first, as where the log goes on from.

const Blocked = z.object({
  action: z.string(),
  reason: z.string(),
  layer: z.union([z.literal(1), z.literal(2), z.literal("leg"), z.literal("owner")]),
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

/** What an older Oraknid kept per task as a setting (stage 1, 2); read as the log's start. */
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

/** The kinds the memory is folded from. */
const KINDS: AttemptEventKind[] = ["GateDecision", "Signal", "QuestionAsked", "QuestionAnswered"];
/** A bound on the fold: a task's last this many of those events. */
const FOLD_LIMIT = 5000;

export function readTaskMemory(db: Db, taskId: string): TaskMemory {
  const kept = readSetting(db, keyOf(taskId), TaskMemory, EMPTY);
  const m: TaskMemory = {
    ...kept,
    // Kept before grants were: each a grant to run once.
    grants: [
      ...kept.grants,
      ...kept.allowOnce.map(
        (match): Grant => ({
          kind: "allow-once",
          scope: "once",
          match,
          reason: "let it run once",
          at: 0,
        }),
      ),
    ],
    allowOnce: [],
    denied: [...kept.denied],
    asked: [...kept.asked],
  };
  const log = new AttemptLog(db);
  const since = log.lastOf(taskId, "Forgotten")?.id;
  const events = log.task(taskId, {
    kinds: KINDS,
    ...(since ? { afterId: since } : {}),
    limit: FOLD_LIMIT,
  });
  // The stuck count replayed as it was counted: blocks, and the actions that ended a row.
  const watch = new StuckWatch();
  watch.restore("t", m.stuck);
  let counted = m.stuck !== null;
  for (const e of events) {
    switch (e.kind) {
      case "GateDecision": {
        const g = e.data;
        if (g.grant) m.grants.push(g.grant);
        if (g.spent !== undefined) {
          const i = m.grants.findIndex((x) => x.scope === "once" && x.match === g.spent);
          if (i >= 0) m.grants.splice(i, 1);
        }
        if (g.refusal && !m.denied.includes(g.refusal)) m.denied.push(g.refusal);
        if (g.counts !== undefined) {
          watch.blocked("t", { action: g.action, reason: g.reason, layer: g.counts });
          counted = true;
        }
        if (g.endsRow) watch.allowed("t");
        break;
      }
      case "Signal":
        if (e.data.kind === "untrusted" && m.untrusted === null) m.untrusted = e.data.evidence;
        break;
      case "QuestionAsked":
        if (!m.asked.includes(e.data.itemId)) m.asked.push(e.data.itemId);
        break;
      case "QuestionAnswered":
        if (e.data.withdrawn) m.asked = m.asked.filter((x) => x !== e.data.itemId);
        break;
    }
  }
  m.stuck = counted ? watch.snapshot("t") : null;
  return m;
}

/**
 * The task settled, or its job ended: nothing of it is kept. The log keeps
 * what happened; the memory starts again after this mark.
 */
export function forgetTaskMemory(db: Db, jobId: string, taskId: string, reason: string) {
  db.delete(settings)
    .where(eq(settings.key, keyOf(taskId)))
    .run();
  new AttemptLog(db).append({ jobId, taskId, attemptId: null }, "Forgotten", { reason });
}

/**
 * What the task's attempts asked me, withdrawn (bug 9): an attempt cut short
 * by a crash leaves no question behind; its next one asks again if it must.
 */
export function withdrawTaskQuestions(
  db: Db,
  jobId: string,
  taskId: string,
  withdraw: (itemId: string) => void,
) {
  const { asked } = readTaskMemory(db, taskId);
  const log = new AttemptLog(db);
  for (const itemId of asked) {
    withdraw(itemId);
    log.append({ jobId, taskId, attemptId: null }, "QuestionAnswered", {
      itemId,
      answer: null,
      withdrawn: true,
    });
  }
}
