import {
  chosenOption,
  completeAnswers,
  type EyeMessage,
  isProduction,
  normalizeQuestions,
  type Question,
  type QuestionAnswer,
  renderAnswers,
} from "@oraknid/contracts";
import { and, asc, desc, eq } from "drizzle-orm";
import type { Db } from "../db/open.ts";
import {
  eyeMessages,
  inboxItems,
  jobs,
  projects,
  servers,
  taskEdges,
  tasks,
} from "../db/schema.ts";
import type { JobRunner } from "../engine/runner.ts";
import type { EventBus } from "../events/bus.ts";
import { newId } from "../ids.ts";
import type { InboxStore } from "../inbox/store.ts";
import type { SilkStore } from "../silk/store.ts";
import { viewOf } from "../workspace/projects.ts";
import { isSeveral } from "../workspace/repos.ts";
import type { EyeBrain, EyeTriage } from "./brain.ts";
import { editWeb } from "./controls.ts";
import { type EndingDone, requestEnding } from "./ending.ts";

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
  /**
   * New work on an ended job (Jobs-and-Projects → Follow-up jobs): a new
   * job in the same project, starting from this one's branch, started.
   * Returns its id.
   */
  followUp?: (fromJobId: string, goal: string) => Promise<string>;
  /**
   * A project with no job to talk to (ADR-034): a new job in it, its goal my
   * message, made a draft. Returns its id.
   */
  newJob?: (projectId: string, goal: string) => string;
  /** Starts a job made by `newJob`; throws a sentence when it can't. */
  startJob?: (jobId: string) => Promise<void>;
  /**
   * Merging and pushing an ended job's work now, as I asked (Jobs-and-Projects
   * → Ending a job): Oraknid's own steps, never a task. Returns what it did.
   */
  endNow?: (jobId: string) => Promise<EndingDone>;
}

const ENDED = new Set(["completed", "cancelled"]);
const PASSED = "Passed to the follow-up job";
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
 * The project's conversation (ADR-034): its messages from every job that
 * has started, in order. A message an ended job passed to its follow-up is
 * shown once, where the follow-up answered it.
 */
export function projectConversation(db: Db, projectId: string): EyeMessage[] {
  const started = new Set(
    db
      .select({ id: jobs.id, state: jobs.state })
      .from(jobs)
      .where(eq(jobs.projectId, projectId))
      .all()
      .filter((j) => j.state !== "draft")
      .map((j) => j.id),
  );
  const all = (
    db
      .select()
      .from(eyeMessages)
      .where(eq(eyeMessages.projectId, projectId))
      .orderBy(asc(eyeMessages.createdAt), asc(eyeMessages.id))
      .all() as EyeMessage[]
  ).filter((m) => started.has(m.jobId));
  const hidden = new Set<string>();
  for (const [i, m] of all.entries()) {
    if (!m.action?.did.includes(PASSED)) continue;
    hidden.add(m.id);
    // My message it answered: the last of mine in the same job before it.
    for (let k = i - 1; k >= 0; k--) {
      const prev = all[k] as EyeMessage;
      if (prev.jobId === m.jobId && prev.author === "owner") {
        hidden.add(prev.id);
        break;
      }
    }
  }
  return all.filter((m) => !hidden.has(m.id));
}

/** The job a project's conversation talks to now: the newest going, else the newest ended. */
export function projectTarget(db: Db, projectId: string) {
  const list = db
    .select()
    .from(jobs)
    .where(eq(jobs.projectId, projectId))
    .orderBy(desc(jobs.createdAt), desc(jobs.id))
    .all()
    .filter((j) => j.state !== "draft");
  return list.find((j) => !ENDED.has(j.state)) ?? list[0] ?? null;
}

/**
 * My message to a project's Eye (ADR-034): to the job going now, as on its
 * own; else to the newest ended job, where new work starts a follow-up;
 * else, with no job yet, a new job is made from it and started. Returns my
 * message's id and the job it went to.
 */
