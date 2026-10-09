import { z } from "zod";

// Evaluation steps in the plan (ADR-064 §1, Phase 16 → M16.2): what I'm
// shown to approve, and the project's settings for them and for the end
// of its jobs (ADR-064 §8).

/** What an evaluation step shows me: the design, the running app, or the work so far. */
export const EvaluationKind = z.enum(["design", "app", "checkpoint"]);
export type EvaluationKind = z.infer<typeof EvaluationKind>;

/** A planned evaluation step: which kind, why it is there, and how to run the app when it does. */
export const PlannedEvaluation = z.object({
  kind: EvaluationKind,
  /** One line: why the step is in the plan here. */
  why: z.string().min(1).max(300),
  /** The command that runs the app for an app review, when the planner knows it. */
  run: z.string().min(1).max(300).optional(),
});
export type PlannedEvaluation = z.infer<typeof PlannedEvaluation>;

/** Which evaluation steps a plan gets: all, some (these kinds), or none. */
export const Evaluations = z.object({
  mode: z.enum(["all", "some", "none"]).default("all"),
  /** With "some": the kinds I want. */
  kinds: z.array(EvaluationKind).default([]),
});
export type Evaluations = z.infer<typeof Evaluations>;
export const ALL_EVALUATIONS: Evaluations = { mode: "all", kinds: [] };

/** Whether a kind of evaluation step is wanted. */
export const wantsEvaluation = (e: Evaluations, kind: EvaluationKind) =>
  e.mode === "all" || (e.mode === "some" && e.kinds.includes(kind));

/**
 * A project's settings for its jobs' evaluation steps and their end
 * (Jobs-and-Projects → Evaluation steps; → Ending a job).
 */
export const ProjectWorkSettings = z.object({
  evaluations: Evaluations.default(ALL_EVALUATIONS),
  /**
   * An evaluation step with no word from me after this many minutes
   * passes by itself (for jobs I don't watch); null: it waits (the default).
   */
  autoPassMinutes: z.number().positive().max(43_200).nullable().default(null),
  /** A completed job is merged into the work branch, or I'm asked first. */
  merge: z.enum(["merge", "ask"]).default("merge"),
});
export type ProjectWorkSettings = z.infer<typeof ProjectWorkSettings>;
export const DEFAULT_PROJECT_WORK: ProjectWorkSettings = {
  evaluations: ALL_EVALUATIONS,
  autoPassMinutes: null,
  merge: "merge",
};

/** What my message asks of a job's evaluation steps: skip them, or add one after a task. */
export const EvaluationEdit = z.object({
  skip: z.boolean().default(false),
  add: z
    .array(
      z.object({
        /** The task it comes after: its id, or its title in my words. */
        after: z.string().min(1),
        kind: EvaluationKind.default("checkpoint"),
        why: z.string().nullable().default(null),
      }),
    )
    .default([]),
});
export type EvaluationEdit = z.infer<typeof EvaluationEdit>;

/** An evaluation step as the job's page shows it. */
export const TaskEvaluation = z.object({
  kind: EvaluationKind,
  why: z.string(),
  /** Its round: 1, then one more each time my notes came back as work. */
  round: z.number().int().positive(),
  /** The review open now, and where I open it. */
  reviewId: z.string().nullable(),
  url: z.string().nullable(),
  /** It waits for me. */
  waiting: z.boolean(),
  /** When it passes by itself, if the project says so. */
  passAt: z.number().nullable(),
  /** How it ended: I approved it, it passed by itself, or it was skipped. */
  outcome: z.enum(["approved", "auto-passed", "skipped"]).nullable(),
});
export type TaskEvaluation = z.infer<typeof TaskEvaluation>;
