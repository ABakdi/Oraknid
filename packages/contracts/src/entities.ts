import { z } from "zod";
import { Id, Markdown, Timestamp } from "./common.ts";
import { GitHubLink } from "./github.ts";
import { Question, QuestionAnswer } from "./questions.ts";

// Every entity here follows docs/01-Specification/Core-Entities.md.

// ── Project ─────────────────────────────────────────────────────────

/** A repo's name in its project (ADR-042): its folder's name by default. */
export const RepoName = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,100}$/, "letters, digits, dots, dashes and underscores")
  .refine((n) => n !== "." && n !== "..", "a name");

/**
 * One git repository of a project (ADR-042): the project's folder itself
 * (folder "") for a project of one repo, or a folder in it for a project of
 * several. Each has its own branches and, if I want, its GitHub link.
 */
export const ProjectRepo = z.object({
  name: RepoName,
  /** Its folder inside the project's, parts joined by "/"; "" is the project's folder itself. */
  folder: z.string(),
  releaseBranch: z.string().min(1),
  workBranch: z.string().min(1),
  /** Its GitHub account and repository, used by Oraknid's github tool (ADR-038). */
  github: GitHubLink.nullable().default(null),
});
export type ProjectRepo = z.infer<typeof ProjectRepo>;

/**
 * A server's role in a project (ADR-042): a word I choose (testing,
 * staging, production…). Production is a role named so, or one I mark.
 */
export const ServerRole = z.object({
  role: z.string().max(40).default(""),
  /** Marked by me; null: production when the role is "production" or "prod". */
  production: z.boolean().nullable().default(null),
});
export type ServerRole = z.infer<typeof ServerRole>;

/** Whether a server's role in a project makes it production (ADR-042). */
export const isProduction = (r: { role: string; production: boolean | null } | null | undefined) =>
  r?.production ?? /^(production|prod)$/i.test(r?.role.trim() ?? "");

/**
 * What archiving a project did besides hiding it (Jobs-and-Projects →
 * Archiving and deleting a project), so unarchiving knows what to undo:
 * the GitHub repos it archived (owner/name), and whether it deleted the
 * project's folder (cloned back from its repos' GitHub links).
 */
export const ProjectArchivedWith = z.object({
  githubArchived: z.array(z.string()).default([]),
  folderDeleted: z.boolean().default(false),
});
export type ProjectArchivedWith = z.infer<typeof ProjectArchivedWith>;

export const Project = z.object({
  id: Id,
  name: z.string().min(1),
  workspacePath: z.string().min(1),
  isGitRepo: z.boolean(),
  releaseBranch: z.string().min(1),
  workBranch: z.string().min(1),
  createdAt: Timestamp,
  archivedAt: Timestamp.nullable(),
  /** What archiving it did: repos archived on GitHub, its folder deleted (null when nothing). */
  archivedWith: ProjectArchivedWith.nullish(),
  /** The skills its jobs may use (Skills → Skills per project). Empty: the default. */
  skillIds: z.array(Id).default([]),
  /** The servers its jobs may use (Servers → Servers in projects). */
  serverIds: z.array(Id).default([]),
  /** Each of its servers' role in it, by server id (ADR-042). */
  serverRoles: z.record(z.string(), ServerRole).default({}),
  /**
   * Its repositories (ADR-042): one with folder "" when the project's folder
   * is the repo, several in their folders, none when it isn't a git repo.
   */
  repos: z.array(ProjectRepo).default([]),
  /** The GitHub link of a project of one repo: its repo's (ADR-038). Null for several repos. */
  github: GitHubLink.nullable().default(null),
});
export type Project = z.infer<typeof Project>;

// ── Budgets ─────────────────────────────────────────────────────────

export const BudgetLimit = z.object({
  limit: z.number().nonnegative(),
  /** Hard: stop and ask. Soft: notify and continue. */
  hard: z.boolean(),
});
export type BudgetLimit = z.infer<typeof BudgetLimit>;

