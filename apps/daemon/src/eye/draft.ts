import {
  completeAnswers,
  normalizeQuestions,
  type Question,
  type QuestionAnswer,
  renderAnswers,
  renderQuestions,
} from "@oraknid/contracts";
import { skillExcerpt } from "@oraknid/core";
import { asc, eq } from "drizzle-orm";
import type { Db } from "../db/open.ts";
import { eyeMessages, jobs, projects } from "../db/schema.ts";
import type { EventBus } from "../events/bus.ts";
import { newId } from "../ids.ts";
import type { SilkStore } from "../silk/store.ts";
import type { SkillStore } from "../skills/store.ts";
import type { EyeBrain } from "./brain.ts";
import { INTERVIEW_DONE, pickJobSkill } from "./program.ts";

// The conversation before Start (Jobs-and-Projects → Starting work):
// with an interviewing skill, The Eye asks its rounds here and my answers
// go to Silk as the inbox's would, so the started job doesn't ask again;
// otherwise what I add is kept as context.

export interface DraftDeps {
  db: Db;
  bus: EventBus;
  silk: SilkStore;
  skills: SkillStore;
  brain: EyeBrain;
  now?: () => number;
}

const START_HINT = "Answer the questions below, or press **Start** whenever you're ready.";

/** Drafts The Eye is answering now: a message waits for its reply. */
const thinking = new Set<string>();

export function isThinking(jobId: string) {
  return thinking.has(jobId);
}

function say(
  d: DraftDeps,
  jobId: string,
  author: "owner" | "eye",
  text: string,
  extras: {
    questions?: Question[] | null;
    answers?: QuestionAnswer[] | null;
    replyTo?: string | null;
  } = {},
) {
  const at = (d.now ?? Date.now)();
  const id = newId(at);
  d.bus.atomically(() => {
    const projectId =
      d.db.select({ p: jobs.projectId }).from(jobs).where(eq(jobs.id, jobId)).get()?.p ?? "";
    d.db
      .insert(eyeMessages)
      .values({
        id,
        jobId,
        projectId,
        author,
        text,
        action: null,
        questions: extras.questions?.length ? extras.questions : null,
        answers: extras.answers ?? null,
        replyTo: extras.replyTo ?? null,
        createdAt: at,
      })
      .run();
    d.bus.publish({
      type: author === "owner" ? "eye.message" : "eye.replied",
      topic: `job:${jobId}`,
      jobId,
      payload: { id, text: text.slice(0, 200), draft: true },
      actor: author === "owner" ? "owner" : "eye",
    });
  });
}

function draft(d: DraftDeps, jobId: string) {
  const job = d.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!job) throw new Error(`No job ${jobId}.`);
  if (job.state !== "draft") throw new Error("That job has started: talk to it from its page.");
  return job;
}

/** The Eye opens the conversation: the first interview round, or a word on what happens next. */
export function draftStart(d: DraftDeps, jobId: string) {
  draft(d, jobId);
  if (thinking.has(jobId)) return;
  thinking.add(jobId);
  void next(d, jobId, null).finally(() => thinking.delete(jobId));
}

/**
 * My answers to The Eye's questions in the draft's conversation (ADR-037):
 * kept structured, said as a short list, and taken as my answer to the round.
 */
export function draftAnswer(
  d: DraftDeps,
  jobId: string,
  messageId: string,
  given: QuestionAnswer[],
) {
  draft(d, jobId);
  if (thinking.has(jobId)) throw new Error("The Eye is still answering; a moment.");
  const m = d.db.select().from(eyeMessages).where(eq(eyeMessages.id, messageId)).get();
  if (!m || m.jobId !== jobId || !m.questions?.length) throw new Error("No such question.");
  const later = d.db
    .select()
    .from(eyeMessages)
    .where(eq(eyeMessages.jobId, jobId))
    .all()
    .some((x) => x.replyTo === messageId);
  if (later) throw new Error("Those questions are answered already.");
  const answers = completeAnswers(m.questions, given);
  const text = renderAnswers(m.questions, answers);
  say(d, jobId, "owner", text, { answers, replyTo: messageId });
  thinking.add(jobId);
  void next(d, jobId, text).finally(() => thinking.delete(jobId));
}

