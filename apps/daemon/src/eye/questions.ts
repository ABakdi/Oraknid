import type { Question, QuestionAnswer } from "@oraknid/contracts";
import { eq } from "drizzle-orm";
import type { Db } from "../db/open.ts";
import { taskEdges, tasks } from "../db/schema.ts";

// The questions The Eye asks, each answer saying what it does (ADR-045).

/** The tasks that need this one, directly or through others, not finished yet. */
export function dependentsOf(db: Db, jobId: string, taskId: string) {
  const all = db.select().from(tasks).where(eq(tasks.jobId, jobId)).all();
  const edges = db
    .select({ taskId: taskEdges.taskId, dependsOn: taskEdges.dependsOn })
    .from(taskEdges)
    .innerJoin(tasks, eq(tasks.id, taskEdges.taskId))
    .where(eq(tasks.jobId, jobId))
    .all();
  const out = new Set<string>();
  const walk = (id: string) => {
    for (const e of edges.filter((x) => x.dependsOn === id)) {
      if (out.has(e.taskId)) continue;
      out.add(e.taskId);
      walk(e.taskId);
    }
  };
  walk(taskId);
  return all.filter((t) => out.has(t.id) && t.state !== "done" && t.state !== "skipped");
}

/** The "keeps going wrong" question's answers (ADR-045), and the words of before. */
export const WRONG = {
  advice: "advice",
  anotherLeg: "another-leg",
  mine: "mine",
  leaveOut: "leave-out",
  stop: "stop",
} as const;

/**
 * "<task> keeps going wrong": what each answer does, in plain words. My
 * advice is a text answer; another Leg can be picked, or left to Oraknid.
 */
export function keepsGoingWrong(o: {
  task: string;
  leg: string;
  evidence: string;
  escalations: string[];
  others: { id: string; name: string }[];
  dropped: string[];
  folder: string;
  branch: string | null;
}): { title: string; detail: string; questions: Question[] } {
  const listed = o.dropped.length
    ? ` The tasks that need it are left out too: ${o.dropped.map((t) => `“${t}”`).join(", ")}.`
    : " No other task needs it.";
  const what: Question = {
    id: "what",
    shape: "single",
    prompt: `“${o.task}” keeps going wrong. What should I do?`,
    options: [
      {
        id: WRONG.advice,
        label: "Try again with my advice",
        detail:
          "Write your advice on the next tab: the Leg gets it and tries again from where it is, its escalation reset. With no advice, it just tries again.",
      },
      ...(o.others.length
        ? [
            {
              id: WRONG.anotherLeg,
              label: "Give it to another Leg",
              detail: `${o.leg.split(" · ")[0]} stops working on it; another Leg picks it up from the handoff (pick one on the next tab, or let Oraknid choose).`,
            },
          ]
        : []),
      {
        id: WRONG.mine,
        label: "I'll do it myself",
        detail: `The task is yours: its folder (${o.folder}) is left to you, and the job waits until you mark it done or hand it back.`,
      },
      {
        id: WRONG.leaveOut,
        label: "Leave it out",
        detail: `The task is dropped and the job goes on without it.${listed}`,
      },
      {
        id: WRONG.stop,
        label: "Stop the job",
        detail: `The job is cancelled; the work done so far stays on ${o.branch ? `its branch ${o.branch}` : "its folder"}.`,
      },
    ],
    recommended: WRONG.advice,
    allowOther: false,
  };
  const advice: Question = {
    id: "advice",
    shape: "text",
    prompt: "Your advice for the next try (for “Try again with my advice”; optional)",
    options: [],
    recommended: null,
    allowOther: true,
  };
  const pick: Question | null = o.others.length
    ? {
        id: "leg",
        shape: "single",
        prompt: "Which Leg? (for “Give it to another Leg”; leave it and Oraknid chooses)",
        options: o.others.slice(0, 9).map((l) => ({ id: l.id, label: l.name })),
        recommended: null,
        allowOther: false,
      }
    : null;
  return {
    title: `"${o.task}" keeps going wrong`,
    detail: `${o.leg}: ${o.evidence}.\nEscalations so far: ${o.escalations.join(", ") || "none"}.`,
    questions: [what, advice, ...(pick ? [pick] : [])],
  };
}

export type WrongChoice =
  | { kind: "advice"; advice: string }
  | { kind: "another-leg"; legId: string | null; advice: string }
  | { kind: "mine" }
  | { kind: "leave-out"; dependents: boolean }
  | { kind: "stop" };

/**
 * My answer to "keeps going wrong", structured or in words. The words of
 * before still work (an item asked before ADR-045): "Retry", "Take it
 * over", "Skip it" (that task alone), "Cancel the job", or advice typed.
 */
export function readKeepsGoingWrong(text: string, answers: QuestionAnswer[] | null): WrongChoice {
  if (answers?.length) {
    const by = new Map(answers.map((a) => [a.questionId, a]));
    const chosen = by.get("what")?.options[0] ?? WRONG.advice;
    const advice = by.get("advice")?.text.trim() ?? "";
    if (chosen === WRONG.mine) return { kind: "mine" };
    if (chosen === WRONG.leaveOut) return { kind: "leave-out", dependents: true };
    if (chosen === WRONG.stop) return { kind: "stop" };
    if (chosen === WRONG.anotherLeg)
      return { kind: "another-leg", legId: by.get("leg")?.options[0] ?? null, advice };
    return { kind: "advice", advice };
  }
  const t = text.trim();
  if (t === "Take it over") return { kind: "mine" };
  if (t === "Skip it") return { kind: "leave-out", dependents: false };
  if (t === "Cancel the job") return { kind: "stop" };
  return { kind: "advice", advice: t === "Retry" ? "" : t };
}
