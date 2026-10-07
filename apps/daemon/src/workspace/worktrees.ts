import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { join, sep } from "node:path";
import type { JobWorktree } from "@oraknid/contracts";
import { eq } from "drizzle-orm";
import type { Db } from "../db/open.ts";
import { jobs, projects } from "../db/schema.ts";
import type { EventBus } from "../events/bus.ts";
import { git, worktreeGit } from "./git.ts";
import { viewOf } from "./projects.ts";
import { jobResult } from "./result.ts";

// A job's worktree removed when I ask (Sandboxing → Worktrees, ADR-006):
// one job's, or every finished job's from Settings → Storage, with their
// sizes. The branch stays for review; what isn't merged or committed is
// said first, and removed only with my confirmation.

/** Ended: a paused, waiting or blocked job still needs its worktree. */
const finished = (state: string) => state === "completed" || state === "cancelled";

/** The folder a job's worktrees live in: only ever this one is removed. */
const rootOf = (projectPath: string, jobId: string) =>
  join(projectPath, ".oraknid", "worktrees", jobId);

/** Bytes under a folder, without following links. */
function bytesUnder(path: string): number {
  let n = 0;
  const walk = (dir: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else
        try {
          n += lstatSync(p).size;
        } catch {}
    }
  };
  walk(path);
  return n;
}

/** The registered worktrees of `repo` inside `root` (the job's own and its tasks'). */
function registered(repo: string, under: string[]): string[] {
  let out: string;
  try {
    out = git({ cwd: repo, base: [] }, ["worktree", "list", "--porcelain"]);
  } catch {
    return [];
  }
  return out
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length))
    .filter((p) => under.some((u) => p === u || p.startsWith(`${u}${sep}`)));
}

/** Files not committed in a worktree, by Oraknid's own git (never the worktree's `.git`). */
function uncommittedIn(repo: string, worktree: string): string[] {
  try {
    const g = worktreeGit(repo, worktree);
    return git(g, ["status", "--porcelain=v1", "--untracked-files=normal"])
      .split("\n")
      .filter(Boolean)
      .map((l) => l.slice(3).trim())
      .filter((f) => !f.startsWith(".oraknid"));
  } catch {
    return [];
  }
}

interface Found {
  jobId: string;
  projectPath: string;
  /** The repos (their folders) whose worktrees are under the job's folders. */
  repos: string[];
  /** The job's folder and its tasks' folders. */
  folders: string[];
}

function find(db: Db, jobId: string): Found | null {
  const job = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!job) throw new Error(`No job ${jobId}.`);
  const row = db.select().from(projects).where(eq(projects.id, job.projectId)).get();
  if (!row || !row.isGitRepo) return null;
  const project = viewOf(row);
  const base = join(project.workspacePath, ".oraknid", "worktrees");
  const own = rootOf(project.workspacePath, jobId);
  // Tasks beside others had worktrees of their own: `<job>-t-<n>` (ADR-016).
  const folders = existsSync(base)
    ? readdirSync(base)
        .filter((n) => n === jobId || n.startsWith(`${jobId}-t-`))
        .map((n) => join(base, n))
    : [];
  if (!folders.includes(own) && existsSync(own)) folders.push(own);
  if (!folders.length) return null;
  const repos = project.repos.map((r) =>
    r.folder ? join(project.workspacePath, ...r.folder.split("/")) : project.workspacePath,
  );
  return { jobId, projectPath: project.workspacePath, repos, folders };
}

/** Every ended job's worktree still on disk, biggest first. */
export function jobWorktrees(db: Db): JobWorktree[] {
  const out: JobWorktree[] = [];
  for (const job of db.select().from(jobs).all()) {
    if (!finished(job.state)) continue;
    const view = describe(db, job.id);
    if (view) out.push(view);
  }
  return out.sort((a, b) => b.bytes - a.bytes);
}

/** One job's worktree: its size, and what removing it would lose. */
export function describe(db: Db, jobId: string): JobWorktree | null {
  const found = find(db, jobId);
  if (!found) return null;
  const job = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!job) return null;
  let unmerged = 0;
  let into: string | null = null;
  try {
    const r = jobResult(db, jobId);
    into = r.into;
    if (!r.merged) unmerged = r.commits.length;
  } catch {}
  const uncommitted = found.repos.flatMap((repo) =>
    registered(repo, found.folders).flatMap((wt) => uncommittedIn(repo, wt)),
  );
  return {
    jobId,
    title: job.title,
    state: job.state,
    folder: rootOf(found.projectPath, jobId),
    branch: job.branch,
    into,
    bytes: found.folders.reduce((n, f) => n + bytesUnder(f), 0),
    unmerged,
    uncommitted: uncommitted.length,
  };
}

/**
 * Removes a finished job's worktrees (its own and its tasks'), its branch
 * kept. Work not merged or not committed is refused unless `confirm`.
 */
export function removeJobWorktree(
  db: Db,
  bus: EventBus,
  jobId: string,
  confirm: boolean,
): { bytes: number } {
  const job = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!job) throw new Error(`No job ${jobId}.`);
  if (!finished(job.state))
    throw new Error(
      `"${job.title}" hasn't ended; its worktree can be removed once it is completed or cancelled.`,
    );
  const view = describe(db, jobId);
  const found = find(db, jobId);
  if (!view || !found) throw new Error(`"${job.title}" has no worktree left to remove.`);
  if (!confirm && (view.unmerged || view.uncommitted)) {
    const what = [
      view.unmerged
        ? `${view.unmerged} commit${view.unmerged === 1 ? "" : "s"} not merged into ${view.into ?? "the work branch"} (the branch ${view.branch} stays)`
        : null,
      view.uncommitted
        ? `${view.uncommitted} file${view.uncommitted === 1 ? "" : "s"} changed and not committed (lost with it)`
        : null,
    ]
      .filter(Boolean)
      .join(" and ");
    throw new Error(`"${job.title}" has ${what}: confirm to remove its worktree anyway.`);
  }
  for (const repo of found.repos)
    for (const wt of registered(repo, found.folders)) {
      try {
        git({ cwd: repo, base: [] }, ["worktree", "remove", "--force", wt]);
      } catch {}
    }
  for (const folder of found.folders) rmSync(folder, { recursive: true, force: true });
  for (const repo of found.repos)
    try {
      git({ cwd: repo, base: [] }, ["worktree", "prune"]);
    } catch {}
  // Its folder is gone; its branch and record stay.
  db.update(jobs).set({ worktree: null }).where(eq(jobs.id, jobId)).run();
  bus.publish({
    type: "job.worktree-removed",
    topic: `job:${jobId}`,
    jobId,
    payload: {
      folder: view.folder,
      bytes: view.bytes,
      branch: view.branch,
      unmerged: view.unmerged,
      uncommitted: view.uncommitted,
    },
    actor: "owner",
  });
  return { bytes: view.bytes };
}

/**
 * "Clean up finished jobs' worktrees": every one that has nothing unmerged
 * or uncommitted; the others stay, named, for one at a time with a confirm.
 */
export function cleanFinishedWorktrees(
  db: Db,
  bus: EventBus,
): { removed: number; bytes: number; kept: { jobId: string; title: string }[] } {
  let removed = 0;
  let bytes = 0;
  const kept: { jobId: string; title: string }[] = [];
  for (const w of jobWorktrees(db)) {
    if (w.unmerged || w.uncommitted) {
      kept.push({ jobId: w.jobId, title: w.title });
      continue;
    }
    bytes += removeJobWorktree(db, bus, w.jobId, false).bytes;
    removed++;
  }
  return { removed, bytes, kept };
}
