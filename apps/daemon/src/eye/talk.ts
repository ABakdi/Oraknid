import type { EyeMessage } from "@oraknid/contracts";
import { asc, eq } from "drizzle-orm";
import type { Db } from "../db/open.ts";
import { eyeMessages, jobs, projects, taskEdges, tasks } from "../db/schema.ts";
import type { JobRunner } from "../engine/runner.ts";
import type { EventBus } from "../events/bus.ts";
import { newId } from "../ids.ts";
import type { SilkStore } from "../silk/store.ts";
import type { EyeBrain, EyeTriage } from "./brain.ts";
import { editWeb } from "./controls.ts";

// Talking to The Eye (The-Eye → Talking to The Eye, Checkpoint 1 → F1-4):
// I write; one short reasoning call decides what my message is; this code
// does the rest, deterministically, and answers me in a line.

export interface TalkDeps {
  db: Db;
  bus: EventBus;
  silk: SilkStore;
  runner: JobRunner;
  brain: EyeBrain;
  tmpDir: string;
  now?: () => number;
}

const ENDED = new Set(["completed", "cancelled"]);
const RUNNING = new Set(["interviewing", "planning", "running", "verifying", "waiting"]);

/**
 * Messages for the agents working now, per job. A running attempt takes
 * the ones newer than its start at its next turn end and passes them on
 * (they are in Silk too, for every later session).
 */
const guidance = new Map<string, { seq: number; text: string }[]>();
let guidanceSeq = 0;

export function forgetGuidance(jobId: string) {
  guidance.delete(jobId);
}

export function guidanceMark(): number {
  return guidanceSeq;
}

/** The guidance for a job newer than `after`, and the new mark. */
export function takeGuidance(jobId: string, after: number): { text: string | null; mark: number } {
  const fresh = (guidance.get(jobId) ?? []).filter((g) => g.seq > after);
  if (!fresh.length) return { text: null, mark: after };
  return {
    text: `A message from the owner of this job, passed on by The Eye. Take it into account from now on, then go on with the task:\n\n${fresh.map((g) => g.text).join("\n\n")}`,
    mark: Math.max(...fresh.map((g) => g.seq)),
  };
}

function tellRunning(jobId: string, text: string) {
  const list = guidance.get(jobId) ?? [];
  list.push({ seq: ++guidanceSeq, text });
  guidance.set(jobId, list.slice(-20));
}

export function conversation(db: Db, jobId: string): EyeMessage[] {
  return db
    .select()
    .from(eyeMessages)
    .where(eq(eyeMessages.jobId, jobId))
    .orderBy(asc(eyeMessages.createdAt), asc(eyeMessages.id))
    .all() as EyeMessage[];
}

/**
 * Records my message and lets The Eye handle it in the background; its
 * reply arrives as an `eye.replied` event. Returns my message's id.
 */
export function talk(d: TalkDeps, jobId: string, text: string): string {
  const job = d.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!job) throw new Error(`No job ${jobId}.`);
  const id = add(d, jobId, "owner", text, null);
  respond(d, jobId, text);
  return id;
}

/**
 * On start: a message of mine a crash left without a reply is handled now,
 * never lost (Audit 1 → D1-11). Returns how many were picked up.
 */
export function resumeConversations(d: TalkDeps): number {
  let n = 0;
  for (const { jobId } of d.db
    .selectDistinct({ jobId: eyeMessages.jobId })
    .from(eyeMessages)
    .all()) {
    const last = conversation(d.db, jobId).at(-1);
    if (last?.author !== "owner") continue;
    respond(d, jobId, last.text);
    n++;
  }
  return n;
}

function respond(d: TalkDeps, jobId: string, text: string) {
  void handle(d, jobId, text).catch((error) => {
    // Fail safe: my words are never lost. They are kept as my decision.
    const entry = d.silk.add({
      jobId,
      kind: "decision",
      title: `My note: ${firstLine(text)}`,
      body: text,
      authoredBy: "owner",
    });
    tellRunning(jobId, text);
    add(
      d,
      jobId,
      "eye",
      `I couldn't think about it just now (${error instanceof Error ? error.message : String(error)}), so I kept it as your decision; the agents will read it.`,
      {
        intent: "instruction",
        did: ["Recorded as your decision"],
        silkIds: [entry.id],
        taskIds: [],
      },
    );
  });
}

