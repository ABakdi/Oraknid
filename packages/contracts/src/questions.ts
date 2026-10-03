import { z } from "zod";

// Questions asked with options, one at a time (ADR-037): the interview's
// rounds and The Eye's questions in its conversation share this shape, and
// the same component answers them.

/** single: one option · multi: any number · text: a free answer · confirm: yes or no. */
export const QuestionShape = z.enum(["single", "multi", "text", "confirm"]);
export type QuestionShape = z.infer<typeof QuestionShape>;

export const QuestionOption = z.object({
  /** Short and stable within its question, e.g. "public". */
  id: z.string().min(1).max(80),
  label: z.string().min(1).max(200),
  /** One line under the label: what choosing it means. */
  detail: z.string().max(600).optional(),
});
export type QuestionOption = z.infer<typeof QuestionOption>;

export const Question = z.object({
  /** Unique within its round, e.g. "q1" or "repo". */
  id: z.string().min(1).max(80),
  shape: QuestionShape,
  prompt: z.string().min(1).max(2000),
  /** For single and multi; a confirm question gets Yes and No when it has none. */
  options: z.array(QuestionOption).max(9).default([]),
  /** The option The Eye recommends: marked, and selected first. */
  recommended: z.string().nullable().default(null),
  /** A choice question also takes a typed answer ("Other"). */
  allowOther: z.boolean().default(true),
});
export type Question = z.infer<typeof Question>;
export type QuestionInput = z.input<typeof Question>;

/**
 * A question as a model writes it: the shape above, or the older one (a
 * question, its options as words, the recommended one's words), upgraded;
 * a missing id is given one by its place. Anything else stays invalid.
 */
export function upgradeQuestion(raw: unknown, i: number): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" && r.id ? r.id : `q${i + 1}`;
  if (typeof r.prompt === "string" || typeof r.question !== "string") return { ...r, id };
  const words = Array.isArray(r.options)
    ? r.options.filter((o): o is string => typeof o === "string")
    : [];
  const options = words.map((label, j) => ({ id: `o${j + 1}`, label }));
  return {
    id,
    shape: options.length ? "single" : "text",
    prompt: r.question,
    options,
    recommended: options.find((o) => o.label === r.recommended)?.id ?? null,
    allowOther: true,
  };
}

/** A list of questions as a model writes them (see `upgradeQuestion`). */
export const LooseQuestions = z.preprocess(
  (raw) => (Array.isArray(raw) ? raw.map(upgradeQuestion) : raw),
  z.array(Question).max(8),
);

/** My answer to one question: the options I chose, and what I typed. Neither: unanswered. */
export const QuestionAnswer = z.object({
  questionId: z.string().min(1).max(80),
  options: z.array(z.string().max(80)).max(9).default([]),
  text: z.string().max(8000).default(""),
});
export type QuestionAnswer = z.infer<typeof QuestionAnswer>;

export const QuestionAnswers = z.array(QuestionAnswer).max(20);
export type QuestionAnswers = z.infer<typeof QuestionAnswers>;

const YES_NO: QuestionOption[] = [
  { id: "yes", label: "Yes" },
  { id: "no", label: "No" },
];

/**
 * Questions as the component shows them: unique ids, a confirm question's
 * Yes and No, no options on a text question, a recommendation that names
 * one of the options or none.
 */
export function normalizeQuestions(list: QuestionInput[]): Question[] {
  const seen = new Set<string>();
  return list.map((raw, i) => {
    const q = Question.parse(raw);
    let id = q.id;
    for (let n = i + 1; seen.has(id); n++) id = `${q.id}-${n}`;
    seen.add(id);
    const options =
      q.shape === "text"
        ? []
        : q.shape === "confirm" && q.options.length === 0
          ? YES_NO
          : uniqueOptions(q.options);
    const recommended =
      q.recommended && options.some((o) => o.id === q.recommended) ? q.recommended : null;
    // A choice with nothing to choose from is a text question.
    const shape =
      (q.shape === "single" || q.shape === "multi") && !options.length ? "text" : q.shape;
    return { ...q, id, shape, options, recommended };
  });
}

function uniqueOptions(options: QuestionOption[]): QuestionOption[] {
  const seen = new Set<string>();
  return options.filter((o) => {
    if (seen.has(o.id)) return false;
    seen.add(o.id);
    return true;
  });
}

/** Whether my answer says anything. */
export const isAnswered = (a: QuestionAnswer | undefined) =>
  !!a && (a.options.length > 0 || a.text.trim().length > 0);

/**
 * What "Submit" sends (ADR-037): one answer per question, in order; a
 * question left unanswered takes its recommended option if it has one, and
 * is otherwise sent as unanswered. Options not offered are dropped.
 */
export function completeAnswers(questions: Question[], given: QuestionAnswer[]): QuestionAnswer[] {
  const byId = new Map(given.map((a) => [a.questionId, a]));
  return questions.map((q) => {
    const a = byId.get(q.id);
    const ids = new Set(q.options.map((o) => o.id));
    const options = (a?.options ?? []).filter((o) => ids.has(o));
    const kept: QuestionAnswer = {
      questionId: q.id,
      options: q.shape === "multi" ? [...new Set(options)] : options.slice(0, 1),
      text: q.shape === "text" || q.allowOther ? (a?.text ?? "").trim() : "",
    };
    if (isAnswered(kept)) return kept;
    return q.recommended ? { ...kept, options: [q.recommended] } : kept;
  });
}

/** One answer in words: the options' labels, then what I typed. */
export function answerWords(q: Question, a: QuestionAnswer | undefined): string {
  if (!isAnswered(a)) return "(unanswered)";
  const labels = (a?.options ?? []).map((id) => q.options.find((o) => o.id === id)?.label ?? id);
  const text = a?.text.trim() ?? "";
  return [...labels, ...(text ? [labels.length ? `Other: ${text}` : text] : [])].join(", ");
}

/** My answers as the short list shown in the conversation, and kept in Silk. */
export function renderAnswers(questions: Question[], answers: QuestionAnswer[]): string {
  const byId = new Map(answers.map((a) => [a.questionId, a]));
  return questions
    .map((q) => `- ${q.prompt.split("\n")[0]} — ${answerWords(q, byId.get(q.id))}`)
    .join("\n");
}

/** Questions as text, for a reader with no component (a notification, Silk, an old client). */
export function renderQuestions(questions: Question[]): string {
  return questions
    .map((q, i) => {
      const opts = q.options.length
        ? `\n   ${q.options
            .map((o) => `${o.label}${o.id === q.recommended ? " (recommended)" : ""}`)
            .join(" · ")}`
        : "";
      return `${i + 1}. ${q.prompt}${opts}`;
    })
    .join("\n");
}
