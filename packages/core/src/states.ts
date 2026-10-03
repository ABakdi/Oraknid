import type { JobState, TaskState } from "@oraknid/contracts";

// The life cycles of docs/01-Specification/Core-Entities.md, as data.
// Every state change in the daemon goes through these tables.

const JOB: Record<JobState, readonly JobState[]> = {
  draft: ["interviewing", "planning", "cancelled"],
  interviewing: ["planning", "paused", "waiting", "cancelled"],
  planning: ["running", "paused", "waiting", "blocked", "cancelled"],
  running: ["paused", "waiting", "blocked", "verifying", "cancelled"],
  waiting: ["running", "interviewing", "planning", "verifying", "paused", "cancelled"],
  paused: ["running", "interviewing", "planning", "verifying", "cancelled"],
  blocked: ["running", "planning", "paused", "cancelled"],
  verifying: ["running", "completed", "paused", "waiting", "blocked", "cancelled"],
  completed: [],
  cancelled: [],
};

const TASK: Record<TaskState, readonly TaskState[]> = {
  pending: ["ready", "skipped", "paused"],
  ready: ["assigned", "skipped", "paused", "pending"],
  assigned: ["running", "ready", "paused"],
  running: ["verifying", "ready", "failed", "paused"],
  verifying: ["done", "running", "ready", "failed", "paused"],
  done: [],
  failed: ["ready", "skipped"],
  skipped: ["ready"],
  paused: ["ready", "pending"],
};

export const canJob = (from: JobState, to: JobState) => JOB[from].includes(to);
export const canTask = (from: TaskState, to: TaskState) => TASK[from].includes(to);

export const isTerminalJob = (s: JobState) => JOB[s].length === 0;

export class IllegalTransition extends Error {
  constructor(kind: "job" | "task", from: string, to: string) {
    super(`A ${kind} cannot go from ${from} to ${to}.`);
    this.name = "IllegalTransition";
  }
}

export function assertJob(from: JobState, to: JobState) {
  if (!canJob(from, to)) throw new IllegalTransition("job", from, to);
}

export function assertTask(from: TaskState, to: TaskState) {
  if (!canTask(from, to)) throw new IllegalTransition("task", from, to);
}
