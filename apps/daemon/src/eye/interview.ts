import { answerWords, type Question, type QuestionAnswer } from "@oraknid/contracts";
import { endsInterview } from "@oraknid/core";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/open.ts";
import { eyeMessages, inboxItems } from "../db/schema.ts";
import { DEFAULT_INTERVIEW_ROUNDS, INTERVIEW_ROUNDS, readSetting } from "../settings.ts";
import type { SilkStore } from "../silk/store.ts";
import type { AskedQuestion } from "./brain.ts";

// The interview (Skills → The interview), as a smart human interviewer
// runs it: a few rounds, only what blocks planning, never the same
// question twice, and over the moment I say so (after the piano job,
// 2026-10-04: twelve rounds, the same questions again and again).

export const ENOUGH = "Enough, start";
export const INTERVIEW_DONE = "What I want (interview)";
/** I ended the interview in the conversation while no round was open: the next one isn't asked. */
export const INTERVIEW_ENDED = "I ended the interview";
export const ROUND_TITLE = /^Interview, round (\d+)$/;

/** How many rounds an interview may take: 3 unless I set it (Settings → The Eye). */
export function interviewRounds(db: Db): number {
  return readSetting(
    db,
    INTERVIEW_ROUNDS,
    z.number().int().min(1).max(12),
    DEFAULT_INTERVIEW_ROUNDS,
  );
}

/** My answer to an interview round says to end it: "Enough, start", or the same in my words. */
export const endsRound = (answer: string) => answer === ENOUGH || endsInterview(answer);

const UNANSWERED = "(unanswered)";

/**
 * Every question the interview asked so far, with my answer: the rounds of
 * the draft's conversation, then the inbox's (those numbered `before` or
 * later left out: the round being asked now). A round I ended or left
 * has its questions unanswered; a round answered in my own words gives
 * those words for each of its questions.
 */
export function interviewSoFar(db: Db, jobId: string, before = Number.POSITIVE_INFINITY) {
  const asked: AskedQuestion[] = [];
  // The draft's rounds: The Eye's questions before the start, and my reply to each.
  const talk = db
    .select()
    .from(eyeMessages)
    .where(eq(eyeMessages.jobId, jobId))
    .orderBy(asc(eyeMessages.createdAt), asc(eyeMessages.id))
    .all();
  let draftRounds = 0;
  for (const [i, m] of talk.entries()) {
    if (m.author !== "eye" || m.itemId || m.action || !m.questions?.length) continue;
    draftRounds++;
    const reply =
      talk.find((x) => x.replyTo === m.id && x.author === "owner") ??
      talk.slice(i + 1).find((x) => x.author === "owner");
    pushRound(asked, draftRounds, m.questions as Question[], reply?.answers ?? null, reply?.text);
  }
  // The inbox's rounds, in order.
  const items = db
    .select()
    .from(inboxItems)
    .where(and(eq(inboxItems.jobId, jobId), eq(inboxItems.kind, "question")))
    .all()
    .map((item) => ({ item, n: Number(ROUND_TITLE.exec(item.title)?.[1] ?? 0) }))
    .filter((x) => x.n > 0 && x.n < before && x.item.questions?.length)
    .sort((a, b) => a.n - b.n);
  for (const { item, n } of items)
    pushRound(
      asked,
      draftRounds + n,
      item.questions as Question[],
      item.answers ?? null,
      item.state === "answered" ? (item.answer ?? "") : undefined,
    );
  return { asked, draftRounds };
}

function pushRound(
  asked: AskedQuestion[],
  round: number,
  questions: Question[],
  answers: QuestionAnswer[] | null,
  text: string | undefined,
) {
  const words = text?.trim() ?? "";
  for (const q of questions) {
    const a = answers?.find((x) => x.questionId === q.id);
    const answer = answers?.length
      ? answerWords(q, a)
      : !words || endsRound(words)
        ? UNANSWERED
        : `(the round's answer, in my words) ${words}`;
    asked.push({ round, id: q.id, prompt: q.prompt, answer });
  }
}

/** What is decided already, for the next round: my answers, my instructions, what The Eye assumed. */
export function decidedSoFar(silk: SilkStore, jobId: string, asked: AskedQuestion[]): string[] {
  const answered = asked
    .filter((q) => q.answer !== UNANSWERED)
    .map((q) => `${q.prompt.split("\n")[0]} → ${q.answer}`);
  const notes = silk
    .current(jobId)
    .filter(
      (e) =>
        e.kind === "decision" &&
        e.title !== INTERVIEW_DONE &&
        (e.authoredBy === "owner" || e.title.startsWith("Assumed: ")),
    )
    .map((e) => (e.title.startsWith("Assumed: ") ? e.title : `${e.title}: ${e.body}`));
  return [...answered, ...notes];
}

/**
 * The interview's end, kept in Silk: what The Eye understood (with what it
 * assumed), each assumption as its decision I can correct, what stays
 * open, and the questions of a round I ended: assumed with their
 * recommended answer, else left open.
 */
export function closeInterview(
  silk: SilkStore,
  jobId: string,
  o: {
    playback: string;
    open?: string[];
    assumptions?: string[];
    unanswered?: Question[];
    fallback: string;
  },
) {
  const assumed = [...(o.assumptions ?? [])];
  const open = [...(o.open ?? [])];
  for (const q of o.unanswered ?? []) {
    const rec = q.options.find((x) => x.id === q.recommended);
    if (rec) assumed.push(`${q.prompt.split("\n")[0]} — ${rec.label}`);
    else open.push(`${q.prompt} (left open when I ended the interview)`);
  }
  const body = [
    o.playback || o.fallback,
    assumed.length
      ? `**What I assumed** (tell me if any is wrong)\n${assumed.map((a) => `- ${a}`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  silk.add({ jobId, kind: "decision", title: INTERVIEW_DONE, body, authoredBy: "eye" });
  for (const a of assumed)
    silk.add({
      jobId,
      kind: "decision",
      title: `Assumed: ${a.slice(0, 100)}`,
      body: `${a}\n\nThe Eye decided this itself rather than ask; tell it if it's wrong.`,
      authoredBy: "eye",
    });
  for (const point of open)
    silk.add({
      jobId,
      kind: "issue",
      title: `Open question: ${point.slice(0, 80)}`,
      body: point,
      authoredBy: "eye",
    });
}

/** I ended the interview in the conversation (no round open, or the draft's). */
export function interviewEnded(silk: SilkStore, jobId: string): boolean {
  return silk
    .current(jobId)
    .some(
      (e) => e.kind === "decision" && (e.title === INTERVIEW_ENDED || e.title === INTERVIEW_DONE),
    );
}
