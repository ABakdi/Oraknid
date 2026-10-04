import { z } from "zod";
import { Capability, Difficulty, TaskKind } from "./entities.ts";
import { LooseQuestions } from "./questions.ts";

// What The Eye's brain returns when it plans a job (The-Eye → Planning).

export const PlannedTask = z.object({
  /** A short key, unique in the plan, e.g. "t3". Dependencies refer to it. */
  key: z.string().regex(/^[a-z0-9-]{1,32}$/),
  title: z.string().min(1).max(120),
  instructions: z.string().min(1),
  kind: TaskKind,
  dependsOn: z.array(z.string()),
  /** Globs of paths the task may change, relative to the workspace. */
  scope: z.array(z.string().min(1)),
  /** Commands Oraknid runs to accept the task (BR-1). */
  verify: z.array(z.string().min(1)),
  requiredCapabilities: z.array(Capability).min(1),
  difficulty: Difficulty,
  /**
   * The phase it belongs to, when the work comes in phases (1, 2, 3…):
   * every task of a later phase comes after the earlier phases' work.
   */
  phase: z.number().int().min(1).max(20).optional(),
});
export type PlannedTask = z.infer<typeof PlannedTask>;

/**
 * Oraknid's own steps at the end of a job (Jobs-and-Projects → Ending a
 * job; after the piano job, 2026-10-03): merging the job into the work
 * branch and pushing to the project's linked GitHub repo are never tasks.
 */
export const JobEnding = z.object({
  /** Merge the job into the work branch: only when the owner asked for it in so many words ("commit into dev", "merge it"). */
  merge: z.boolean().default(false),
  /** Push to the project's linked GitHub repo: the work branch when merged, else the job's branch. */
  push: z.boolean().default(false),
});
export type JobEnding = z.infer<typeof JobEnding>;

export const WebPlan = z.object({
  /** One paragraph: the approach, for me and for Silk. */
  summary: z.string().min(1),
  tasks: z.array(PlannedTask).min(1).max(60),
  /** Job-level verification: run when every task is done. */
  jobVerify: z.array(z.string().min(1)),
  /** What Oraknid itself does when the job ends, as the owner asked (never tasks). */
  ending: JobEnding.optional(),
});

export type WebPlan = z.infer<typeof WebPlan>;

/** One interview round (Skills → The interview): a playback of what is understood, then a few questions. */
export const InterviewRound = z.object({
  /** True when every point the method asks about is answered or recorded as "decide later". */
  done: z.boolean(),
  /** What is understood so far, played back for me to confirm. */
  playback: z.string(),
  /**
   * Asked with options, one at a time (ADR-037). A round written in the
   * older shape (a question, options as words) is upgraded on reading.
   */
  questions: LooseQuestions,
  /** Points still open when done: recorded as open questions. */
  open: z.array(z.string()),
  /**
   * What The Eye decided itself rather than ask (a sensible default, a
   * question I left unanswered): said in the playback, kept in Silk as its
   * decisions, which I can correct.
   */
  assumptions: z.array(z.string()).optional(),
});
export type InterviewRound = z.infer<typeof InterviewRound>;

// Comparing The Eye's decision models (ADR-022).

/** The Eye's models: its Leg, one per kind of decision, and a shadow planner. Ids of Leg models. */
export const EyeModels = z.object({
  leg: z.string().nullable(),
  planning: z.string().nullable(),
  judging: z.string().nullable(),
  quick: z.string().nullable(),
  shadow: z.string().nullable(),
});
export type EyeModels = z.infer<typeof EyeModels>;

export const PlanMeasures = z.object({
  tasks: z.number().int(),
  /** Share of tasks with at least one check. */
  withChecks: z.number(),
  checksPerTask: z.number(),
  /** The longest chain of dependencies, in tasks. */
  depth: z.number().int(),
  kinds: z.record(z.string(), z.number().int()),
});
export type PlanMeasures = z.infer<typeof PlanMeasures>;

export const PlanComparison = z.object({
  pairId: z.string(),
  call: z.enum(["plan", "replan"]),
  at: z.number(),
  plans: z.array(
    z.object({
      role: z.enum(["primary", "shadow"]),
      model: z.string(),
      error: z.string().nullable(),
      ms: z.number(),
      firstTry: z.boolean(),
      measures: PlanMeasures.nullable(),
      titles: z.array(z.string()),
    }),
  ),
});
export type PlanComparison = z.infer<typeof PlanComparison>;

/** How the plans that ran fared on the job. */
export const PlanOutcome = z.object({
  tasksDone: z.number().int(),
  tasksTotal: z.number().int(),
  attempts: z.number().int(),
  checksRepaired: z.number().int(),
  replans: z.number().int(),
});
export type PlanOutcome = z.infer<typeof PlanOutcome>;
