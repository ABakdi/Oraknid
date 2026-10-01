import type { JobResult } from "@oraknid/contracts";
import { eq } from "drizzle-orm";
import type { Db } from "../db/open.ts";
import { jobs, projects, tasks } from "../db/schema.ts";
import type { EventBus } from "../events/bus.ts";
import {
  commitPatch,
  commitsAhead,
  diffSince,
  hasRef,
  isMerged,
  type MergeResult,
  mergeBranch,
  shadowRepo,
  worktreeGit,
} from "./git.ts";

// A finished job's result: where it is, and merging it into the work
// branch (Jobs-and-Projects → Ending a job, Checkpoint 1 → F1-5).

function load(db: Db, jobId: string) {
  const job = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!job) throw new Error(`No job ${jobId}.`);
  const project = db.select().from(projects).where(eq(projects.id, job.projectId)).get();
  if (!project) throw new Error(`No project for job ${jobId}.`);
  return { job, project };
}

export function jobResult(db: Db, jobId: string): JobResult {
  const { job, project } = load(db, jobId);
  const into = project.workBranch;
  if (!job.branch || !project.isGitRepo)
    return {
      folder: job.worktree,
      branch: null,
      into,
      commits: [],
      merged: false,
      cannotMerge: job.worktree
        ? "The project is not a git repository: the work is in the folder itself."
        : "The job has not started yet.",
    };
  const merged = isMerged(project.workspacePath, into, job.branch);
  const commits = commitsAhead(project.workspacePath, into, job.branch);
  return {
    folder: job.worktree,
    branch: job.branch,
    into,
    commits,
    merged,
    cannotMerge: merged
      ? `Already merged into ${into}.`
      : !commits.length
        ? "There is nothing to merge yet."
        : job.state !== "completed"
          ? "The job isn't finished; merge it once it is completed."
          : null,
  };
}

/** My action: pressing Merge is the approval (BR-04). */
export function mergeJob(db: Db, bus: EventBus, jobId: string): MergeResult {
  const { job, project } = load(db, jobId);
  const result = jobResult(db, jobId);
  if (result.cannotMerge || !job.branch)
    return { ok: false, reason: result.cannotMerge ?? "Nothing to merge.", conflicts: [] };
  const r = mergeBranch(
    project.workspacePath,
    project.workBranch,
    job.branch,
    `merge: ${job.title.charAt(0).toLowerCase()}${job.title.slice(1)}`,
  );
  bus.publish({
    type: r.ok ? "job.merged" : "job.merge-failed",
    topic: `job:${jobId}`,
    jobId,
    payload: r.ok
      ? { into: project.workBranch, branch: job.branch, commit: r.commit }
      : { into: project.workBranch, branch: job.branch, reason: r.reason, conflicts: r.conflicts },
    actor: "owner",
  });
  return r;
}

const MAX_DIFF = 200_000;

/**
 * A task's work as a patch (Web-UI → Task drawer; Phase 2 → M2.0): its
 * commit once done, or what changed since before its first attempt.
 */
export async function taskDiff(
  db: Db,
  taskId: string,
  tmpDir: string,
): Promise<{ text: string; from: "commit" | "work" | "none"; truncated: boolean }> {
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!task) throw new Error(`No task ${taskId}.`);
  const { job, project } = load(db, task.jobId);
  if (!job.worktree) return { text: "", from: "none", truncated: false };
  // A task running beside others works in its own worktree (ADR-016).
  const tree = task.worktree ?? job.worktree;
  const g = project.isGitRepo ? worktreeGit(project.workspacePath, tree) : shadowRepo(tree);
  const base = `refs/oraknid/${job.id}/${task.id}/base`;
  const text = task.commit
    ? await commitPatch(g, task.commit)
    : hasRef(g, base)
      ? await diffSince(g, base, tmpDir)
      : "";
  const from = task.commit ? "commit" : text ? "work" : "none";
  return {
    text:
      text.length > MAX_DIFF
        ? `${text.slice(0, MAX_DIFF)}\n… (cut: ${text.length - MAX_DIFF} more characters)`
        : text,
    from,
    truncated: text.length > MAX_DIFF,
  };
}
