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
