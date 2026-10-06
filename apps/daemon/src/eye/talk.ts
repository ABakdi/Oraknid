import type { TalkMode } from "@oraknid/contracts";
import {
  chosenOption,
  completeAnswers,
  type EyeMessage,
  type InboxItem,
  isProduction,
  normalizeQuestions,
  type Question,
  type QuestionAnswer,
  renderAnswers,
  renderQuestions,
  type WebPlan,
} from "@oraknid/contracts";
import { correctsThinking, endsInterview } from "@oraknid/core";
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
import { type EndingDone, requestEnding } from "./ending.ts";
import { ENOUGH, INTERVIEW_ENDED, ROUND_TITLE } from "./interview.ts";
import { BrainStopped, type EyeThinking, PROGRAM_CALLS } from "./thinking.ts";
import { storeWeb, taskRows } from "./web-store.ts";

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
   * The inbox: a message of mine can answer what the job waits on, or end
   * its interview (after the piano job, 2026-10-04). Without it, open
   * items are left to the inbox.
   */
  inbox?: InboxStore;
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
  /** What The Eye is thinking now (M13.25): a message of mine can stop it or add to it. */
  thinking?: EyeThinking;
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
  mode: TalkMode = "context",
): Promise<{ id: string; jobId: string }> {
  const project = d.db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) throw new Error(`No project ${projectId}.`);
  const target = projectTarget(d.db, projectId);
  if (target) return { id: talk(d, target.id, text, extras, mode), jobId: target.id };
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
export function talk(
  d: TalkDeps,
  jobId: string,
  text: string,
  extras: MessageExtras = {},
  /** While The Eye thinks (M13.25): "context" by default, as before; the page sends "auto". */
  mode: TalkMode = "context",
): string {
  const job = d.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!job) throw new Error(`No job ${jobId}.`);
  // While The Eye thinks about this job (The-Eye → Thinking out loud): a message that corrects
  // it stops the thinking and has it think again with my words; anything else is read as
  // usual, and added for the job's next call that plans or judges.
  const busy =
    d.thinking && !extras.answers ? d.thinking.running([jobId]).filter((t) => t.interruptible) : [];
  const redo = busy.length > 0 && (mode === "redo" || (mode === "auto" && correctsThinking(text)));
  const id = add(d, jobId, "owner", text, null, extras);
  if (redo && rethink(d, jobId, job.state, text)) return id;
  if (busy.length) d.thinking?.note(jobId, text);
  respond(d, jobId, text, id);
  return id;
}

/** Said when The Eye stopped to think again with my words: a crash after it answers the message before. */
const RETHINK = "Thinking again with your message";

/**
 * My correction while The Eye thinks (M13.25): what it is thinking is
 * stopped and thought again with my words in its prompt; my words are kept
 * as my decision (a crash reruns the call, which reads them there) and
 * passed to the agents working now. False when nothing was thinking any
 * more: the message is then read as any other.
 */
function rethink(d: TalkDeps, jobId: string, jobState: string, text: string): boolean {
  const hit = d.thinking?.interrupt(jobId, { kind: "redo", text }) ?? [];
  if (!hit.length) return false;
  const entry = d.silk.add({
    jobId,
    kind: "decision",
    title: `My correction: ${firstLine(text)}`,
    body: text,
    authoredBy: "owner",
  });
  const did = ["Stopped The Eye's thinking", RETHINK, "Recorded as your decision"];
  if (RUNNING.has(jobState)) {
    tellRunning(jobId, text);
    did.push("Passed to the agents working now");
  }
  const what = hit.map((t) => t.purpose.charAt(0).toLowerCase() + t.purpose.slice(1)).join(", ");
  add(d, jobId, "eye", `Stopped ${what}: thinking again with what you said.`, {
    intent: "instruction",
    did,
    silkIds: [entry.id],
    taskIds: [],
    jobId: null,
  });
  return true;
}