/** My message in the draft's conversation, answered in the background. */
export function draftTalk(d: DraftDeps, jobId: string, text: string) {
  draft(d, jobId);
  if (thinking.has(jobId)) throw new Error("The Eye is still answering; a moment.");
  say(d, jobId, "owner", text);
  thinking.add(jobId);
  void next(d, jobId, text).finally(() => thinking.delete(jobId));
}

async function next(d: DraftDeps, jobId: string, text: string | null) {
  try {
    const job = d.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    if (!job) return;
    const project = d.db.select().from(projects).where(eq(projects.id, job.projectId)).get();
    const cwd = project?.workspacePath ?? process.cwd();
    // Among several skills, The Eye picks now: the interview is the chosen skill's.
    if (job.skillChoices.length > 1) await pickJobSkill(d, jobId, cwd);
    const fresh = d.db.select().from(jobs).where(eq(jobs.id, jobId)).get() ?? job;
    const skill = d.skills.version(fresh.skillId, fresh.skillVersion);
    const silk = d.silk.current(jobId);
    const done = silk.some((e) => e.kind === "decision" && e.title === INTERVIEW_DONE);

    if (!skill?.interview || done) {
      if (text !== null)
        d.silk.add({
          jobId,
          kind: "decision",
          title: "Context I gave before the start",
          body: text,
          authoredBy: "owner",
        });
      say(
        d,
        jobId,
        "eye",
        text === null
          ? `I'll work with the **${skill?.name ?? "default"}** method. Add anything I should know, then press **Start**.`
          : "Noted: it goes into the job's context. Add more, or press **Start**.",
      );
      return;
    }

    // My message answers the round The Eye asked last (its last message), verbatim (Skills → The interview).
    const answers = silk.filter((e) => e.kind === "interview-answer");
    if (text !== null) {
      const asked = d.db
        .select()
        .from(eyeMessages)
        .where(eq(eyeMessages.jobId, jobId))
        .orderBy(asc(eyeMessages.createdAt))
        .all()
        .filter((m) => m.author === "eye")
        .at(-1);
      const questions = asked?.questions?.length ? renderQuestions(asked.questions) : "";
      d.silk.add({
        jobId,
        kind: "interview-answer",
        title: `Interview, round ${answers.length + 1}`,
        body: `${[asked?.text ?? "", questions].filter(Boolean).join("\n\n")}\n\n**My answer:** ${text}`,
        authoredBy: "owner",
      });
    }
    const round = await d.brain.interviewRound({
      jobId,
      cwd,
      goal: fresh.goal,
      skill: skillExcerpt(skill.body, "interview ask questions owner", 5000),
      answers: d.silk
        .current(jobId)
        .filter((e) => e.kind === "interview-answer")
        .map((e) => e.body),
    });
    if (round.done) {
      d.silk.add({
        jobId,
        kind: "decision",
        title: INTERVIEW_DONE,
        body: round.playback || "The interview found nothing more to ask.",
        authoredBy: "eye",
      });
      for (const point of round.open)
        d.silk.add({
          jobId,
          kind: "issue",
          title: `Open question: ${point.slice(0, 80)}`,
          body: point,
          authoredBy: "eye",
        });
      say(
        d,
        jobId,
        "eye",
        `${round.playback ? `**What I understood**\n\n${round.playback}\n\n` : ""}I have what I need. Press **Start** when you're ready.`,
      );
      return;
    }
    say(
      d,
      jobId,
      "eye",
      [round.playback ? `**What I understood**\n\n${round.playback}` : "", START_HINT]
        .filter(Boolean)
        .join("\n\n"),
      { questions: normalizeQuestions(round.questions) },
    );
  } catch (error) {
    say(
      d,
      jobId,
      "eye",
      `I couldn't think about that right now (${error instanceof Error ? error.message : String(error)}). You can still press **Start**: I'll ask in the inbox instead.`,
    );
  }
}