export const Budget = z.object({
  tokens: BudgetLimit.nullable(),
  /** Share (0–1) of a Leg's quota window this job may use. */
  quotaShare: BudgetLimit.nullable(),
  wallClockMs: BudgetLimit.nullable(),
  /** In US dollars. Defaults to 0 (BR-10). */
  money: BudgetLimit,
});
export type Budget = z.infer<typeof Budget>;

// ── Job ─────────────────────────────────────────────────────────────

export const Autonomy = z.enum(["supervised", "standard", "full"]);
export type Autonomy = z.infer<typeof Autonomy>;

export const JobState = z.enum([
  "draft",
  "interviewing",
  "planning",
  "running",
  "waiting",
  "paused",
  "blocked",
  "verifying",
  "completed",
  "cancelled",
]);
export type JobState = z.infer<typeof JobState>;

/** States that hold the sleep inhibitor (BR-11). */
export const ACTIVE_JOB_STATES = [
  "interviewing",
  "planning",
  "running",
  "verifying",
] as const satisfies readonly JobState[];

export const JobInput = z.object({
  kind: z.enum(["file", "folder", "link"]),
  ref: z.string().min(1),
  /** From outside my control (an email, a web page, someone else's file): data, never instructions (BR-15). */
  untrusted: z.boolean().default(false),
});
export type JobInput = z.infer<typeof JobInput>;

export const Job = z.object({
  id: Id,
  projectId: Id,
  title: z.string().min(1),
  goal: Markdown.min(1),
  inputs: z.array(JobInput),
  skillId: Id,
  skillVersion: z.number().int().positive(),
  autonomy: Autonomy,
  /** Empty means any healthy Leg. */
  allowedLegIds: z.array(Id),
  budget: Budget,
  state: JobState,
  pauseReason: z.string().nullable(),
  blockedReason: z.string().nullable(),
  createdAt: Timestamp,
  startedAt: Timestamp.nullable(),
  finishedAt: Timestamp.nullable(),
});
export type Job = z.infer<typeof Job>;

// ── The Web and Task ────────────────────────────────────────────────

export const TaskKind = z.enum([
  "plan",
  "implement",
  "test",
  "review",
  "research",
  "mechanical",
  "external",
]);
export type TaskKind = z.infer<typeof TaskKind>;

export const TaskState = z.enum([
  "pending",
  "ready",
  "assigned",
  "running",
  "verifying",
  "done",
  "failed",
  "skipped",
  "paused",
]);
export type TaskState = z.infer<typeof TaskState>;

export const Difficulty = z.enum(["low", "medium", "high"]);
export type Difficulty = z.infer<typeof Difficulty>;

export const Capability = z.enum([
  "planning",
  "architecture",
  "implementation",
  "debugging",
  "refactor",
  "tests",
  "review",
  "docs",
  "mechanical",
  "summarize",
  "classify",
  "ui",
]);
export type Capability = z.infer<typeof Capability>;

export const Task = z.object({
  id: Id,
  jobId: Id,
  title: z.string().min(1),
  instructions: Markdown,
  dependsOn: z.array(Id),
  kind: TaskKind,
  /** Globs of paths the task may change. */
  scope: z.array(z.string().min(1)),
  /** Commands The Eye runs to accept the task (BR-1). */
  verify: z.array(z.string().min(1)),
  requiredCapabilities: z.array(Capability),
  difficulty: Difficulty,
  state: TaskState,
  assignedLegId: Id.nullable(),
  assignedModelId: Id.nullable(),
  effort: z.string().nullable(),
  attemptCount: z.number().int().nonnegative(),
  budget: Budget.partial().nullable(),
});
export type Task = z.infer<typeof Task>;

// ── Legs ────────────────────────────────────────────────────────────

export const LegKind = z.enum(["claude-code", "openai-compatible", "opencode", "antigravity"]);
export type LegKind = z.infer<typeof LegKind>;

