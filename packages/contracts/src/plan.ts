import { z } from "zod";
import { Capability, Difficulty, TaskKind } from "./entities.ts";

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
});
export type PlannedTask = z.infer<typeof PlannedTask>;

export const WebPlan = z.object({
  /** One paragraph: the approach, for me and for Silk. */
  summary: z.string().min(1),
  tasks: z.array(PlannedTask).min(1).max(60),
  /** Job-level verification: run when every task is done. */
  jobVerify: z.array(z.string().min(1)),
});
export type WebPlan = z.infer<typeof WebPlan>;

/** One interview round (Skills → The interview): a playback of what is understood, then a few questions. */
export const InterviewRound = z.object({
  /** True when every point the method asks about is answered or recorded as "decide later". */
  done: z.boolean(),
  /** What is understood so far, played back for me to confirm. */
  playback: z.string(),
  questions: z
    .array(
      z.object({
        question: z.string().min(1),
        /** Suggested answers; the first may be marked recommended. */
        options: z.array(z.string()).max(5),
        recommended: z.string().nullable(),
      }),
    )
    .max(6),
  /** Points still open when done: recorded as open questions. */
  open: z.array(z.string()),
});
export type InterviewRound = z.infer<typeof InterviewRound>;