export async function talkInProject(
  d: TalkDeps,
  projectId: string,
  text: string,
  extras: MessageExtras = {},
): Promise<{ id: string; jobId: string }> {
  const project = d.db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) throw new Error(`No project ${projectId}.`);
  const target = projectTarget(d.db, projectId);
  if (target) return { id: talk(d, target.id, text, extras), jobId: target.id };
  if (project.archivedAt) throw new Error("The project is archived: restore it to ask for work.");
  if (!d.newJob || !d.startJob) throw new Error("New work can't start from here.");
  const jobId = d.newJob(projectId, text);
  const id = add(d, jobId, "owner", text, null);
  const title = d.db.select({ t: jobs.title }).from(jobs).where(eq(jobs.id, jobId)).get()?.t;
  try {
    await d.startJob(jobId);
    add(d, jobId, "eye", `I started a job for this, “${title}”: I'll plan it, then get going.`, {
      intent: "task",
      did: ["Started a new job"],
      silkIds: [],
      taskIds: [],
      jobId,
    });
  } catch (e) {
    add(
      d,
      jobId,
      "eye",
      `I made a job for this, “${title}”, but couldn't start it: ${e instanceof Error ? e.message : String(e)} It waits as a draft in New work.`,
      { intent: "task", did: ["Kept as a draft"], silkIds: [], taskIds: [], jobId },
    );
  }
  return { id, jobId };
}

/**
 * Records my message and lets The Eye handle it in the background; its
 * reply arrives as an `eye.replied` event. Returns my message's id.
 */
export function talk(d: TalkDeps, jobId: string, text: string, extras: MessageExtras = {}): string {
  const job = d.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!job) throw new Error(`No job ${jobId}.`);
  const id = add(d, jobId, "owner", text, null, extras);
  respond(d, jobId, text);
  return id;
}

/** The message whose questions I answer, and whether I answered them already. */
function asked(db: Db, messageId: string) {
  const m = db.select().from(eyeMessages).where(eq(eyeMessages.id, messageId)).get();
  if (m?.author !== "eye" || !m.questions?.length) return null;
  const reply = db
    .select({ id: eyeMessages.id })
    .from(eyeMessages)
    .where(and(eq(eyeMessages.replyTo, messageId), eq(eyeMessages.author, "owner")))
    .get();
  return { message: m, answered: !!reply };
}

/**
 * My answers to The Eye's questions in the project's conversation (ADR-037):
 * kept structured, shown as a short list. Questions that belong to an inbox
 * item answer it (the job waiting on it goes on); others are a message of
 * mine like any, which The Eye reads.
 */
export function answerInProject(
  d: TalkDeps & { inbox: InboxStore },
  projectId: string,
  messageId: string,
  given: QuestionAnswer[],
  deviceId: string | null = null,
): { id: string; jobId: string } {
  const a = asked(d.db, messageId);
  if (!a || a.message.projectId !== projectId) throw new Error("No such question to answer.");
  if (a.answered) throw new Error("Those questions are answered already.");
  const questions = a.message.questions as Question[];
  const answers = completeAnswers(questions, given);
  const text = renderAnswers(questions, answers);
  if (a.message.itemId) {
    // An item's own option, chosen through the question that says what each does (ADR-045).
    const item = d.inbox.get(a.message.itemId);
    const chosen = item ? chosenOption(questions, answers, item.options) : null;
    if (chosen) d.inbox.answer(a.message.itemId, chosen, deviceId, null);
    else d.inbox.answer(a.message.itemId, text, deviceId, answers);
    const id = recordAnswer(d, a.message.itemId) ?? "";
    return { id, jobId: a.message.jobId };
  }
  return {
    id: talk(d, a.message.jobId, text, { answers, replyTo: messageId }),
    jobId: a.message.jobId,
  };
}

/**
 * An inbox item The Eye also asked in the conversation, answered (here or in
 * the inbox): my answers join the conversation as a short list, once.
 * Returns my message's id, or null when there is nothing to add.
 */