/**
 * Stop: what The Eye is thinking about these jobs now ends (M13.25). A
 * job's own step (a plan, the interview, a review) pauses the job first, so
 * the call is a safe point and is thought again on resume; reading my
 * message just ends. Returns how many calls it stopped.
 */
export function stopThinking(d: TalkDeps, jobIds: string[]): number {
  let n = 0;
  for (const jobId of jobIds) {
    const running = (d.thinking?.running([jobId]) ?? []).filter((t) => t.interruptible);
    if (!running.length) continue;
    const pauses = running.some((t) => PROGRAM_CALLS.has(t.call));
    if (pauses)
      void d.runner
        .pause(jobId, "Paused because I stopped The Eye's thinking. Resume to have it think again.")
        .catch(() => {});
    const hit = d.thinking?.interrupt(jobId, { kind: "stop" }) ?? [];
    if (!hit.length) continue;
    n += hit.length;
    const what = hit.map((t) => t.purpose.charAt(0).toLowerCase() + t.purpose.slice(1)).join(", ");
    add(
      d,
      jobId,
      "eye",
      pauses
        ? `Stopped ${what}, as you asked. The job is paused: resume it and I'll think again, with anything you tell me here.`
        : `Stopped ${what}, as you asked.`,
      {
        intent: "stop",
        did: pauses
          ? ["Stopped The Eye's thinking", "Paused the job"]
          : ["Stopped The Eye's thinking"],
        silkIds: [],
        taskIds: [],
        jobId: null,
      },
    );
  }
  return n;
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
    const list = conversation(d.db, jobId);
    let k = list.length - 1;
    // Stopped to think again with my words (M13.25): what it was reading before is still to answer.
    while (
      k >= 1 &&
      list[k]?.author === "eye" &&
      list[k]?.action?.did.includes(RETHINK) &&
      list[k - 1]?.author === "owner"
    )
      k -= 2;
    const last = list[k];
    if (last?.author !== "owner") continue;
    // My answer to a question a job waits on goes to that job, not to The Eye's triage.
    const to = last.replyTo
      ? d.db.select().from(eyeMessages).where(eq(eyeMessages.id, last.replyTo)).get()
      : null;
    if (to?.itemId) continue;
    respond(d, jobId, last.text, last.id);
    n++;
  }
  return n;
}

function respond(d: TalkDeps, jobId: string, text: string, messageId: string) {
  void handle(d, jobId, text, messageId).catch((error) => {
    // I stopped it: said once where I stopped it, nothing kept (M13.25).
    if (error instanceof BrainStopped) return;
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

async function handle(d: TalkDeps, jobId: string, text: string, messageId: string) {
  const job = d.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!job) return;
  // What the job waits on me for now: my message may answer it (after the piano job, 2026-10-04).
  const open = ENDED.has(job.state) ? [] : (d.inbox?.list({ jobId, state: "open" }) ?? []);
  const round = open.find((i) => ROUND_TITLE.test(i.title));
  // No plan yet: new work I ask for is guidance for the plan, never tasks of its own.
  const unplanned = !ENDED.has(job.state) && job.webVersion === 0;
  // "Start now", "enough, the interview is over": over at once, whatever any model thinks.
  if (endsInterview(text) && unplanned && (round || job.state === "interviewing")) {
    endInterview(d, jobId, messageId, text, round ?? null);
    return;
  }
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
    ...(open.length ? { open: openItems(open) } : {}),
    ...(unplanned ? { unplanned } : {}),
  });
  await act(d, jobId, job.state, text, verdict, { messageId, open, unplanned });
}

/** The items a job waits on, for the triage: each with its id, its questions or its options. */
function openItems(open: InboxItem[]): string {
  return open
    .map((i) => {
      const what = i.questions?.length
        ? `\n${renderQuestions(i.questions as Question[])
            .split("\n")
            .map((l) => `  ${l}`)
            .join("\n")}`
        : i.options.length
          ? ` Answered with one of: ${i.options.join(", ")}.`
          : "";
      return `- [${i.id}] “${i.title}” (${i.kind}${ROUND_TITLE.test(i.title) ? ", an interview round" : ""})${i.detail ? `: ${i.detail.split("\n").filter(Boolean).slice(-1)[0]?.slice(0, 300) ?? ""}` : ""}${what}`;
    })
    .join("\n");
}

