import { Capability, Difficulty, TaskKind } from "@oraknid/contracts";
import { asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/open.ts";
import { jobs, projects, taskEdges, tasks } from "../db/schema.ts";
import type { JobRunner } from "../engine/runner.ts";
import type { EventBus } from "../events/bus.ts";
import { newId } from "../ids.ts";
import type { SilkStore } from "../silk/store.ts";
import { rollback, shadowRepo, worktreeGit } from "../workspace/git.ts";

// My controls over a job's work (Jobs-and-Projects → Controls, BR-18).

const BUSY = new Set(["assigned", "running", "verifying"]);

export interface ControlDeps {
  db: Db;
  bus: EventBus;
  runner: JobRunner;
  silk: SilkStore;
  tmpDir: string;
}

function task(d: ControlDeps, id: string) {
  const t = d.db.select().from(tasks).where(eq(tasks.id, id)).get();
  if (!t) throw new Error(`No task ${id}.`);
  return t;
}

const emit = (d: ControlDeps, jobId: string, type: string, payload: Record<string, unknown>) =>
  d.bus.publish({ type, topic: `job:${jobId}`, jobId, payload, actor: "owner" });

/** Pins a task to a Leg model, or lets routing choose again (null). */
export function pin(d: ControlDeps, taskId: string, legModelId: string | null) {
  const t = task(d, taskId);
  d.db.update(tasks).set({ pinnedModelId: legModelId }).where(eq(tasks.id, taskId)).run();
  emit(d, t.jobId, "task.pinned", { taskId, legModelId });
}

/** I take a task over: Oraknid leaves it alone until I hand it back. A running task is paused first. */
export async function takeOver(d: ControlDeps, taskId: string) {
  const t = task(d, taskId);
  if (t.state === "done" || t.state === "skipped")
    throw new Error("That task is already finished.");
  const wasRunning = BUSY.has(t.state);
  if (wasRunning) await d.runner.pause(t.jobId, "Pausing so I can take a task over.");
  d.db.update(tasks).set({ ownerHeld: true, state: "paused" }).where(eq(tasks.id, taskId)).run();
  emit(d, t.jobId, "task.state", { taskId, to: "paused", reason: "I took it over." });
  if (wasRunning) await d.runner.resume(t.jobId);
}

/** I hand a task back: done (I finished it) or ready for Oraknid again. */
export async function handBack(d: ControlDeps, taskId: string, finished: boolean) {
  const t = task(d, taskId);
  if (!t.ownerHeld) throw new Error("That task is not mine.");
  d.db
    .update(tasks)
    .set({ ownerHeld: false, state: finished ? "done" : "ready" })
    .where(eq(tasks.id, taskId))
    .run();
  if (finished) {
    d.silk.add({
      jobId: t.jobId,
      taskId,
      kind: "progress",
      title: `Done by me: ${t.title}`,
      body: "I finished this task myself.",
      authoredBy: "owner",
    });
  }
  emit(d, t.jobId, "task.state", {
    taskId,
    to: finished ? "done" : "ready",
    reason: finished ? "I finished it." : "Handed back.",
  });
  const job = d.db.select().from(jobs).where(eq(jobs.id, t.jobId)).get();
  if (job?.state === "blocked") await d.runner.resume(t.jobId);
}

/** Puts the job's worktree back to a task's checkpoint; only while the job isn't running. */
export function rollbackTask(d: ControlDeps, taskId: string, attempt: number) {
  const t = task(d, taskId);
  const job = d.db.select().from(jobs).where(eq(jobs.id, t.jobId)).get();
  if (!job?.worktree) throw new Error("That job has no worktree yet.");
  if (
    job.state === "running" ||
    job.state === "planning" ||
    job.state === "verifying" ||
    job.state === "interviewing"
  ) {
    throw new Error("Pause the job before rolling back.");
  }
  const project = d.db.select().from(projects).where(eq(projects.id, job.projectId)).get();
  const g = project?.shadow
    ? shadowRepo(job.worktree)
    : worktreeGit(project?.workspacePath ?? job.worktree, job.worktree);
  const result = rollback(
    g,
    `refs/oraknid/${job.id}/${taskId}/${attempt}`,
    d.tmpDir,
    `${project?.workspacePath}/.oraknid/trash`,
  );
  emit(d, t.jobId, "task.rolled-back", { taskId, attempt, ...result });
  return result;
}

export const WebEdit = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("update"),
    taskId: z.string(),
    title: z.string().min(1).optional(),
    instructions: z.string().min(1).optional(),
    scope: z.array(z.string().min(1)).optional(),
    verify: z.array(z.string().min(1)).optional(),
    difficulty: Difficulty.optional(),
    dependsOn: z.array(z.string()).optional(),
  }),
  z.object({
    op: z.literal("add"),
    title: z.string().min(1),
    instructions: z.string().min(1),
    kind: TaskKind,
    scope: z.array(z.string().min(1)),
    verify: z.array(z.string().min(1)),
    dependsOn: z.array(z.string()).default([]),
    difficulty: Difficulty.default("medium"),
    requiredCapabilities: z.array(Capability).min(1).default(["implementation"]),
  }),
  z.object({ op: z.literal("remove"), taskId: z.string() }),
]);
export type WebEdit = z.infer<typeof WebEdit>;