export function recordAnswer(
  d: Pick<TalkDeps, "db" | "bus" | "now">,
  itemId: string,
): string | null {
  const m = d.db.select().from(eyeMessages).where(eq(eyeMessages.itemId, itemId)).get();
  if (!m) return null;
  const a = asked(d.db, m.id);
  if (!a || a.answered) return null;
  const item = d.db.select().from(inboxItems).where(eq(inboxItems.id, itemId)).get();
  if (item?.state !== "answered") return null;
  const answers = item.answers ?? null;
  const text = answers?.length
    ? renderAnswers(m.questions as Question[], answers)
    : (item.answer ?? "");
  return add(d, m.jobId, "owner", text, null, { answers, replyTo: m.id });
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
    // My answer to a question a job waits on goes to that job, not to The Eye's triage.
    const to = last.replyTo
      ? d.db.select().from(eyeMessages).where(eq(eyeMessages.id, last.replyTo)).get()
      : null;
    if (to?.itemId) continue;
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
        jobId: null,
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
    `${ENDED.has(job.state) ? "ENDED. " : ""}The job is ${job.state}${job.pauseReason ? ` (${job.pauseReason})` : ""}${job.blockedReason ? ` (${job.blockedReason})` : ""}.`,
    all.length
      ? `Tasks:\n${all
          .map((t) => {
            const deps = edges.filter((e) => e.taskId === t.id).map((e) => e.dependsOn);
            return `- [${t.id}] ${t.title}: ${t.state}${deps.length ? ` (after ${deps.join(", ")})` : ""}`;
          })
          .join("\n")}`
      : "No tasks yet.",
    // Its repos and servers with their roles (ADR-042): a deploy names the one I named.
    project ? projectFacts(d.db, project) : "",
  ]
    .filter(Boolean)
    .join("\n");
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

/** What triage must know of the project: its repos when several, its servers by role (ADR-042). */
function projectFacts(db: Db, row: typeof projects.$inferSelect): string {
  const p = viewOf(row);
  const repos = isSeveral(p.repos)
    ? `The project is several repos: ${p.repos.map((r) => `${r.name} (${r.folder}/)`).join(", ")}; a task's scope starts with its repo's folder.`
    : "";
  const names = new Map(
    db
      .select({ id: servers.id, name: servers.name })
      .from(servers)
      .all()
      .map((s) => [s.id, s.name]),
  );
  const list = p.serverIds.flatMap((id) => {
    const name = names.get(id);
    if (!name) return [];
    const r = p.serverRoles[id];
    const role = [r?.role, isProduction(r) && !/^prod/i.test(r?.role ?? "") ? "production" : ""]
      .filter(Boolean)
      .join(", ");
    return [role ? `${name} (${role})` : name];
  });
  const srv = list.length
    ? `Its servers: ${list.join(", ")}. A task that deploys names in its title the server or the role I named ("Deploy to staging"); Oraknid confirms it with me.`
    : "";
  return [repos, srv].filter(Boolean).join("\n");
}

async function act(d: TalkDeps, jobId: string, jobState: string, text: string, triaged: EyeTriage) {
  let v = triaged;
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
  let jobRef: string | null = null;
  // Merge and push are Oraknid's own steps at the end, never tasks (after the piano job).
  const ending = v.ending?.merge || v.ending?.push ? v.ending : null;
  if (ending) {
    requestEnding(d.db, jobId, ending, "my message");
    if (ENDED.has(jobState) && d.endNow) {
      try {
        const done = await d.endNow(jobId);
        did.push(...endingWords(done));
        reply = endingReply(done);
      } catch (e) {
        did.push("Not done");
        reply = `I couldn't do it: ${e instanceof Error ? e.message : String(e)}`;
      }
    } else {
      did.push(
        ending.push ? "Oraknid pushes it when the job ends" : "Oraknid merges it when the job ends",
      );
    }
    // A request for the end steps alone adds no task.
    if (v.intent === "task") v = { ...v, tasks: v.tasks.filter((t) => !isEndStep(t.title)) };
    if (v.intent === "task" && !v.tasks.length) {
      add(
        d,
        jobId,
        "eye",
        reply,
        { intent: v.intent, did, silkIds, taskIds, jobId: jobRef },
        { questions: normalizeQuestions(v.questions ?? []) },
      );
      return;
    }
  }
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
        // A follow-up already working on it takes the message instead of a second one.
        const open = openFollowUp(d, jobId);
        if (open) {
          talk(d, open.id, text);
          did.push(PASSED);
          reply = `I passed this to the follow-up job, “${open.title}”, which is working now.`;
          jobRef = open.id;
          break;
        }
        if (!d.followUp) {
          keep("later", v.silk?.title ?? firstLine(text), v.silk?.body ?? text);
          did.push("Kept for later: the job has ended");
          reply = `${reply} The job has ended, so I kept it for later instead.`;
          break;
        }
        const plan = v.tasks.length
          ? `\n\nWhat I'd do, in tasks:\n${v.tasks.map((t) => `- ${t.title}: ${t.instructions}`).join("\n")}`
          : "";
        try {
          jobRef = await d.followUp(jobId, `${text}${plan}`);
          did.push("Started a follow-up job");
          reply = `This job had ended, so I started a follow-up job in the same project, starting from what it built. ${v.reply}`;
        } catch (e) {
          keep("later", v.silk?.title ?? firstLine(text), v.silk?.body ?? text);
          did.push("Kept for later");
          reply = `I couldn't start a follow-up job: ${e instanceof Error ? e.message : String(e)} I kept your request for later.`;
        }
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
  add(
    d,
    jobId,
    "eye",
    reply,
    { intent: v.intent, did, silkIds, taskIds, jobId: jobRef },
    { questions: normalizeQuestions(v.questions ?? []) },
  );
}

