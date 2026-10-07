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

/** A folder's name: one part of a path, nothing that climbs out. */
export const FolderName = z
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

/**
 * A repo of a project changed (ADR-042): its name in the project, its
 * release and work branches. What is left out stays.
 */
export const ProjectRepoPatch = z.object({
  id: Id,
  /** The repo, by its name now. */
  name: RepoName,
  rename: RepoName.optional(),
  releaseBranch: z.string().trim().min(1).max(200).optional(),
  workBranch: z.string().trim().min(1).max(200).optional(),
});
export type ProjectRepoPatch = z.infer<typeof ProjectRepoPatch>;

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
  autonomy: Autonomy.default("auto"),
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

/** A job renamed by me: its name, its description, or both (`jobs.rename`). */
export const JobRename = z.object({
  id: Id,
  title: z.string().trim().min(1).max(80).optional(),
  /** Empty clears it; either way it's mine and kept. */
  description: z.string().trim().max(400).optional(),
});
export type JobRename = z.infer<typeof JobRename>;

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
  /** Why it is ready and not running yet (ADR-050): "waiting for memory", "overlaps “X”". */
  waitingReason: z.string().nullable().default(null),
});
export type TaskView = z.infer<typeof TaskView>;

export const JobView = Job.extend({
  /**
   * One or two sentences (Jobs-and-Projects → A job's name and description):
   * what it's for, then what it did once it ended; null until The Eye writes one.
   */
  description: z.string().nullable().default(null),
  /** Who named it: I typed the title ("me"), The Eye ("eye"), or nobody yet (its goal's first line). */
  namedBy: z.enum(["me", "eye"]).nullable().default(null),
  /** What the description says: its purpose, its outcome, or mine. */
  describedAs: z.enum(["purpose", "outcome", "mine"]).nullable().default(null),
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

// ── Archiving and deleting a project, with my choices (Jobs-and-Projects →
// Archiving and deleting a project).

/** "owner/name" on GitHub. */
const FullName = z.string().regex(/^[\w.-]+\/[\w.-]+$/, "owner/name");

/** Deleting: its records always; its folder and its repos on GitHub when I tick them. */
export const ProjectDelete = z.object({
  id: Id,
  /** The project's folder, worktrees included, deleted from this computer. */
  deleteFolder: z.boolean().default(false),
  /** Its linked GitHub repos (owner/name) deleted on GitHub with their accounts' tokens. */
  deleteRepos: z.array(FullName).max(50).default([]),
  /** Its running jobs cancelled first; otherwise a running job refuses it. */
  stopJobs: z.boolean().default(false),
});
export type ProjectDelete = z.input<typeof ProjectDelete>;

/** Archiving (with its choices) or unarchiving (with what to undo on GitHub). */
export const ProjectArchive = z.object({
  id: Id,
  archived: z.boolean(),
  /** Archiving: its linked GitHub repos (owner/name) made read-only on GitHub. */
  archiveRepos: z.array(FullName).max(50).default([]),
  /** Archiving: its folder deleted to free space; only when every repo is pushed and clean. */
  deleteFolder: z.boolean().default(false),
  /** Unarchiving: the GitHub repos it archived made writable again. */
  unarchiveRepos: z.array(FullName).max(50).default([]),
  /** Archiving: its running jobs cancelled first; otherwise a running job refuses it. */
  stopJobs: z.boolean().default(false),
});
export type ProjectArchive = z.input<typeof ProjectArchive>;

/** What would be lost in one repo if its folder went: changes not committed, commits not pushed. */
export const RepoLoss = z.object({
  /** Files changed or not tracked, in the repo or one of its worktrees (the first few). */
  uncommitted: z.array(z.string()),
  /** How many such files in all. */
  uncommittedCount: z.number().int(),
  /** Branches with commits that are on no branch of its GitHub repo. */
  unpushed: z.array(z.object({ branch: z.string(), commits: z.number().int() })),
  stashes: z.number().int(),
  /** Why it couldn't be checked, if it couldn't. */
  error: z.string().nullable(),
});
export type RepoLoss = z.infer<typeof RepoLoss>;

/** One of its repos, before deleting or archiving: its GitHub repo and what its folder holds. */
export const RemovalRepo = z.object({
  name: z.string(),
  folder: z.string(),
  path: z.string(),
  github: z
    .object({
      fullName: z.string(),
      account: z.string(),
      url: z.string(),
      /** False while its link says it isn't created yet. */
      ready: z.boolean(),
      /** Owned by the account (its own, or an organisation it administers); null when unknown. */
      owned: z.boolean().nullable(),
      /** Already archived on GitHub; null when unknown. */
      archived: z.boolean().nullable(),
      /** The token's scopes, when GitHub says them (a classic token); null otherwise. */
      scopes: z.array(z.string()).nullable(),
      /** Whether the token may delete it: false when its scopes lack delete_repo, null when unknown. */
      canDelete: z.boolean().nullable(),
      /** Why GitHub couldn't be asked about it. */
      error: z.string().nullable(),
    })
    .nullable(),
  loss: RepoLoss,
});
export type RemovalRepo = z.infer<typeof RemovalRepo>;

/** What deleting or archiving would touch (`projects.removalPreview`). */
export const RemovalPreview = z.object({
  id: Id,
  name: z.string(),
  folder: z.object({
    path: z.string(),
    exists: z.boolean(),
    /** Its size on disk, symlinks not followed; null when not measured. */
    bytes: z.number().nullable(),
    files: z.number().int(),
    /** Measuring stopped early: it is at least this much. */
    partial: z.boolean(),
    /** Why it can't be deleted here (a dangerous path); null when it can. */
    refused: z.string().nullable(),
  }),
  runningJobs: z.array(z.object({ id: z.string(), title: z.string() })),
  repos: z.array(RemovalRepo),
  /** Files in its folder that are in none of its repos (a project of several), the first few. */
  outside: z.array(z.string()),
  /** Whether archiving may delete the folder, and if not, each reason. */
  archiveFolder: z.object({ allowed: z.boolean(), reasons: z.array(z.string()) }),
  archivedWith: z
    .object({ githubArchived: z.array(z.string()), folderDeleted: z.boolean() })
    .nullable(),
});
export type RemovalPreview = z.infer<typeof RemovalPreview>;

/** One step of deleting, archiving or unarchiving, and how it went. */
export const RemovalStep = z.object({
  kind: z.enum([
    "jobs",
    "records",
    "folder",
    "github-delete",
    "github-archive",
    "github-unarchive",
    "restore",
    "archive",
  ]),
  /** What it was about: the folder's path, a repo's owner/name, the project's name. */
  target: z.string(),
  status: z.enum(["done", "failed", "skipped"]),
  /** In words: what was done, or why not. */
  message: z.string(),
});
export type RemovalStep = z.infer<typeof RemovalStep>;

export const RemovalResult = z.object({
  /** Every step asked for, in order. */
  steps: z.array(RemovalStep),
  /** Whether the project is still in Oraknid (deleting stopped before its records went). */
  kept: z.boolean(),
  /** Jobs deleted with it. */
  jobs: z.number().int(),
  folder: z.string(),
});
export type RemovalResult = z.infer<typeof RemovalResult>;

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