async function handle(d: TalkDeps, jobId: string, text: string) {
  const job = d.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!job) return;
  const project = d.db.select().from(projects).where(eq(projects.id, job.projectId)).get();
  const all = d.db
    .select()
    .from(tasks)
    .where(eq(tasks.jobId, jobId))
    .orderBy(asc(tasks.position))
    .all();
  const edges = d.db
    .select({ taskId: taskEdges.taskId, dependsOn: taskEdges.dependsOn })
    .from(taskEdges)
    .innerJoin(tasks, eq(tasks.id, taskEdges.taskId))
    .where(eq(tasks.jobId, jobId))
    .all();
  const state = [
    `The job is ${job.state}${job.pauseReason ? ` (${job.pauseReason})` : ""}${job.blockedReason ? ` (${job.blockedReason})` : ""}.`,
    all.length
      ? `Tasks:\n${all
          .map((t) => {
            const deps = edges.filter((e) => e.taskId === t.id).map((e) => e.dependsOn);
            return `- [${t.id}] ${t.title}: ${t.state}${deps.length ? ` (after ${deps.join(", ")})` : ""}`;
          })
          .join("\n")}`
      : "No tasks yet.",
  ].join("\n");
  const silk = d.silk
    .current(jobId)
    .filter((e) => e.kind !== "handoff")
    .slice(-40)
    .map((e) => `## ${e.kind}: ${e.title}\n${e.body.slice(0, 800)}`)
    .join("\n\n");
  const talkSoFar = conversation(d.db, jobId)
    .slice(-11, -1)
    .map((m) => `${m.author === "owner" ? "Owner" : "You"}: ${m.text}`)
    .join("\n");
  const verdict = await d.brain.triage({
    jobId,
    cwd: job.worktree ?? project?.workspacePath ?? process.cwd(),
    goal: job.goal,
    state,
    silk,
    conversation: talkSoFar,
    message: text,
  });
  await act(d, jobId, job.state, text, verdict);
}

async function act(d: TalkDeps, jobId: string, jobState: string, text: string, v: EyeTriage) {
  const did: string[] = [];
  const silkIds: string[] = [];
  const taskIds: string[] = [];
  const keep = (
    kind: "decision" | "architecture" | "fact" | "later",
    title: string,
    body: string,
  ) => {
    const e = d.silk.add({ jobId, kind, title, body, authoredBy: "owner" });
    silkIds.push(e.id);
  };
  let reply = v.reply;
  switch (v.intent) {
    case "instruction":
      keep("decision", v.silk?.title ?? `My instruction: ${firstLine(text)}`, v.silk?.body ?? text);
      did.push("Recorded as your decision");
      if (RUNNING.has(jobState)) {
        tellRunning(jobId, text);
        did.push("Passed to the agents working now");
      }
      break;
    case "context":
      keep(
        v.silk?.kind === "architecture" ? "architecture" : "fact",
        v.silk?.title ?? firstLine(text),
        v.silk?.body ?? text,
      );
      did.push(v.silk?.kind === "architecture" ? "Kept as architecture" : "Kept as a fact");
      break;
    case "later":
      keep("later", v.silk?.title ?? firstLine(text), v.silk?.body ?? text);
      did.push("Kept for later");
      break;
    case "task": {
      if (ENDED.has(jobState)) {
        keep("later", v.silk?.title ?? firstLine(text), v.silk?.body ?? text);
        did.push("Kept for later: the job has ended");
        reply = `${reply} The job has ended, so I kept it for later instead.`;
        break;
      }
      if (!v.tasks.length) {
        keep("decision", v.silk?.title ?? firstLine(text), v.silk?.body ?? text);
        did.push("Recorded as your decision");
        break;
      }
      const before = new Set(
        d.db
          .select({ id: tasks.id })
          .from(tasks)
          .where(eq(tasks.jobId, jobId))
          .all()
          .map((t) => t.id),
      );
      const known = new Set(before);
      editWeb(
        { db: d.db, bus: d.bus, runner: d.runner, silk: d.silk, tmpDir: d.tmpDir },
        jobId,
        v.tasks.map((t) => ({
          op: "add" as const,
          ...t,
          dependsOn: t.dependsOn.filter((x) => known.has(x)),
        })),
      );
      for (const t of d.db.select({ id: tasks.id }).from(tasks).where(eq(tasks.jobId, jobId)).all())
        if (!before.has(t.id)) taskIds.push(t.id);
      did.push(v.tasks.length === 1 ? "Added a task" : `Added ${v.tasks.length} tasks`);
      break;
    }
    case "stop":
      if (RUNNING.has(jobState)) {
        await d.runner.pause(jobId, "Paused because I asked The Eye to stop.");
        did.push("Pausing the job at the next safe point");
      } else did.push("Nothing to stop: the job isn't running");
      break;
    case "question":
      break;
  }
  add(d, jobId, "eye", reply, { intent: v.intent, did, silkIds, taskIds });
}

function add(
  d: TalkDeps,
  jobId: string,
  author: "owner" | "eye",
  text: string,
  action: EyeMessage["action"],
): string {
  const id = newId((d.now ?? Date.now)());
  d.bus.atomically(() => {
    d.db
      .insert(eyeMessages)
      .values({ id, jobId, author, text, action, createdAt: (d.now ?? Date.now)() })
      .run();
    d.bus.publish({
      type: author === "owner" ? "eye.message" : "eye.replied",
      topic: `job:${jobId}`,
      jobId,
      payload: {
        id,
        text: text.slice(0, 200),
        ...(action ? { intent: action.intent, did: action.did } : {}),
      },
      actor: author === "owner" ? "owner" : "eye",
    });
  });
  return id;
}

const firstLine = (s: string) => (s.split("\n")[0] ?? s).slice(0, 80);