/** The Eye's message that asked an item in the conversation, if it did. */
const askedFor = (db: Db, itemId: string) =>
  db.select().from(eyeMessages).where(eq(eyeMessages.itemId, itemId)).get() ?? null;

/**
 * An inbox item answered by my message in the conversation: my words,
 * verbatim (an approval with the option I chose), and my message recorded
 * as the answer where The Eye asked it, so nothing is said twice. The job
 * waiting on it goes on.
 */
function answerBy(d: TalkDeps, messageId: string, item: InboxItem, answer: string): boolean {
  if (!d.inbox) return false;
  const asked = askedFor(d.db, item.id);
  if (asked)
    d.db.update(eyeMessages).set({ replyTo: asked.id }).where(eq(eyeMessages.id, messageId)).run();
  try {
    d.inbox.answer(item.id, answer, null, null);
    return true;
  } catch {
    // Answered meanwhile, or withdrawn: nothing waits on it any more.
    return false;
  }
}

/**
 * The interview ended by my message: the open round is answered with my
 * words (which say to end it), or, with none open, the next isn't asked.
 * Planning starts with what's known; what was asked is assumed or left open.
 */
function endInterview(
  d: TalkDeps,
  jobId: string,
  messageId: string,
  text: string,
  round: InboxItem | null,
) {
  const answered = round
    ? answerBy(d, messageId, round, endsInterview(text) ? text : ENOUGH)
    : false;
  if (!answered)
    d.silk.add({
      jobId,
      kind: "decision",
      title: INTERVIEW_ENDED,
      body: text,
      authoredBy: "owner",
    });
  add(
    d,
    jobId,
    "eye",
    "Understood: the interview is over. I'm planning with what I know now; the plan says what I assumed, and you can correct any of it here.",
    {
      intent: "instruction",
      did: [round && answered ? `Ended “${round.title}”` : "Ended the interview"],
      silkIds: [],
      taskIds: [],
      jobId: null,
    },
  );
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

async function act(
  d: TalkDeps,
  jobId: string,
  jobState: string,
  text: string,
  triaged: EyeTriage,
  at: { messageId: string; open: InboxItem[]; unplanned: boolean } = {
    messageId: "",
    open: [],
    unplanned: false,
  },
) {
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
  // What my message does to what the job waits on: answers it, or ends the interview (after the piano job).
  const target = v.item ? at.open.find((i) => i.id === v.item?.id) : undefined;
  if (target && v.item && v.item.does !== "unrelated") {
    if (v.item.does === "ends-interview" && ROUND_TITLE.test(target.title)) {
      endInterview(d, jobId, at.messageId, text, target);
      return;
    }
    const answer =
      target.kind === "approval"
        ? v.item.option && target.options.includes(v.item.option)
          ? v.item.option
          : null
        : text;
    if (answer && answerBy(d, at.messageId, target, answer)) {
      did.push(`Answered “${target.title}” with your message`);
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
  // Still waiting on me: said in one line, the question left where it is.
  const waiting = at.open[0];
  if (waiting && !reply.includes(waiting.title))
    reply = `${reply} I'm still waiting for your answer to “${waiting.title}”.`;
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
      // No plan yet: the plan will include it; never tasks that bypass the planner.
      if (at.unplanned) {
        keep("decision", `For the plan: ${firstLine(text)}`, v.silk?.body ?? text);
        did.push("Kept for the plan");
        break;
      }
      const work = await addWork(d, jobId, at.messageId, text, v).catch((e: unknown) => {
        if (e instanceof BrainStopped) throw e;
        reply = `${reply} I couldn't plan it into the job just now (${e instanceof Error ? e.message : String(e)}), so I kept it as your decision.`;
        return null;
      });
      if (!work) {
        keep("decision", v.silk?.title ?? firstLine(text), v.silk?.body ?? text);
        did.push("Recorded as your decision");
        break;
      }
      taskIds.push(...work.added);
      if (work.added.length)
        did.push(work.added.length === 1 ? "Added a task" : `Added ${work.added.length} tasks`);
      if (work.known.length) {
        did.push("Already in the plan");
        if (!work.added.length)
          reply = `That's in the plan already: ${work.known.map((t) => `“${t}”`).join(", ")}.`;
      }
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

/**
 * New work I asked for on a job with a plan, planned into its Web (after
 * the piano job, 2026-10-04): a planning call adds it with its
 * dependencies on the tasks there, never the same work again. Once per
 * message (its tasks carry the message's key), and what is planned
 * already isn't added twice. Null when there's nothing to plan.
 */
async function addWork(
  d: TalkDeps,
  jobId: string,
  messageId: string,
  text: string,
  v: EyeTriage,
): Promise<{ added: string[]; known: string[] } | null> {
  const job = d.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!job) return null;
  const prefix = `msg-${messageId.slice(-10).toLowerCase()}-`;
  const rows = taskRows(d.db, jobId);
  const mine = rows.filter((t) => t.planKey?.startsWith(prefix));
  if (mine.length) return { added: mine.map((t) => t.id), known: [] };
  const live = rows.filter((t) => t.state !== "skipped");
  const ids = new Set(live.map((t) => t.id));
  const suggested = v.tasks
    .map(
      (t) =>
        `- ${t.title}: ${t.instructions}${t.dependsOn.length ? ` (after ${t.dependsOn.join(", ")})` : ""}`,
    )
    .join("\n");
  let plan: WebPlan;
  if (d.brain.extend) {
    const project = d.db.select().from(projects).where(eq(projects.id, job.projectId)).get();
    plan = await d.brain.extend({
      jobId,
      cwd: job.worktree ?? project?.workspacePath ?? process.cwd(),
      goal: job.goal,
      skill: "",
      silk: d.silk
        .current(jobId)
        .filter((e) => e.kind === "decision" || e.kind === "architecture")
        .slice(-30)
        .map((e) => `## ${e.title}\n${e.body.slice(0, 600)}`)
        .join("\n\n"),
      digest: "",
      verify: job.verify,
      request: text,
      tasks: live.map((t) => ({
        id: t.id,
        title: t.title,
        kind: t.kind,
        state: t.state,
        dependsOn: t.dependsOn,
      })),
      suggested,
    });
  } else {
    if (!v.tasks.length) return null;
    plan = {
      summary: v.reply,
      tasks: v.tasks.map((t, i) => ({
        ...t,
        key: `n${i + 1}`,
        title: t.title.slice(0, 120),
        dependsOn: t.dependsOn.filter((x) => ids.has(x)),
      })),
      jobVerify: [],
    };
  }
  // New work builds on what is there: with no dependency on The Web at all, its first tasks
  // come after the work that nothing else needs yet.
  if (!plan.tasks.some((t) => t.dependsOn.some((x) => ids.has(x)))) {
    const sinks = live
      .filter((t) => !live.some((o) => o.dependsOn.includes(t.id)))
      .map((t) => t.id);
    const keys = new Set(plan.tasks.map((t) => t.key));
    plan = {
      ...plan,
      tasks: plan.tasks.map((t) =>
        t.dependsOn.some((x) => keys.has(x)) ? t : { ...t, dependsOn: [...t.dependsOn, ...sinks] },
      ),
    };
  }
  return storeWeb({ db: d.db, bus: d.bus, silk: d.silk, now: d.now ?? Date.now }, jobId, plan, {
    keyPrefix: prefix,
    againstDone: true,
    title: `Plan, version ${job.webVersion + 1}: ${firstLine(text)}`,
  });
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
