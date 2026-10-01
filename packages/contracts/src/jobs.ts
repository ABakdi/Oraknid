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

export const TaskView = Task.extend({
  /** Why the router chose its Leg model: score, reasons, what it left out. */
  routing: z
    .object({
      leg: z.string(),
      model: z.string(),
      effort: z.string().nullable(),
      score: z.number(),
      reasons: z.array(z.string()),
      excluded: z.array(z.object({ legModelId: z.string(), why: z.string() })),
    })
    .nullable(),
  pinnedModelId: z.string().nullable(),
  ownerHeld: z.boolean(),
});
export type TaskView = z.infer<typeof TaskView>;

export const JobView = Job.extend({
  tasks: z.array(TaskView),
  /** I chose to run it without the sandbox (ADR-006): shown in red. */
  unsandboxed: z.boolean(),
  worktree: z.string().nullable(),
  branch: z.string().nullable(),
  /** Gated actions I waived for this job, and the job's own rules (the job's Settings tab). */
  waived: z.array(z.string()).default([]),
  allowRules: z.array(z.string()).default([]),
  denyRules: z.array(z.string()).default([]),
});
export type JobView = z.infer<typeof JobView>;

export const ProjectView = Project.extend({
  jobCount: z.number().int().nonnegative(),
  /** Not a git repo: checkpoints live in a shadow repo and the folder is left alone. */
  shadow: z.boolean(),
});
export type ProjectView = z.infer<typeof ProjectView>;

/** Where a job's work is and what it holds (Jobs-and-Projects → Ending a job, Checkpoint 1 → F1-5). */
export const JobResult = z.object({
  /** The folder the work is in. */
  folder: z.string().nullable(),
  /** The job branch, when the project is a git repo. */
  branch: z.string().nullable(),
  /** The branch it merges into: the project's work branch. */
  into: z.string(),
  commits: z.array(z.object({ sha: z.string(), subject: z.string(), at: z.number() })),
  merged: z.boolean(),
  /** Why it can't be merged, when it can't (not a repo, no branch, already merged). */
  cannotMerge: z.string().nullable(),
});
export type JobResult = z.infer<typeof JobResult>;