/** My edits to The Web (Web-UI → Plan editor): never on running or finished tasks. */
export function editWeb(d: ControlDeps, jobId: string, edits: WebEdit[]) {
  const job = d.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!job) throw new Error(`No job ${jobId}.`);
  if (job.state === "completed" || job.state === "cancelled")
    throw new Error("The job has ended; its plan can't change.");
  const all = d.db
    .select()
    .from(tasks)
    .where(eq(tasks.jobId, jobId))
    .orderBy(asc(tasks.position))
    .all();
  const mine = (id: string) => {
    const t = all.find((x) => x.id === id);
    if (!t) throw new Error(`Task ${id} is not in this job.`);
    if (BUSY.has(t.state))
      throw new Error(`"${t.title}" is running; pause the job or wait for it.`);
    if (t.state === "done" || t.state === "skipped")
      throw new Error(`"${t.title}" is finished; add a new task instead.`);
    return t;
  };
  d.bus.atomically(() => {
    let position = all.length;
    for (const e of edits) {
      if (e.op === "update") {
        mine(e.taskId);
        const { op: _op, taskId, dependsOn, ...set } = e;
        if (Object.keys(set).length) d.db.update(tasks).set(set).where(eq(tasks.id, taskId)).run();
        if (dependsOn) {
          d.db.delete(taskEdges).where(eq(taskEdges.taskId, taskId)).run();
          for (const dep of dependsOn)
            d.db.insert(taskEdges).values({ taskId, dependsOn: dep }).run();
        }
      } else if (e.op === "add") {
        const id = newId();
        d.db
          .insert(tasks)
          .values({
            id,
            jobId,
            title: e.title,
            instructions: e.instructions,
            kind: e.kind,
            scope: e.scope,
            verify: e.verify,
            requiredCapabilities: e.requiredCapabilities,
            difficulty: e.difficulty,
            state: "pending",
            position: position++,
          })
          .run();
        for (const dep of e.dependsOn)
          d.db.insert(taskEdges).values({ taskId: id, dependsOn: dep }).run();
      } else {
        mine(e.taskId);
        d.db.delete(taskEdges).where(eq(taskEdges.dependsOn, e.taskId)).run();
        d.db.delete(taskEdges).where(eq(taskEdges.taskId, e.taskId)).run();
        d.db.delete(tasks).where(eq(tasks.id, e.taskId)).run();
      }
    }
    // The edited Web obeys the same rules as a planned one (Audit 1 → Q1-10): applied, checked, undone if wrong.
    const after = d.db.select().from(tasks).where(eq(tasks.jobId, jobId)).all();
    const ids = new Set(after.map((t) => t.id));
    const deps = d.db
      .select()
      .from(taskEdges)
      .where(inArray(taskEdges.taskId, [...ids]))
      .all();
    const outside = deps.find((e) => !ids.has(e.dependsOn));
    if (outside) throw new Error("A task can only depend on tasks of the same job.");
    const problems = webProblems(
      after.map((t) => ({
        key: t.id,
        title: t.title,
        dependsOn: deps.filter((e) => e.taskId === t.id).map((e) => e.dependsOn),
      })),
    );
    if (problems.length) throw new Error(problems.join(" "));
    d.db
      .update(jobs)
      .set({ webVersion: job.webVersion + 1 })
      .where(eq(jobs.id, jobId))
      .run();
    emit(d, jobId, "web.updated", {
      version: job.webVersion + 1,
      edited: edits.length,
      by: "owner",
    });
  });
}

/** A new instruction for The Eye: kept in Silk as my decision, so every next session reads it. */
export function redirect(d: ControlDeps, jobId: string, instruction: string) {
  d.silk.add({
    jobId,
    kind: "decision",
    title: `Redirect: ${instruction.split("\n")[0]?.slice(0, 60)}`,
    body: instruction,
    authoredBy: "owner",
  });
  emit(d, jobId, "job.redirected", { instruction });
}

/** Self-dependencies and circles, named by task title. */
function webProblems(nodes: { key: string; title: string; dependsOn: string[] }[]): string[] {
  const title = new Map(nodes.map((n) => [n.key, n.title]));
  const problems = nodes
    .filter((n) => n.dependsOn.includes(n.key))
    .map((n) => `"${n.title}" can't depend on itself.`);
  const deps = new Map(nodes.map((n) => [n.key, n.dependsOn]));
  const state = new Map<string, "visiting" | "done">();
  const path: string[] = [];
  const visit = (k: string): string[] | null => {
    if (state.get(k) === "done") return null;
    if (state.get(k) === "visiting") return [...path.slice(path.indexOf(k)), k];
    state.set(k, "visiting");
    path.push(k);
    for (const dep of deps.get(k) ?? []) {
      if (dep === k) continue;
      const c = visit(dep);
      if (c) return c;
    }
    path.pop();
    state.set(k, "done");
    return null;
  };
  for (const n of nodes) {
    const c = visit(n.key);
    if (c) {
      problems.push(
        `The tasks would depend on each other in a circle: ${c.map((k) => title.get(k)).join(" → ")}.`,
      );
      break;
    }
  }
  return problems;
}
