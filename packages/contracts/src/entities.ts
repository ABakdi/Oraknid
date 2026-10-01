import { z } from "zod";
import { Id, Markdown, Timestamp } from "./common.ts";

// Every entity here follows docs/01-Specification/Core-Entities.md.

// ── Project ─────────────────────────────────────────────────────────

export const Project = z.object({
  id: Id,
  name: z.string().min(1),
  workspacePath: z.string().min(1),
  isGitRepo: z.boolean(),
  releaseBranch: z.string().min(1),
  workBranch: z.string().min(1),
  createdAt: Timestamp,
  archivedAt: Timestamp.nullable(),
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
});
export type InboxItem = z.infer<typeof InboxItem>;

// ── Side effects (BR-6) ─────────────────────────────────────────────

export const SideEffectState = z.enum([
  "intended",
  "approved",
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