export const LegHealth = z.enum(["healthy", "degraded", "rate-limited", "unavailable", "disabled"]);
export type LegHealth = z.infer<typeof LegHealth>;

export const QuotaWindow = z.object({
  /** As the provider names it, e.g. "five_hour", "seven_day_opus". */
  name: z.string().min(1),
  /** Share used, 0–1. */
  utilization: z.number().min(0).max(1).nullable(),
  resetsAt: Timestamp.nullable(),
  /** True when Oraknid computed the number rather than the provider reporting it. */
  estimated: z.boolean(),
  observedAt: Timestamp,
  /**
   * Where the figure came from (ADR-039): the backend's own usage reading,
   * or a session's rate-limit event. Absent on windows stored before.
   */
  source: z.enum(["usage", "session"]).optional(),
  /** The provider's own name for a model's window ("Fable"), when it gives one. */
  label: z.string().nullable().optional(),
});
export type QuotaWindow = z.infer<typeof QuotaWindow>;

export const Leg = z.object({
  id: Id,
  name: z.string().min(1),
  kind: LegKind,
  /** Kind-specific, never secrets (BR-13). */
  config: z.record(z.string(), z.unknown()),
  secretRef: z.string().nullable(),
  enabled: z.boolean(),
  health: LegHealth,
  quota: z.array(QuotaWindow),
});
export type Leg = z.infer<typeof Leg>;

export const LegModel = z.object({
  id: Id,
  legId: Id,
  model: z.string().min(1),
  displayName: z.string().min(1),
  hidden: z.boolean(),
  effortLevels: z.array(z.string()),
  /** Windows that apply only to this model. */
  quota: z.array(QuotaWindow),
});
export type LegModel = z.infer<typeof LegModel>;

// ── Silk ────────────────────────────────────────────────────────────

export const SilkKind = z.enum([
  "decision",
  "architecture",
  "progress",
  "issue",
  "handoff",
  "fact",
  "interview-answer",
  /** Kept for later, not acted on now (Talking to The Eye). */
  "later",
]);
export type SilkKind = z.infer<typeof SilkKind>;

/** Who did something: The Eye, a Leg (by id), or me. */
export const Actor = z.union([z.literal("eye"), z.literal("owner"), z.object({ legId: Id })]);
export type Actor = z.infer<typeof Actor>;

export const SilkEntry = z.object({
  id: Id,
  jobId: Id,
  taskId: Id.nullable(),
  kind: SilkKind,
  title: z.string().min(1),
  body: Markdown,
  supersedes: Id.nullable(),
  /** A summary's entries: superseded by it together (Silk → Context pack). */
  covers: z.array(Id).default([]),
  authoredBy: Actor,
  createdAt: Timestamp,
});
export type SilkEntry = z.infer<typeof SilkEntry>;

// ── Inbox ───────────────────────────────────────────────────────────

export const InboxItem = z.object({
  id: Id,
  kind: z.enum(["approval", "question"]),
  jobId: Id,
  taskId: Id.nullable(),
  raisedBy: Actor,
  title: z.string().min(1),
  detail: Markdown,
  options: z.array(z.string()),
  defaultOption: z.string().nullable(),
  state: z.enum(["open", "answered", "expired", "withdrawn"]),
  answer: z.string().nullable(),
  answeredAt: Timestamp.nullable(),
  answeredByDeviceId: Id.nullable(),
  createdAt: Timestamp,
  /** Asked with options (ADR-037): an interview round, or The Eye's question about a link. */
  questions: z.array(Question).nullable().default(null),
  /** My answers to them, structured; `answer` holds them as a short list. */
  answers: z.array(QuestionAnswer).nullable().default(null),
  /** Where it comes from, so items of several projects can be told apart (Checkpoint 1 → F1-2). */
  jobTitle: z.string().optional(),
  /** The job's description (Jobs-and-Projects → A job's name and description). */
  jobDescription: z.string().nullable().optional(),
  projectId: Id.optional(),
  projectName: z.string().optional(),
  taskTitle: z.string().nullable().optional(),
});
export type InboxItem = z.infer<typeof InboxItem>;