/** A task that only merges, commits into a branch or pushes: Oraknid's own step, not a task. */
const isEndStep = (title: string) =>
  /\b(merge|commit)\b.*\b(into|onto|to|on)\s+(the\s+)?(dev|main|master|develop|work)\b|\bpush(es|ing)?\b.*\b(github|origin|remote|branch)\b/i.test(
    title,
  );

/** What the end steps did, as the conversation's "did" words. */
function endingWords(done: EndingDone): string[] {
  return [
    ...(done.merged ? [`Merged into ${done.merged.into}`] : []),
    ...done.pushed.map((p) => `Pushed ${p.branch} to ${p.repo}`),
    ...(done.problems.length ? ["Not everything was done"] : []),
  ];
}

function endingReply(done: EndingDone): string {
  const parts = [
    done.merged ? `I merged the job into **${done.merged.into}**.` : "",
    ...done.pushed.map((p) => `I pushed **${p.branch}** to [${p.repo}](${p.url}).`),
    ...done.problems.map((x) => `Not done: ${x}`),
  ].filter(Boolean);
  return parts.join(" ") || "There was nothing to merge or push.";
}

/** The follow-up job this conversation started, while it hasn't ended. */
function openFollowUp(d: TalkDeps, jobId: string) {
  for (const m of conversation(d.db, jobId).reverse()) {
    const id = m.action?.jobId;
    if (!id) continue;
    const j = d.db.select().from(jobs).where(eq(jobs.id, id)).get();
    return j && !ENDED.has(j.state) ? j : null;
  }
  return null;
}

/** Questions with options in The Eye's message, or my answers to them (ADR-037). */
export interface MessageExtras {
  questions?: Question[] | null;
  itemId?: string | null;
  answers?: QuestionAnswer[] | null;
  replyTo?: string | null;
}

/** A message in a job's conversation (and so its project's). Returns its id. */
export function addMessage(
  d: Pick<TalkDeps, "db" | "bus" | "now">,
  jobId: string,
  author: "owner" | "eye",
  text: string,
  action: EyeMessage["action"],
  extras: MessageExtras = {},
): string {
  return add(d, jobId, author, text, action, extras);
}

function add(
  d: Pick<TalkDeps, "db" | "bus" | "now">,
  jobId: string,
  author: "owner" | "eye",
  text: string,
  action: EyeMessage["action"],
  extras: MessageExtras = {},
): string {
  const id = newId((d.now ?? Date.now)());
  const projectId =
    d.db.select({ p: jobs.projectId }).from(jobs).where(eq(jobs.id, jobId)).get()?.p ?? "";
  d.bus.atomically(() => {
    d.db
      .insert(eyeMessages)
      .values({
        id,
        jobId,
        projectId,
        author,
        text,
        action,
        questions: extras.questions?.length ? extras.questions : null,
        itemId: extras.itemId ?? null,
        answers: extras.answers ?? null,
        replyTo: extras.replyTo ?? null,
        createdAt: (d.now ?? Date.now)(),
      })
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
