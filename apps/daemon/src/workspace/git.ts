import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

// Git for The Eye (Sandboxing → Worktrees, Drift-Control → Checkpoints):
// worktrees per job, checkpoints on private refs, rollback, diffs.

export class GitError extends Error {}

export interface Git {
  /** The work tree commands run in. */
  cwd: string;
  /** Extra arguments for a shadow repo (`--git-dir … --work-tree …`). */
  base: string[];
}

/**
 * Settings no repo may change for Oraknid's own git calls (Audit 1 → S1-01):
 * a work tree is the Leg's, so nothing found in it may run a command on
 * the host (fsmonitor, hooks).
 */
const SAFE = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  // Objects and refs reach the disk like the database's commits do (Audit 1 → D1-09).
  "-c",
  "core.fsync=committed",
  "-c",
  "core.fsyncMethod=batch",
];

export function git(g: Git, args: string[], env: Record<string, string> = {}): string {
  const r = spawnSync("git", [...SAFE, ...g.base, ...args], {
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
  spawnSync("git", [...SAFE, ...g.base, ...args], { cwd: g.cwd, encoding: "utf8" }).status === 0;

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
  const lines = ["/.oraknid/*", "!/.oraknid/silk/", "/.oraknid/silk/*.tmp"];
  const missing = lines.filter((l) => !text.split("\n").includes(l));
  if (!missing.length) return;
  appendFileSync(
    file,
    `${text.endsWith("\n") || !text ? "" : "\n"}${text.includes("# Oraknid") ? "" : "# Oraknid\n"}${missing.join("\n")}\n`,
  );
  void g;
}

export const gitDirOf = (g: Git) => {
  const d = git(g, ["rev-parse", "--git-common-dir"]).trim();
  return d.startsWith("/") ? d : join(g.cwd, d);
};

let shadowRoot: string | null = null;

/** Where shadow repos live: Oraknid's data folder, out of every Leg's reach (Audit 1 → S1-01). */
export function setShadowRoot(dir: string) {
  shadowRoot = dir;
}

function shadowDirFor(path: string): string {
  const legacy = join(path, ".oraknid", "shadow.git");
  if (!shadowRoot) return legacy;
  const dir = join(
    shadowRoot,
    `${createHash("sha256").update(path).digest("hex").slice(0, 16)}.git`,
  );
  // One made before the move is carried over once; a Leg could have changed its config, so it is reset.
  if (!existsSync(dir) && existsSync(legacy)) {
    mkdirSync(shadowRoot, { recursive: true });
    renameSync(legacy, dir);
    rmSync(join(dir, "hooks"), { recursive: true, force: true });
    writeFileSync(join(dir, "config"), "[core]\n\trepositoryformatversion = 0\n\tbare = false\n");
  }
  return dir;
}

/**
 * The git handle of a job's worktree, from the main repo's own records and
 * never from the worktree's `.git` file, which the Leg can rewrite.
 */
export function worktreeGit(repoPath: string, worktree: string): Git {
  const admin = join(gitDirOf({ cwd: repoPath, base: [] }), "worktrees", basename(worktree));
  const recorded = existsSync(join(admin, "gitdir"))
    ? readFileSync(join(admin, "gitdir"), "utf8").trim()
    : "";
  if (recorded !== join(worktree, ".git"))
    throw new GitError(`${worktree} is not a worktree of ${repoPath}.`);
  return { cwd: worktree, base: ["--git-dir", admin, "--work-tree", worktree] };
}

/** A shadow repo for a folder that is not a git repo: checkpoints only, my folder untouched. */
export function shadowRepo(path: string): Git {
  const gitDir = shadowDirFor(path);
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
  // A folder a crash left behind, not registered as a worktree, is set aside and made again (Audit 1 → D1-10).
  if (existsSync(path)) {
    try {
      worktreeGit(repoPath, path);
    } catch {
      renameSync(path, `${path}.broken-${Date.now()}`);
      git(g, ["worktree", "prune"]);
    }
  }
  if (!existsSync(path)) {
    const branchExists = ok(g, ["rev-parse", "--verify", `refs/heads/${branch}`]);
    git(
      g,
      branchExists
        ? ["worktree", "add", "-q", path, branch]
        : ["worktree", "add", "-q", "-b", branch, path, branches.work],
    );
  }
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
    // A nested repo with no commit can't be added: it is left out, not a reason to fail (Audit 1 → D1-16).
    const skip: string[] = [];
    for (;;) {
      try {
        git(
          g,
          ["add", "-A", "--", ".", ":(exclude).oraknid", ...skip.map((p) => `:(exclude)${p}`)],
          env,
        );
        break;
      } catch (error) {
        const nested = /error: '([^']+)' does not have a commit checked out/.exec(
          String(error),
        )?.[1];
        if (!nested || skip.length >= 50 || skip.includes(nested)) throw error;
        skip.push(nested.replace(/\/$/, ""));
      }
    }
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