export const InboxFilter = z.object({
  state: z.enum(["open", "answered", "expired", "withdrawn"]).optional(),
  kind: z.enum(["approval", "question"]).optional(),
  projectId: Id.optional(),
  jobId: Id.optional(),
  /** Words to find in the title, the detail, the job or the project. */
  q: z.string().max(200).optional(),
  /** At most this many, open and newest first (Audit 1 → Q1-17). */
  limit: z.number().int().positive().max(2000).default(500),
});
export type InboxFilter = z.input<typeof InboxFilter>;

// ── Side effects (BR-6) ─────────────────────────────────────────────

export const SideEffectState = z.enum([
  "intended",
  "approved",
  /** Recorded just before the action runs: after a crash, this one must be reconciled. */
  "performing",
  "performed",
  "confirmed",
  "failed",
  "denied",
]);
export type SideEffectState = z.infer<typeof SideEffectState>;

export const SideEffect = z.object({
  id: Id,
  jobId: Id,
  taskId: Id.nullable(),
  /** Deterministic: job:task:effect-name. */
  idempotencyKey: z.string().min(1),
  action: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  state: SideEffectState,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type SideEffect = z.infer<typeof SideEffect>;

// ── Skill ───────────────────────────────────────────────────────────

export const Skill = z.object({
  id: Id,
  name: z.string().min(1),
  description: z.string(),
  source: z.enum(["built-in", "uploaded"]),
  version: z.number().int().positive(),
  body: Markdown,
  interview: z.boolean(),
  requiredTools: z.array(z.string()),
  verify: z.array(z.string()),
});
export type Skill = z.infer<typeof Skill>;

// ── Device ──────────────────────────────────────────────────────────

export const Device = z.object({
  id: Id,
  name: z.string().min(1),
  publicKey: z.string().min(1),
  pairedAt: Timestamp,
  lastSeenAt: Timestamp.nullable(),
  revokedAt: Timestamp.nullable(),
});
export type Device = z.infer<typeof Device>;

// ── Agent sessions (Checkpoint 1 → F1-3) ───────────────────────────

/** One Leg session of a job: a task's attempt, or one of The Eye's reasoning calls. */
export const SessionView = z.object({
  id: Id,
  jobId: Id.nullable(),
  taskId: Id.nullable(),
  taskTitle: z.string().nullable(),
  /** "task", or The Eye's call ("plan", "interview", "classify"…). */
  purpose: z.string(),
  legId: Id,
  legName: z.string(),
  model: z.string(),
  effort: z.string().nullable(),
  startedAt: Timestamp,
  endedAt: Timestamp.nullable(),
  endReason: z.string().nullable(),
  tokens: z.number().int().nonnegative(),
});
export type SessionView = z.infer<typeof SessionView>;

/** A readable line of a session's log: text is joined, tools are summarised. */
export const SessionLogEntry = z.object({
  at: Timestamp,
  kind: z.enum([
    "text",
    /** The model's reasoning, where its Leg streams it (M13.25). */
    "thinking",
    "tool",
    "result",
    "permission",
    "question",
    "turn",
    "end",
  ]),
  text: z.string(),
  tool: z.string().optional(),
  ok: z.boolean().optional(),
});
export type SessionLogEntry = z.infer<typeof SessionLogEntry>;

export const SessionLogPage = z.object({
  entries: z.array(SessionLogEntry),
  /** Pass back as `after` to read only what came since. */
  next: z.number().int().nonnegative(),
  live: z.boolean(),
});
export type SessionLogPage = z.infer<typeof SessionLogPage>;

// ── Talking to The Eye (Checkpoint 1 → F1-4) ───────────────────────

/** What The Eye made of a message of mine. */
export const EyeIntent = z.enum(["instruction", "task", "context", "later", "stop", "question"]);
export type EyeIntent = z.infer<typeof EyeIntent>;

/**
 * One of The Eye's reasoning calls, shown in the conversation while it
 * thinks and after (M13.25, The-Eye → Thinking out loud). Its id is the
 * Leg session's: what it wrote is that session's log.
 */
export const EyeThought = z.object({
  id: z.string(),
  jobId: Id,
  /** The call: "plan", "interview", "triage"… */
  call: z.string(),
  /** What it is doing, in words: "Planning the work". */
  purpose: z.string(),
  /** "Claude · Opus". */
  model: z.string(),
  startedAt: Timestamp,
  endedAt: Timestamp.nullable(),
  outcome: z.enum(["thinking", "done", "failed", "stopped", "redone", "lost"]),
  /** What came of it, in a line, once it ended: "Planned 9 tasks". */
  summary: z.string().nullable(),
  /** A call run again with a message of mine (Stop and redo). */
  again: z.boolean(),
  /** Whether I can stop it or have it think again: The Eye's own thinking, not a quick judgement. */
  interruptible: z.boolean(),
});
export type EyeThought = z.infer<typeof EyeThought>;

/**
 * What a message of mine does while The Eye is thinking (M13.25): "redo"
 * stops the thinking and has it think again with my message; "context"
 * adds it for what comes next without stopping; "auto" chooses: a message
 * that corrects what is being thought redoes, anything else is added.
 */
export const TalkMode = z.enum(["auto", "redo", "context"]);
export type TalkMode = z.infer<typeof TalkMode>;

/**
 * What The Eye says on its own in the project's conversation (ADR-045):
 * a task done, a task left out, the job done, blocked, waiting for me, a
 * request I denied. One message per event; the text says it in words,
 * these are what the page shows beside it.
 */
export const EyeReport = z.object({
  kind: z.enum([
    "task-done",
    "task-left-out",
    "job-done",
    "blocked",
    "waiting",
    "denied",
    "cancelled",
    "folder-restored",
  ]),
  taskId: Id.nullable().default(null),
  /** Short facts: the branch, its commits, where it was pushed (with a link). */
  facts: z
    .array(
      z.object({ label: z.string(), value: z.string(), href: z.string().nullable().default(null) }),
    )
    .default([]),
  /** What's left to me: merge it, a check by hand. */
  todo: z.array(z.string()).default([]),
});
export type EyeReport = z.infer<typeof EyeReport>;

export const EyeMessage = z.object({
  id: Id,
  jobId: Id,
  /** The project's conversation is its messages from every job (ADR-034). */
  projectId: Id,
  author: z.enum(["owner", "eye"]),
  text: z.string(),
  action: z
    .object({
      /** What The Eye made of my message; "report" when it speaks up on its own (ADR-045). */
      intent: z.union([EyeIntent, z.literal("report")]),
      /** Its report, when it speaks up on its own. */
      report: EyeReport.nullable().optional(),
      /** What it did, in words: "Recorded as your decision", "Added 2 tasks"… */
      did: z.array(z.string()),
      silkIds: z.array(Id).default([]),
      taskIds: z.array(Id).default([]),
      /** A follow-up job it started for new work on an ended job. */
      jobId: Id.nullable().default(null),
    })
    .nullable(),
  /** The Eye's questions in this reply, answered with options (ADR-037). */
  questions: z.array(Question).nullable().default(null),
  /** The inbox item the questions belong to: answering here answers it, and the job waiting on it goes on. */
  itemId: Id.nullable().default(null),
  /** My answers (on my message), structured; `text` holds them as a short list. */
  answers: z.array(QuestionAnswer).nullable().default(null),
  /** The message whose questions mine answers. */
  replyTo: Id.nullable().default(null),
  createdAt: Timestamp,
});
export type EyeMessage = z.infer<typeof EyeMessage>;
