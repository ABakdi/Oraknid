import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

// Git for The Eye (Sandboxing → Worktrees, Drift-Control → Checkpoints):
// worktrees per job, checkpoints on private refs, rollback, diffs.

export class GitError extends Error {}

export interface Git {
  /** The work tree commands run in. */
  cwd: string;
  /** Extra arguments for a shadow repo (`--git-dir … --work-tree …`). */
  base: string[];
}

export function git(g: Git, args: string[], env: Record<string, string> = {}): string {
  const r = spawnSync("git", [...g.base, ...args], {
    cwd: g.cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0)
    throw new GitError(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim()}`);
  return r.stdout;
}

const ok = (g: Git, args: string[]) =>
  spawnSync("git", [...g.base, ...args], { cwd: g.cwd, encoding: "utf8" }).status === 0;

export const isGitRepo = (path: string) =>
  ok({ cwd: path, base: [] }, ["rev-parse", "--is-inside-work-tree"]);

/** The repo's branches by BR-14: its own if it has them, else main and dev. */
export function detectBranches(path: string): { release: string; work: string } {
  const g = { cwd: path, base: [] };
  const branches = isGitRepo(path)
    ? git(g, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])
        .split("\n")
        .filter(Boolean)
    : [];
  const current = isGitRepo(path) ? git(g, ["symbolic-ref", "--short", "HEAD"]).trim() : "";
  const release = ["main", "master"].find((b) => branches.includes(b) || current === b) ?? "main";
  const work = ["dev", "develop", "development"].find((b) => branches.includes(b)) ?? "dev";
  return { release, work };
}

/**
 * Oraknid's folder stays out of my repo, except the Silk mirror, which I
 * may commit (Jobs-and-Projects → Projects).
 */
export function excludeOraknid(g: Git, gitDir: string) {
  const file = join(gitDir, "info", "exclude");
  mkdirSync(dirname(file), { recursive: true });
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (text.includes("/.oraknid/*")) return;
  appendFileSync(
    file,
    `${text.endsWith("\n") || !text ? "" : "\n"}# Oraknid\n/.oraknid/*\n!/.oraknid/silk/\n`,
  );
  void g;
}

export const gitDirOf = (g: Git) => {
  const d = git(g, ["rev-parse", "--git-common-dir"]).trim();
  return d.startsWith("/") ? d : join(g.cwd, d);
};

/** A shadow repo for a folder that is not a git repo: checkpoints only, my folder untouched. */
export function shadowRepo(path: string): Git {
  const gitDir = join(path, ".oraknid", "shadow.git");
  const g = { cwd: path, base: ["--git-dir", gitDir, "--work-tree", path] };
  if (!existsSync(gitDir)) {
    mkdirSync(dirname(gitDir), { recursive: true });
    spawnSync("git", ["init", "-q", "--bare", gitDir]);
    git(g, ["config", "core.bare", "false"]);
    excludeOraknid(g, gitDir);
    git(
      g,
      ["commit", "-q", "--allow-empty", "-m", "chore: start the checkpoint history"],
      authorEnv(),
    );
  }
  return g;
}

/** Commits as me when git knows me, as Oraknid otherwise. */
function authorEnv(): Record<string, string> {
  const name = spawnSync("git", ["config", "user.name"], { encoding: "utf8" }).stdout.trim();
  const email = spawnSync("git", ["config", "user.email"], { encoding: "utf8" }).stdout.trim();
  return name && email
    ? {}
    : {
        GIT_AUTHOR_NAME: "Oraknid",
        GIT_AUTHOR_EMAIL: "oraknid@localhost",
        GIT_COMMITTER_NAME: "Oraknid",
        GIT_COMMITTER_EMAIL: "oraknid@localhost",
      };
}

/**
 * The job's worktree, on a job branch made from the work branch (made
 * from the release branch when it doesn't exist yet). A repo with no
 * commit gets an empty first one.
 */
export function createWorktree(
  repoPath: string,
  jobId: string,
  slug: string,
  branches: { release: string; work: string },
) {
  const g = { cwd: repoPath, base: [] };
  if (!ok(g, ["rev-parse", "--verify", "HEAD"])) {
    git(g, ["commit", "-q", "--allow-empty", "-m", "chore: start the repository"], authorEnv());
  }
  excludeOraknid(g, gitDirOf(g));
  if (!ok(g, ["rev-parse", "--verify", `refs/heads/${branches.work}`])) {
    const from = ok(g, ["rev-parse", "--verify", `refs/heads/${branches.release}`])
      ? branches.release
      : "HEAD";
    git(g, ["branch", branches.work, from]);
  }
  const path = join(repoPath, ".oraknid", "worktrees", jobId);
  const branch = `oraknid/${slug}-${jobId.slice(-6).toLowerCase()}`;
  if (!existsSync(path)) git(g, ["worktree", "add", "-q", "-b", branch, path, branches.work]);
  return { path, branch };
}