export const hasRef = (g: Git, ref: string) => ok(g, ["rev-parse", "--verify", "--quiet", ref]);

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

// ── A job's result (Jobs-and-Projects → Ending a job, Checkpoint 1 → F1-5) ──

export interface BranchCommit {
  sha: string;
  subject: string;
  at: number;
}

/** The commits on `branch` that `into` doesn't have yet, newest first. */
export function commitsAhead(repo: string, into: string, branch: string): BranchCommit[] {
  const g = { cwd: repo, base: [] };
  if (!ok(g, ["rev-parse", "--verify", `refs/heads/${branch}`])) return [];
  const range = ok(g, ["rev-parse", "--verify", `refs/heads/${into}`])
    ? `${into}..${branch}`
    : branch;
  return git(g, ["log", "--no-merges", "--format=%H%x1f%s%x1f%ct", range])
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [sha = "", subject = "", at = "0"] = l.split("\x1f");
      return { sha, subject, at: Number(at) * 1000 };
    });
}

export const isMerged = (repo: string, into: string, branch: string) =>
  ok({ cwd: repo, base: [] }, [
    "merge-base",
    "--is-ancestor",
    `refs/heads/${branch}`,
    `refs/heads/${into}`,
  ]);

/** Where a branch is checked out, if anywhere. */
function checkedOutAt(repo: string, branch: string): string | null {
  let path: string | null = null;
  for (const line of git({ cwd: repo, base: [] }, ["worktree", "list", "--porcelain"]).split(
    "\n",
  )) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line === `branch refs/heads/${branch}`) return path;
  }
  return null;
}

export type MergeResult =
  | { ok: true; commit: string }
  | { ok: false; reason: string; conflicts: string[] };

/**
 * Merges `branch` into `into` as a merge commit, computed without touching
 * any work tree (`git merge-tree`). When `into` is checked out somewhere,
 * that checkout moves forward only if it is clean; a conflict or a dirty
 * checkout merges nothing.
 */
export function mergeBranch(
  repo: string,
  into: string,
  branch: string,
  message: string,
): MergeResult {
  const g = { cwd: repo, base: [] };
  if (!ok(g, ["rev-parse", "--verify", `refs/heads/${into}`]))
    return { ok: false, reason: `There is no branch ${into}.`, conflicts: [] };
  if (isMerged(repo, into, branch))
    return { ok: false, reason: `${branch} is already in ${into}.`, conflicts: [] };
  const r = spawnSync(
    "git",
    ["merge-tree", "--write-tree", "--name-only", "--no-messages", into, branch],
    {
      cwd: repo,
      encoding: "utf8",
    },
  );
  if (r.status !== 0) {
    const [, ...files] = r.stdout.split("\n").filter(Boolean);
    return {
      ok: false,
      reason:
        r.status === 1
          ? "The branches conflict; nothing was merged."
          : (r.stderr || r.stdout).trim(),
      conflicts: files,
    };
  }
  const tree = r.stdout.split("\n")[0]?.trim() as string;
  const before = git(g, ["rev-parse", `refs/heads/${into}`]).trim();
  const commit = git(
    g,
    ["commit-tree", tree, "-p", before, "-p", `refs/heads/${branch}`, "-m", message],
    authorEnv(),
  ).trim();
  const at = checkedOutAt(repo, into);
  if (at) {
    const wt = { cwd: at, base: [] };
    if (git(wt, ["status", "--porcelain", "--untracked-files=no"]).trim())
      return {
        ok: false,
        reason: `${into} is checked out in ${at} with uncommitted changes; commit or stash them, then merge again.`,
        conflicts: [],
      };
    try {
      git(wt, ["merge", "--ff-only", "-q", commit]);
    } catch (error) {
      return {
        ok: false,
        reason: `${into} is checked out in ${at} and could not move forward: ${error instanceof Error ? error.message : String(error)}`,
        conflicts: [],
      };
    }
  } else git(g, ["update-ref", `refs/heads/${into}`, commit, before]);
  return { ok: true, commit };
}
