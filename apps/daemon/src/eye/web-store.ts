import type { WebPlan } from "@oraknid/contracts";
import { sameTask, shapeWeb } from "@oraknid/core";
import { asc, eq } from "drizzle-orm";
import type { Db } from "../db/open.ts";
import { jobs, taskEdges, tasks } from "../db/schema.ts";
import type { EventBus } from "../events/bus.ts";
import { newId } from "../ids.ts";
import type { SilkStore } from "../silk/store.ts";
import { requestEnding } from "./ending.ts";

// The Web, stored (The-Eye → Planning): a plan becomes tasks and the
// dependencies between them, made a sound graph first. Every way work
// enters a job goes through here: the plan, a replan, new work I ask for.

export interface WebStoreDeps {
  db: Db;
  bus: EventBus;
  silk: SilkStore;
  now: () => number;
}

/** A job's tasks in plan order, each with the ids it depends on. */
export function taskRows(db: Db, jobId: string) {
  const rows = db
    .select()
    .from(tasks)
    .where(eq(tasks.jobId, jobId))
    .orderBy(asc(tasks.position))
    .all();
  const edges = db
    .select({ taskId: taskEdges.taskId, dependsOn: taskEdges.dependsOn })
    .from(taskEdges)
    .innerJoin(tasks, eq(tasks.id, taskEdges.taskId))
    .where(eq(tasks.jobId, jobId))
    .all();
  return rows.map((t) => ({
    ...t,
    dependsOn: edges.filter((e) => e.taskId === t.id).map((e) => e.dependsOn),
  }));
}

export interface Stored {
  /** The new tasks' ids. */
  added: string[];
  /** Titles of planned tasks that were in The Web already, and so not added again. */
  known: string[];
}

/**
 * Turns a plan into tasks of The Web. A replan or new work adds to it and
 * never touches done tasks. The plan is shaped first (`shapeWeb`): the
 * same work twice merged, phases ordered, impossible dependencies dropped.
 * A task that is in The Web already is not added again (unfinished ones
 * only, unless `againstDone`: new work I ask for that is already done
 * isn't redone either); a dependency on it points at the one there.
 * `keyPrefix` keeps the keys of one source apart (my message's new work).
 */
export function storeWeb(
  d: WebStoreDeps,
  jobId: string,
  plan: WebPlan,
  o: { keyPrefix?: string; againstDone?: boolean; title?: string } = {},
): Stored {
  const job = d.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!job) return { added: [], known: [] };
  const existing = taskRows(d.db, jobId);
  const prefix = o.keyPrefix ?? "";
  const keyToId = new Map(
    existing.filter((t) => t.planKey).map((t) => [t.planKey as string, t.id]),
  );
  // Tasks of The Web the plan may name: by their key in an earlier plan, or by their id.
  const ids = new Set(existing.map((t) => t.id));
  const known = new Set([...ids, ...keyToId.keys()]);
  const { plan: shaped, notes } = shapeWeb(plan, known);
  const resolve = (key: string) =>
    keyToId.get(prefix + key) ?? keyToId.get(key) ?? (ids.has(key) ? key : null);
  const already: string[] = [];
  const added: string[] = [];
  let position = Math.max(-1, ...existing.map((t) => t.position)) + 1;
  d.bus.atomically(() => {
    for (const t of shaped.tasks) {
      if (keyToId.has(prefix + t.key)) continue;
      const twin = existing.find(
        (x) =>
          x.state !== "skipped" &&
          (o.againstDone || (x.state !== "done" && x.state !== "failed")) &&
          sameTask(x, t),
      );
      if (twin) {
        keyToId.set(prefix + t.key, twin.id);
        already.push(twin.title);
        continue;
      }
      const id = newId(d.now());
      keyToId.set(prefix + t.key, id);
      added.push(id);
      d.db
        .insert(tasks)
        .values({
          id,
          jobId,
          title: t.title,
          instructions: t.instructions,
          kind: t.kind,
          scope: t.scope,
          verify: t.verify,
          requiredCapabilities: t.requiredCapabilities,
          difficulty: t.difficulty,
          state: "pending",
          position: position++,
          planKey: prefix + t.key,
        })
        .run();
    }
    for (const t of shaped.tasks) {
      const from = keyToId.get(prefix + t.key);
      // Only new tasks get dependencies here: one already in The Web keeps its own.
      if (!from || !added.includes(from)) continue;
      for (const dep of t.dependsOn) {
        const to = resolve(dep);
        if (to && to !== from)
          d.db
            .insert(taskEdges)
            .values({ taskId: from, dependsOn: to })
            .onConflictDoNothing()
            .run();
      }
    }
    const verify = [...new Set([...job.verify, ...plan.jobVerify])];
    // Merging and pushing, as the goal asked: Oraknid's own steps at the end, never tasks.
    requestEnding(d.db, jobId, plan.ending, "the goal");
    d.db
      .update(jobs)
      .set({ webVersion: job.webVersion + 1, verify })
      .where(eq(jobs.id, jobId))
      .run();
    d.bus.publish({
      type: "web.updated",
      topic: `job:${jobId}`,
      jobId,
      payload: { version: job.webVersion + 1, added: added.length },
    });
  });
  const title = (key: string) => {
    const id = resolve(key);
    return taskRows(d.db, jobId).find((t) => t.id === id)?.title ?? key;
  };
  const lines = shaped.tasks
    .filter((t) => added.includes(keyToId.get(prefix + t.key) ?? ""))
    .map(
      (t) =>
        `- **${t.title}** (${t.kind}, ${t.difficulty})${t.dependsOn.length ? ` — after ${t.dependsOn.map((k) => `“${title(k)}”`).join(", ")}` : ""}`,
    );
  d.silk.add({
    jobId,
    kind: "decision",
    title: o.title ?? (job.webVersion === 0 ? "The plan" : `Plan, version ${job.webVersion + 1}`),
    body: [
      plan.summary,
      lines.join("\n"),
      already.length
        ? `Already in the plan, not added again: ${[...new Set(already)].map((x) => `“${x}”`).join(", ")}.`
        : "",
      notes.length ? `Mended by Oraknid:\n${notes.map((n) => `- ${n}`).join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    authoredBy: "eye",
  });
  return { added, known: [...new Set(already)] };
}