/** A tree object of the work tree as it is now, untracked files included, without touching the index. */
function snapshotTree(g: Git, tmpDir: string): string {
  mkdirSync(tmpDir, { recursive: true });
  const index = join(tmpDir, `index-${process.pid}-${Date.now()}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    if (ok(g, ["rev-parse", "--verify", "HEAD"])) git(g, ["read-tree", "HEAD"], env);
    // Oraknid's own folder (Silk mirror, trash, worktrees) is never part of a checkpoint.
    git(g, ["add", "-A", "--", ".", ":(exclude).oraknid"], env);
    return git(g, ["write-tree"], env).trim();
  } finally {
    rmSync(index, { force: true });
  }
}

/** Records the work tree on a private ref; my branch, HEAD and index are untouched. */
export function checkpoint(g: Git, ref: string, message: string, tmpDir: string): string {
  const tree = snapshotTree(g, tmpDir);
  const parent = ok(g, ["rev-parse", "--verify", "HEAD"])
    ? ["-p", git(g, ["rev-parse", "HEAD"]).trim()]
    : [];
  const commit = git(g, ["commit-tree", tree, ...parent, "-m", message], authorEnv()).trim();
  git(g, ["update-ref", ref, commit]);
  return commit;
}

/** Paths that differ between a checkpoint and the work tree now. */
export function changedSince(g: Git, ref: string, tmpDir: string): string[] {
  const tree = snapshotTree(g, tmpDir);
  return git(g, ["diff", "--name-only", `${ref}^{tree}`, tree])
    .split("\n")
    .filter(Boolean);
}

export function diffStatSince(g: Git, ref: string, tmpDir: string): string {
  const tree = snapshotTree(g, tmpDir);
  return git(g, ["diff", "--stat", `${ref}^{tree}`, tree]);
}

/**
 * Puts the work tree back to a checkpoint. Files created since are moved
 * to `.oraknid/trash/<time>/`, never deleted (Drift-Control → Rollback).
 */
export function rollback(
  g: Git,
  ref: string,
  tmpDir: string,
  trashRoot: string,
): { restored: string[]; trashed: string[] } {
  const now = snapshotTree(g, tmpDir);
  const lines = git(g, ["diff", "--name-status", "--no-renames", `${ref}^{tree}`, now])
    .split("\n")
    .filter(Boolean);
  const trash = join(trashRoot, new Date().toISOString().replace(/[:.]/g, "-"));
  const trashed: string[] = [];
  const restored: string[] = [];
  for (const line of lines) {
    const [status, path] = line.split("\t") as [string, string];
    if (status === "A") {
      const to = join(trash, path);
      mkdirSync(dirname(to), { recursive: true });
      renameSync(join(g.cwd, path), to);
      trashed.push(path);
    } else restored.push(path);
  }
  if (restored.length) {
    git(g, ["checkout", ref, "--", ...restored]);
    // Leave the index as HEAD had it: rollback is about files, not staging.
    if (ok(g, ["rev-parse", "--verify", "HEAD"])) git(g, ["reset", "-q", "--", ...restored]);
  }
  return { restored, trashed };
}

/** A task's verified work, as a commit on the job branch. */
export function commitAll(g: Git, message: string): string | null {
  git(g, ["add", "-A", "."]);
  if (ok(g, ["diff", "--cached", "--quiet"])) return null;
  git(g, ["commit", "-q", "--no-verify", "-m", message], authorEnv());
  return git(g, ["rev-parse", "HEAD"]).trim();
}

/**
 * Puts only some paths back to a checkpoint (D1: out-of-scope edits are
 * reverted, in-scope work stays). Files the checkpoint didn't have go to
 * the trash.
 */
export function restorePaths(g: Git, ref: string, paths: string[], trashRoot: string): void {
  if (paths.length === 0) return;
  const inCheckpoint = new Set(
    git(g, ["ls-tree", "-r", "--name-only", ref]).split("\n").filter(Boolean),
  );
  const trash = join(trashRoot, new Date().toISOString().replace(/[:.]/g, "-"));
  const restore: string[] = [];
  for (const p of paths) {
    if (inCheckpoint.has(p)) restore.push(p);
    else if (existsSync(join(g.cwd, p))) {
      const to = join(trash, p);
      mkdirSync(dirname(to), { recursive: true });
      renameSync(join(g.cwd, p), to);
    }
  }
  if (restore.length) {
    git(g, ["checkout", ref, "--", ...restore]);
    if (ok(g, ["rev-parse", "--verify", "HEAD"])) git(g, ["reset", "-q", "--", ...restore]);
  }
}
