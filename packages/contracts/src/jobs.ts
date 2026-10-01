import { z } from "zod";
import { Id } from "./common.ts";
import { Autonomy, Budget, Job, JobInput, Project, Task } from "./entities.ts";

// Creating and following projects and jobs (docs/01-Specification/Jobs-and-Projects.md).

export const NewProject = z.object({
  name: z.string().min(1),
  workspacePath: z.string().min(1),
  /**
   * For a folder that isn't a git repo: true runs `git init`; false keeps
   * checkpoints in a shadow repo and leaves the folder alone.
   */
  initGit: z.boolean().optional(),
});
export type NewProject = z.infer<typeof NewProject>;

export const DEFAULT_BUDGET: Budget = {
  tokens: null,
  quotaShare: null,
  // A come-and-look alarm, not a stop (BR-9).
  wallClockMs: { limit: 8 * 3600_000, hard: false },
  // No money unless I say so (BR-10).
  money: { limit: 0, hard: true },
};

export const NewJob = z.object({
  projectId: Id,
  title: z.string().min(1).optional(),
  goal: z.string().min(1),
  inputs: z.array(JobInput).default([]),
  /** Default: the built-in canon-driven skill. */
  skillId: z.string().optional(),
  autonomy: Autonomy.default("standard"),
  allowedLegIds: z.array(Id).default([]),
  budget: Budget.optional(),
  /** Job-level verification, besides the skill's and the plan's. */
  verify: z.array(z.string().min(1)).default([]),
  /** Run without the sandbox: explicit, audited, shown in red (ADR-006). */
  unsandboxed: z.boolean().default(false),
});
export type NewJob = z.infer<typeof NewJob>;

export const JobView = Job.extend({
  tasks: z.array(Task),
  worktree: z.string().nullable(),
  branch: z.string().nullable(),
});
export type JobView = z.infer<typeof JobView>;

export const ProjectView = Project.extend({ jobCount: z.number().int().nonnegative() });
export type ProjectView = z.infer<typeof ProjectView>;
