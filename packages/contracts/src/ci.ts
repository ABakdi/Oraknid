import { z } from "zod";
import { GitHubRepoRef } from "./github.ts";

// GitHub Actions inside Oraknid (ADR-058): runs, their jobs and steps, a
// job's log cut by step, artifacts, workflows to run by hand, and a badge.

/** Where a run or a job is: GitHub's own words. */
export const CiStatus = z.enum([
  "queued",
  "in_progress",
  "completed",
  "waiting",
  "requested",
  "pending",
]);
export type CiStatus = z.infer<typeof CiStatus>;

/** How a finished run or job ended; null while it runs. */
export const CiConclusion = z
  .enum([
    "success",
    "failure",
    "cancelled",
    "skipped",
    "timed_out",
    "action_required",
    "neutral",
    "stale",
    "startup_failure",
  ])
  .nullable();
export type CiConclusion = z.infer<typeof CiConclusion>;

/** A conclusion that counts as failing (a notification, the check, the badge). */
export const isCiFailure = (c: CiConclusion | string | null | undefined) =>
  c === "failure" || c === "timed_out" || c === "startup_failure";

export const CiRun = z.object({
  id: z.number().int(),
  /** The workflow's name. */
  name: z.string(),
  /** What GitHub shows for it: the commit's title or the pull request's. */
  title: z.string(),
  workflowId: z.number().int(),
  branch: z.string().nullable(),
  sha: z.string(),
  /** push, pull_request, workflow_dispatch, schedule… */
  event: z.string(),
  status: CiStatus,
  conclusion: CiConclusion,
  /** Its attempt (1, then 2 after a re-run…). */
  attempt: z.number().int(),
  actor: z.string().nullable(),
  startedAt: z.string().nullable(),
  updatedAt: z.string(),
  /** From its start to its last update (or to now while it runs), ms; null before it starts. */
  durationMs: z.number().int().nullable(),
  url: z.string(),
  /** The pull requests it ran for. */
  pullRequests: z.array(z.number().int()),
});
export type CiRun = z.infer<typeof CiRun>;

export const CiStep = z.object({
  number: z.number().int(),
  name: z.string(),
  status: CiStatus,
  conclusion: CiConclusion,
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});
export type CiStep = z.infer<typeof CiStep>;

export const CiJob = z.object({
  id: z.number().int(),
  name: z.string(),
  status: CiStatus,
  conclusion: CiConclusion,
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  url: z.string().nullable(),
  steps: z.array(CiStep),
  /** The first step that failed, by name; null when none did. */
  failingStep: z.string().nullable(),
});
export type CiJob = z.infer<typeof CiJob>;

/** A run with its jobs. */
export const CiRunDetail = CiRun.extend({ jobs: z.array(CiJob) });
export type CiRunDetail = z.infer<typeof CiRunDetail>;

export const CiRunPage = z.object({
  items: z.array(CiRun),
  page: z.number().int(),
  next: z.boolean(),
  total: z.number().int(),
  /** GitHub asked Oraknid to wait: this is what it had, until `retryAt`. */
  stale: z.boolean(),
  retryAt: z.number().nullable(),
});
export type CiRunPage = z.infer<typeof CiRunPage>;

/** One step's part of a job's log. */
export const CiLogSection = z.object({
  /** The step's number; 0 for lines before any step (the runner's set-up). */
  number: z.number().int(),
  name: z.string(),
  conclusion: CiConclusion,
  failing: z.boolean(),
  lines: z.array(z.string()),
  /** Lines left out at its start (it was longer than Oraknid keeps). */
  cut: z.number().int(),
  /** With `q`: the indexes of the matching lines. */
  matches: z.array(z.number().int()),
});
export type CiLogSection = z.infer<typeof CiLogSection>;

/** A job's log, by step, the failing step first. */
export const CiLog = z.object({
  jobId: z.number().int(),
  jobName: z.string(),
  sections: z.array(CiLogSection),
  /** How many lines matched `q`, in all. */
  matchCount: z.number().int(),
  /** The log was longer than Oraknid keeps (4 MB): its start is left out. */
  truncated: z.boolean(),
});
export type CiLog = z.infer<typeof CiLog>;

export const CiArtifact = z.object({
  id: z.number().int(),
  name: z.string(),
  sizeBytes: z.number().int(),
  expired: z.boolean(),
  createdAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
});
export type CiArtifact = z.infer<typeof CiArtifact>;

/** One input of a workflow run by hand, as its file declares it. */
export const CiDispatchInput = z.object({
  name: z.string(),
  description: z.string(),
  required: z.boolean(),
  type: z.enum(["string", "boolean", "choice", "number", "environment"]),
  default: z.string().nullable(),
  options: z.array(z.string()),
});
export type CiDispatchInput = z.infer<typeof CiDispatchInput>;

export const CiWorkflow = z.object({
  id: z.number().int(),
  name: z.string(),
  path: z.string(),
  /** active, disabled_manually… */
  state: z.string(),
  /** It can be run by hand (workflow_dispatch). */
  dispatch: z.boolean(),
  inputs: z.array(CiDispatchInput),
});
export type CiWorkflow = z.infer<typeof CiWorkflow>;

/** A branch's CI at a glance: its latest commit's runs. */
export const CiBadge = z.object({
  state: z.enum(["passing", "failing", "running", "none", "unknown"]),
  branch: z.string(),
  fullName: z.string(),
  sha: z.string().nullable(),
  /** The run that decides it: the failing one, else a running one, else the latest. */
  run: CiRun.nullable(),
  /** The failing job and step, in words ("test → Run tests"). */
  failing: z.string().nullable(),
  /** Why it is unknown, in words. */
  error: z.string().nullable(),
});
export type CiBadge = z.infer<typeof CiBadge>;

/** A repository and a run in it. */
export const CiRunRef = GitHubRepoRef.extend({ runId: z.number().int().positive() });
export type CiRunRef = z.infer<typeof CiRunRef>;
