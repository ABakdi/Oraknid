import { z } from "zod";
import { Id, Timestamp } from "./common.ts";
import {
  Autonomy,
  Budget,
  BudgetLimit,
  EyeMessage,
  Job,
  JobInput,
  JobState,
  Project,
  RepoName,
  SessionView,
  SilkEntry,
  Task,
} from "./entities.ts";
import { Event } from "./events.ts";

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

const FolderName = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,100}$/, "letters, digits, dots, dashes and underscores")
  .refine((n) => n !== "." && n !== "..", "a folder name");

/** Where a new project comes from (Jobs-and-Projects → Starting work, ADR-023). */
export const ProjectSource = z.discriminatedUnion("kind", [
  /** A folder I have, a repo or not. */
  z.object({ kind: z.literal("folder"), path: z.string().min(1), initGit: z.boolean().optional() }),
  /** A new empty folder, made a git repo. */
  z.object({ kind: z.literal("new-folder"), parent: z.string().min(1), name: FolderName }),
  /** A new repo on my GitHub account, then cloned. */
  z.object({
    kind: z.literal("github-new"),
    /** Which of my GitHub accounts (the first when left out). */
    account: z.string().optional(),
    parent: z.string().min(1),
    name: FolderName,
    private: z.boolean().default(true),
    description: z.string().default(""),
  }),
  /** One of my GitHub repos, cloned. */
  z.object({
    kind: z.literal("github-clone"),
    /** Which of my GitHub accounts (the first when left out). */
    account: z.string().optional(),
    parent: z.string().min(1),
    fullName: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  }),
  /** Any git URL (a public one, for now), cloned. */
  z.object({ kind: z.literal("git-url"), parent: z.string().min(1), url: z.string().min(1) }),
]);
export type ProjectSource = z.infer<typeof ProjectSource>;

export const NewProjectFrom = z.object({
  name: z.string().min(1).optional(),
  source: ProjectSource,
});
export type NewProjectFrom = z.infer<typeof NewProjectFrom>;

/** A folder inside a project's, parts joined by "/", never leaving it. */
const RepoFolder = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/, "a folder inside the project")
  .refine((f) => !f.split("/").some((p) => p === "." || p === ".." || p === ".oraknid"), {
    message: "a folder inside the project",
  });

/** A repo added to a project (ADR-042): a folder of it that is one, a new empty one, or a clone. */
export const NewProjectRepo = z.object({
  id: Id,
  /** Its name in the project: the folder's last part when left out. */
  name: RepoName.optional(),
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("folder"), folder: RepoFolder }),
    z.object({ kind: z.literal("new"), folder: RepoFolder }),
    z.object({
      kind: z.literal("github-clone"),
      folder: RepoFolder,
      fullName: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
      account: z.string().optional(),
    }),
    z.object({ kind: z.literal("git-url"), folder: RepoFolder, url: z.string().min(1) }),
  ]),
});
export type NewProjectRepo = z.infer<typeof NewProjectRepo>;

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

/** A draft's options, changed on the New work page before it starts (Phase 8). */
export const DraftPatch = z.object({
  id: Id,
  goal: z.string().min(1).optional(),
  autonomy: Autonomy.optional(),
  allowedLegIds: z.array(Id).optional(),
  budget: Budget.optional(),
  verify: z.array(z.string().min(1)).optional(),
  inputs: z.array(JobInput).optional(),
  /** A skill I pick; null leaves it to the project's skills. */
  skillId: z.string().nullable().optional(),
});
export type DraftPatch = z.infer<typeof DraftPatch>;

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
  /** The paused Leg it waits for (its session was paused in place), if any. */
  waitingForLegId: z.string().nullable().default(null),
  /** Legs it doesn't use any more: their work in the job, or on it, was cancelled. */
  avoidLegIds: z.array(z.string()).default([]),
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
  /** Waiting for a free slot under the running-jobs limit, and its priority (ADR-016). */
  queuedAt: z.number().nullable().default(null),
  priority: z.number().int().default(0),
  allowRules: z.array(z.string()).default([]),
  denyRules: z.array(z.string()).default([]),
  /** The tools its sessions get (ADR-021), and those not set up in Settings → Tools yet. */
  tools: z.array(z.string()).default([]),
  missingTools: z.array(z.string()).default([]),
  /** The skills The Eye still chooses from (none once chosen, or when I picked one). */
  skillChoices: z.array(z.string()).default([]),
  /** Tokens its sessions used, what a project's Work tab shows as its cost (ADR-034). */
  tokens: z.number().default(0),
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
  /** In a project of several repos (ADR-042): each repo the job touched, its branch and commits. */
  repos: z
    .array(
      z.object({
        name: z.string(),
        folder: z.string(),
        branch: z.string(),
        into: z.string(),
        commits: z.array(z.object({ sha: z.string(), subject: z.string(), at: z.number() })),
        merged: z.boolean(),
      }),
    )
    .default([]),
});
export type JobResult = z.infer<typeof JobResult>;

/**
 * A project's budget (ADR-034): limits on tokens and money across all its
 * jobs, and the default a new job in it starts with. Null: no limit.
 */
export const ProjectBudget = z.object({
  tokens: BudgetLimit.nullable(),
  /** In US dollars. */
  money: BudgetLimit.nullable(),
});
export type ProjectBudget = z.infer<typeof ProjectBudget>;

export const NO_PROJECT_BUDGET: ProjectBudget = { tokens: null, money: null };

/** A project's budget and what its jobs used against it. */
export const ProjectBudgetView = z.object({
  budget: ProjectBudget,
  used: z.object({ tokens: z.number(), money: z.number() }),
  /** Waiting for my answer: a job of it paused at the limit. */
  asking: z.boolean(),
});
export type ProjectBudgetView = z.infer<typeof ProjectBudgetView>;

/** A project's Silk, kept by job (ADR-034): one group per job, newest job first. */
export const SilkByJob = z.object({
  jobId: Id,
  title: z.string(),
  state: JobState,
  createdAt: z.number(),
  entries: z.array(SilkEntry),
});
export type SilkByJob = z.infer<typeof SilkByJob>;

/** One attempt of a task, as an export carries it. */
export const AttemptRecord = z.object({
  id: Id,
  taskId: Id,
  legId: Id,
  legModelId: Id,
  effort: z.string().nullable(),
  startedAt: Timestamp,
  endedAt: Timestamp.nullable(),
  outcome: z.string().nullable(),
  escalations: z.array(z.string()),
});
export type AttemptRecord = z.infer<typeof AttemptRecord>;

/**
 * A job's full record, for a download (`jobs.export`): the job and its plan
 * (tasks and their edges), every attempt, session, event and Silk entry,
 * the conversation with The Eye and the result. Secrets excluded: known
 * secret values and secret-shaped strings are scrubbed, string by string.
 */
export const JobExport = z.object({
  format: z.literal("oraknid.job-export"),
  version: z.literal(1),
  exportedAt: Timestamp,
  job: JobView,
  attempts: z.array(AttemptRecord),
  sessions: z.array(SessionView),
  events: z.array(Event),
  silk: z.array(SilkEntry),
  conversation: z.array(EyeMessage),
  /** Null until the job has a result (a draft, say). */
  result: JobResult.nullable(),
});
export type JobExport = z.infer<typeof JobExport>;
