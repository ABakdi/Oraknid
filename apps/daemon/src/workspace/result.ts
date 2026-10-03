import { join } from "node:path";
import type { JobResult, ProjectRepo } from "@oraknid/contracts";
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
  mergeConflicts,
  shadowRepo,
  worktreeGit,
} from "./git.ts";
import { viewOf } from "./projects.ts";
import { isSeveral } from "./repos.ts";
import { multiTreeOf } from "./tree.ts";

// A finished job's result: where it is, and merging it into the work
// branch (Jobs-and-Projects → Ending a job, Checkpoint 1 → F1-5). In a
// project of several repos (ADR-042), each repo it touched has its branch
// and commits, and Merge merges each into that repo's work branch.

function load(db: Db, jobId: string) {
  const job = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!job) throw new Error(`No job ${jobId}.`);
  const row = db.select().from(projects).where(eq(projects.id, job.projectId)).get();
  if (!row) throw new Error(`No project for job ${jobId}.`);
  return { job, project: viewOf(row) };
}

const repoPath = (projectPath: string, r: ProjectRepo) =>
  r.folder ? join(projectPath, ...r.folder.split("/")) : projectPath;

/** Each repo the job touched, its commits and whether it is merged. */
function perRepo(db: Db, jobId: string) {
  const { job, project } = load(db, jobId);
  const touched = new Set(job.repos.map((r) => r.name));
  return project.repos
    .filter((r) => touched.has(r.name) && job.branch)
    .map((r) => {
      const path = repoPath(project.workspacePath, r);
      const branch = job.branch as string;
      return {
        repo: r,
        path,
        name: r.name,
        folder: r.folder,
        branch,
        into: r.workBranch,
        commits: commitsAhead(path, r.workBranch, branch),
        merged: isMerged(path, r.workBranch, branch),
      };
    });
}

export function jobResult(db: Db, jobId: string): JobResult {
  const { job, project } = load(db, jobId);
  const into = project.workBranch;
  if (isSeveral(project.repos) && job.branch) {
    const repos = perRepo(db, jobId);
    const withWork = repos.filter((r) => r.commits.length);
    const merged = repos.length > 0 && repos.every((r) => r.merged);
    const intos = [...new Set(repos.map((r) => r.into))];
    return {
      folder: job.worktree,
      branch: job.branch,
      into: intos.length === 1 ? (intos[0] as string) : "each repo's work branch",
      commits: withWork.flatMap((r) => r.commits).sort((a, b) => b.at - a.at),
      merged,
      cannotMerge: merged
        ? "Already merged into each repo's work branch."
        : !withWork.length
          ? "There is nothing to merge yet."
          : job.state !== "completed"
            ? "The job isn't finished; merge it once it is completed."
            : null,
      repos: repos.map(({ name, folder, branch, into, commits, merged }) => ({
        name,
        folder,
        branch,
        into,
        commits,
        merged,
      })),
    };
  }
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
      repos: [],
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
    repos: [],
  };
}

/** My action: pressing Merge is the approval (BR-04). */
export function mergeJob(db: Db, bus: EventBus, jobId: string): MergeResult {
  const { job, project } = load(db, jobId);
  const result = jobResult(db, jobId);
  if (result.cannotMerge || !job.branch)
    return { ok: false, reason: result.cannotMerge ?? "Nothing to merge.", conflicts: [] };
  const message = `merge: ${job.title.charAt(0).toLowerCase()}${job.title.slice(1)}`;
  if (isSeveral(project.repos)) return mergeRepos(db, bus, jobId, message);
  const r = mergeBranch(project.workspacePath, project.workBranch, job.branch, message);
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

/**
 * Each repo's job branch into its work branch (ADR-042). Every merge is
 * computed first: a conflict in one merges none, so the repos never end up
 * half merged.
 */
function mergeRepos(db: Db, bus: EventBus, jobId: string, message: string): MergeResult {
  const todo = perRepo(db, jobId).filter((r) => r.commits.length && !r.merged);
  const conflicts = todo.flatMap((r) =>
    mergeConflicts(r.path, r.into, r.branch).map((f) => `${r.folder}/${f}`),
  );
  const fail = (reason: string, files: string[]): MergeResult => {
    bus.publish({
      type: "job.merge-failed",
      topic: `job:${jobId}`,
      jobId,
      payload: { repos: todo.map((r) => r.name), reason, conflicts: files },
      actor: "owner",
    });
    return { ok: false, reason, conflicts: files };
  };
  if (conflicts.length) return fail("The branches conflict; nothing was merged.", conflicts);
  const done: { repo: string; into: string; commit: string }[] = [];
  for (const r of todo) {
    const m = mergeBranch(r.path, r.into, r.branch, message);
    if (!m.ok)
      return fail(
        `${r.name}: ${m.reason}${done.length ? ` (${done.map((x) => x.repo).join(", ")} merged already)` : ""}`,
        m.conflicts.map((f) => `${r.folder}/${f}`),
      );
    done.push({ repo: r.name, into: r.into, commit: m.commit });
  }
  bus.publish({
    type: "job.merged",
    topic: `job:${jobId}`,
    jobId,
    payload: { repos: done },
    actor: "owner",
  });
  return { ok: true, commit: done.map((x) => `${x.repo}:${x.commit}`).join(" ") };
}

const MAX_DIFF = 200_000;

/**
 * A task's work as a patch (Web-UI → Task drawer; Phase 2 → M2.0): its
 * commit once done, or what changed since before its first attempt. In a
 * project of several repos, each repo's part, its paths under its folder.
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
  const base = `refs/oraknid/${job.id}/${task.id}/base`;
  let text = "";
  if (isSeveral(project.repos)) {
    if (task.commits.length) {
      const parts: string[] = [];
      for (const c of task.commits) {
        const r = project.repos.find((x) => x.name === c.repo);
        if (r)
          parts.push(
            await commitPatch(
              { cwd: repoPath(project.workspacePath, r), base: [] },
              c.sha,
              r.folder,
            ),
          );
      }
      text = parts.join("\n");
    } else {
      const tree = multiTreeOf(db, job, project, tmpDir);
      text = tree.opened().length ? await tree.diffSince(base) : "";
    }
  } else {
    // A task running beside others works in its own worktree (ADR-016).
    const tree = task.worktree ?? job.worktree;
    const g = project.isGitRepo ? worktreeGit(project.workspacePath, tree) : shadowRepo(tree);
    text = task.commit
      ? await commitPatch(g, task.commit)
      : hasRef(g, base)
        ? await diffSince(g, base, tmpDir)
        : "";
  }
  const from = task.commit || task.commits.length ? "commit" : text ? "work" : "none";
  return {
    text:
      text.length > MAX_DIFF
        ? `${text.slice(0, MAX_DIFF)}\n… (cut: ${text.length - MAX_DIFF} more characters)`
        : text,
    from,
    truncated: text.length > MAX_DIFF,
  };
}
