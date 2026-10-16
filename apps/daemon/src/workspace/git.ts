import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  BUILD_OUTPUT,
  type CommitCandidate,
  type FolderSummary,
  foldersOf,
  foldersOfPaths,
  ignoreTemplate,
  isOraknidPath,
  type LeftOutFile,
  missingIgnoreLines,
  NEVER_TRACKED,
  ORAKNID_DIR,
  ownEcosystems,
  planCommit,
  regenerated,
  trackedGenerated,
} from "@oraknid/core";
import { secretByPattern } from "@oraknid/guard";

// Git for The Eye (Sandboxing → Worktrees, Drift-Control → Checkpoints):
// worktrees per job, checkpoints on private refs, rollback, diffs.

export class GitError extends Error {}

export interface Git {
  /** The work tree commands run in. */
  cwd: string;
  /** Extra arguments for a shadow repo (`--git-dir … --work-tree …`). */
  base: string[];
  /**
   * Folders of the work tree that are another repo's (ADR-042: the
   * project's folder as one repo, with others inside it): never snapshotted
   * or committed here.
   */
  exclude?: string[];
}

const excluded = (g: Git) => (g.exclude ?? []).map((p) => `:(exclude)${p}`);

/**
 * The pathspec that keeps Oraknid's own folder out of a `git add`: none
 * where the folder is ignored whole (`.oraknid/` in the project's
 * .gitignore, ADR-072), since git refuses a pathspec naming an ignored
 * folder; else an exclusion.
 */
const notOraknid = (g: Git) =>
  ok(g, ["check-ignore", "-q", "--no-index", ".oraknid"]) ? [] : [":(exclude).oraknid"];

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

export function git(
  g: Git,
  args: string[],
  env: Record<string, string> = {},
  /** Given on stdin: a long list of paths goes here, never on the command line. */
  input?: string,
): string {
  const r = spawnSync("git", [...SAFE, ...g.base, ...args], {
    cwd: g.cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
    maxBuffer: 64 * 1024 * 1024,
    ...(input === undefined ? {} : { input }),
  });
  if (r.status !== 0 || r.error)
    throw new GitError(
      `${said(args)} failed: ${brief(r.stderr || r.stdout || r.error?.message || "")}`,
    );
  return r.stdout;
}

/** A git command as said in an error: its first words, never thousands of paths. */
function said(args: string[]): string {
  const words = args.slice(0, 6).join(" ");
  return `git ${words.length > 160 ? `${words.slice(0, 160)}…` : words}${args.length > 6 ? ` … (+${args.length - 6} more)` : ""}`;
}

/** Git's own words, the first lines, cut short. */
function brief(text: string): string {
  const t = text.trim();
  return t.length > 400 ? `${t.slice(0, 400)}…` : t;
}

/** Paths given to git through stdin (NUL-separated), for any number of them. */
function withPaths(g: Git, args: string[], paths: string[]): string {
  return git(
    g,
    [...args, "--pathspec-from-file=-", "--pathspec-file-nul"],
    {},
    `${paths.join("\0")}\0`,
  );
}

/**
 * The same, off the event loop: for the slow ones (a snapshot's `add -A`,
 * a commit's), so a huge work tree can't stall the daemon past its
 * watchdog (Phase 2 → M2.0, Audit 1 → D1-05).
 */
export async function gitAsync(
  g: Git,
  args: string[],
  env: Record<string, string> = {},
): Promise<string> {
  const r = await gitRun(g, args, env);
  if (r.code === 0) return r.stdout;
  throw new GitError(`${said(args)} failed: ${brief(r.stderr || r.stdout)}`);
}

/** A git command off the event loop, with all it said: for reading why it failed (ADR-067 §2). */
export function gitRun(
  g: Git,
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...SAFE, ...g.base, ...args], {
      cwd: g.cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({
        code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      }),
    );
  });
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
 * Oraknid's folder stays out of my repo, its Silk mirror too: Oraknid's
 * state is never part of a project's history (ADR-072 §1,
 * Jobs-and-Projects → Projects).
 */
export function excludeOraknid(g: Git, gitDir: string) {
  const file = join(gitDir, "info", "exclude");
  mkdirSync(dirname(file), { recursive: true });
  let text = existsSync(file) ? readFileSync(file, "utf8") : "";
  // Before ADR-072 the mirror was let in ("!/.oraknid/silk/"): that exception goes.
  const before = text.split("\n");
  const kept = before.filter((l) => l !== "!/.oraknid/silk/" && l !== "/.oraknid/silk/*.tmp");
  if (kept.length !== before.length) {
    text = kept.join("\n");
    writeFileSync(file, text);
  }
  // Installed dependencies and caches are never checkpointed or committed by Oraknid, even
  // before the project has a .gitignore (a scaffold's first `pnpm install`, 2026-10-08).
  const lines = [
    "/.oraknid/*",
    "node_modules/",
    ".pnpm-store/",
    "__pycache__/",
    ".venv/",
    ".tox/",
    ".gradle/",
  ];
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
  const admins = join(gitDirOf({ cwd: repoPath, base: [] }), "worktrees");
  const recordedAt = (admin: string) =>
    existsSync(join(admin, "gitdir")) ? readFileSync(join(admin, "gitdir"), "utf8").trim() : "";
  let admin = join(admins, basename(worktree));
  // Two jobs' worktrees of a repo in a project of several share a folder name
  // (`…/<job>/web`): git names their records web, web1…, so the one is looked for.
  if (recordedAt(admin) !== join(worktree, ".git"))
    admin =
      (existsSync(admins) ? readdirSync(admins) : [])
        .map((n) => join(admins, n))
        .find((a) => recordedAt(a) === join(worktree, ".git")) ?? admin;
  if (recordedAt(admin) !== join(worktree, ".git"))
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
      authorEnv(g),
    );
  }
  return g;
}

/** Commits as me when git knows me (the repository's settings, then mine), as Oraknid otherwise. */
function authorEnv(g: Git): Record<string, string> {
  const read = (key: string) =>
    spawnSync("git", [...g.base, "config", key], { cwd: g.cwd, encoding: "utf8" }).stdout?.trim() ??
    "";
  const name = read("user.name");
  const email = read("user.email");
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
  /** A branch to start from instead of the work branch (a follow-up job). */
  from?: string | null,
  /** Where the worktree goes: a repo's folder inside a job's folder (ADR-042). */
  at?: string,
) {
  const g = { cwd: repoPath, base: [] };
  if (!ok(g, ["rev-parse", "--verify", "HEAD"])) {
    git(g, ["commit", "-q", "--allow-empty", "-m", "chore: start the repository"], authorEnv(g));
  }
  excludeOraknid(g, gitDirOf(g));
  if (!ok(g, ["rev-parse", "--verify", `refs/heads/${branches.work}`])) {
    const from = ok(g, ["rev-parse", "--verify", `refs/heads/${branches.release}`])
      ? branches.release
      : "HEAD";
    git(g, ["branch", branches.work, from]);
  }
  const path = at ?? join(repoPath, ".oraknid", "worktrees", jobId);
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
        : [
            "worktree",
            "add",
            "-q",
            "-b",
            branch,
            path,
            from && ok(g, ["rev-parse", "--verify", `refs/heads/${from}`]) ? from : branches.work,
          ],
    );
  }
  return { path, branch };
}

/** A tree object of the work tree as it is now, untracked files included, without touching the index. */
async function snapshotTree(g: Git, tmpDir: string): Promise<string> {
  mkdirSync(tmpDir, { recursive: true });
  // Unique even for two snapshots in the same millisecond (tasks side by side).
  const index = join(
    tmpDir,
    `index-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`,
  );
  const env = { GIT_INDEX_FILE: index };
  try {
    if (ok(g, ["rev-parse", "--verify", "HEAD"])) await gitAsync(g, ["read-tree", "HEAD"], env);
    // Oraknid's own folder (Silk mirror, trash, worktrees) is never part of a checkpoint.
    // A nested repo with no commit can't be added: it is left out, not a reason to fail (Audit 1 → D1-16).
    const skip: string[] = [];
    for (;;) {
      try {
        await gitAsync(
          g,
          [
            "add",
            "-A",
            "--",
            ".",
            ...notOraknid(g),
            ...excluded(g),
            ...skip.map((p) => `:(exclude)${p}`),
          ],
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
    return (await gitAsync(g, ["write-tree"], env)).trim();
  } finally {
    rmSync(index, { force: true });
  }
}

/** Records the work tree on a private ref; my branch, HEAD and index are untouched. */
export async function checkpoint(
  g: Git,
  ref: string,
  message: string,
  tmpDir: string,
): Promise<string> {
  const tree = await snapshotTree(g, tmpDir);
  const parent = ok(g, ["rev-parse", "--verify", "HEAD"])
    ? ["-p", git(g, ["rev-parse", "HEAD"]).trim()]
    : [];
  const commit = git(g, ["commit-tree", tree, ...parent, "-m", message], authorEnv(g)).trim();
  git(g, ["update-ref", ref, commit]);
  return commit;
}

export const hasRef = (g: Git, ref: string) => ok(g, ["rev-parse", "--verify", "--quiet", ref]);

/** Paths that differ between a checkpoint and the work tree now. */
export async function changedSince(g: Git, ref: string, tmpDir: string): Promise<string[]> {
  const tree = await snapshotTree(g, tmpDir);
  return (await gitAsync(g, ["diff", "--name-only", `${ref}^{tree}`, tree]))
    .split("\n")
    .filter(Boolean);
}

export async function diffStatSince(g: Git, ref: string, tmpDir: string): Promise<string> {
  const tree = await snapshotTree(g, tmpDir);
  return briefStat(await gitAsync(g, ["diff", "--stat", `${ref}^{tree}`, tree]));
}

/** The file lines a diff stat keeps, at most (Silk's "Done" and handoffs). */
export const STAT_FILES_MAX = 60;

/**
 * A diff stat said briefly: its first file lines, how many more, and git's
 * summary line. A package store committed by a task once listed thousands
 * of files, and its Silk entry was 1.5 MB (2026-10-08).
 */
export function briefStat(stat: string, max = STAT_FILES_MAX): string {
  const lines = stat.replace(/\n+$/, "").split("\n");
  const summary = /^\s*\d+ files? changed/.test(lines.at(-1) ?? "") ? lines.pop() : undefined;
  if (lines.length <= max) return stat;
  const more = lines.length - max;
  return [
    ...lines.slice(0, max),
    ` … and ${more.toLocaleString("en-US")} more file${more === 1 ? "" : "s"}`,
    ...(summary ? [summary] : []),
  ].join("\n");
}

/** Paths shown under a repo's folder in the project (ADR-042), or as they are. */
const prefixed = (folder?: string) =>
  folder ? [`--src-prefix=a/${folder}/`, `--dst-prefix=b/${folder}/`] : [];

/** The patch from a checkpoint to the work tree now. */
export async function diffSince(
  g: Git,
  ref: string,
  tmpDir: string,
  folder?: string,
): Promise<string> {
  const tree = await snapshotTree(g, tmpDir);
  return gitAsync(g, [
    "diff",
    "--no-color",
    ...prefixed(folder),
    "--stat",
    "--patch",
    `${ref}^{tree}`,
    tree,
  ]);
}

/** One commit's patch. */
export function commitPatch(g: Git, commit: string, folder?: string): Promise<string> {
  return gitAsync(g, [
    "show",
    "--no-color",
    ...prefixed(folder),
    "--format=%s%n",
    "--stat",
    "--patch",
    commit,
  ]);
}

/**
 * Puts the work tree back to a checkpoint. Files created since are moved
 * to `.oraknid/trash/<time>/`, never deleted (Drift-Control → Rollback).
 */
export async function rollback(
  g: Git,
  ref: string,
  tmpDir: string,
  trashRoot: string,
): Promise<{ restored: string[]; trashed: string[] }> {
  const now = await snapshotTree(g, tmpDir);
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
    // Any number of paths, through stdin: a list on the command line overflowed it (2026-10-08).
    withPaths(g, ["checkout", ref], restored);
    // Leave the index as HEAD had it: rollback is about files, not staging.
    if (ok(g, ["rev-parse", "--verify", "HEAD"])) withPaths(g, ["reset", "-q"], restored);
  }
  return { restored, trashed };
}

/** A task's verified work, as a commit on the job branch. */
export async function commitAll(
  g: Git,
  message: string,
  o: StageOptions = {},
): Promise<string | null> {
  if (!(await stageAll(g, o)).staged) return null;
  return commitStaged(g, message);
}

/**
 * The repository steward's light model (ADR-067 §5): folder by folder,
 * what a commit the rules don't settle takes, and the ignore lines the
 * project's tools need; never blocks.
 */
export type CommitJudge = (i: {
  why: string;
  folders: FolderSummary[];
  ignoreFile: string;
}) => Promise<{
  folders: { folder: string; include: boolean; reason: string }[];
  ignore?: string[];
}>;

/** What the steward decided for a project before: by folder, and its ignore lines. */
export interface StewardMemory {
  folders: Record<string, { include: boolean; reason: string }>;
  ignore: string[];
}

/** An ignore line a model may add: a plain pattern, never a negation or one that ignores everything. */
const okIgnoreLine = (l: string) =>
  !!l &&
  l.length < 120 &&
  !l.startsWith("!") &&
  !l.startsWith("#") &&
  !/^[/*.]*$/.test(l) &&
  !/\s/.test(l);

export interface StageOptions {
  /** The task's scope: a new top-level folder outside it makes the commit unusual. */
  scope?: string[];
  /** The steward's light model; without one the rules stand. */
  judge?: CommitJudge;
  /** What the steward decided for this project before: the same folder isn't asked twice. */
  memory?: StewardMemory;
  /** Keeps what the steward decided now. */
  remember?: (m: StewardMemory) => void;
  /**
   * Whether the repository is the project's own (not a shadow repo of a
   * folder that isn't one): only then is its ignore file written or extended.
   */
  ignoreFile?: boolean;
}

export interface StageResult {
  /** Whether there is anything to commit. */
  staged: boolean;
  /** What stayed out and why; still on disk. */
  left: LeftOutFile[];
  /** What was done to the repository's ignore file, in words; null when nothing. */
  ignore: string | null;
  /** Why the commit was judged, and what the judge left out; null when it wasn't. */
  judged: string | null;
}

/** Larger than this, a new file's content isn't read for secrets (its size leaves it out anyway). */
const SECRET_SCAN_BYTES = 512 * 1024;

/**
 * The generated folders there are now, two levels deep, as ignore lines
 * (`node_modules/`); build output the repository tracks on purpose is not one.
 */
function generatedFoldersPresent(g: Git, ecosystems: string[], tracked: Set<string>): string[] {
  const names = new Set<string>();
  for (const id of ecosystems) {
    for (const n of NEVER_TRACKED[id] ?? []) names.add(n);
    for (const n of BUILD_OUTPUT[id] ?? []) names.add(n);
  }
  names.add("node_modules/");
  const skip = new Set([".git", ".oraknid", ...(g.exclude ?? [])]);
  const out = new Set<string>();
  const look = (dir: string, depth: number) => {
    let list: string[] = [];
    try {
      list = readdirSync(join(g.cwd, dir));
    } catch {
      return;
    }
    for (const n of list) {
      const rel = dir ? `${dir}/${n}` : n;
      if (skip.has(rel)) continue;
      let isDir = false;
      try {
        isDir = lstatSync(join(g.cwd, rel)).isDirectory();
      } catch {}
      if (!isDir) continue;
      if (names.has(`${n}/`)) {
        if (NEVER.has(`${n}/`) || !tracked.has(rel)) out.add(`${n}/`);
      } else if (depth < 2) look(rel, depth + 1);
    }
  };
  look("", 1);
  return [...out];
}

/**
 * The repository's ignore file, made or extended (ADR-067 §6): a project
 * with none gets one for its ecosystems; one that misses generated
 * folders there are, or that a commit left out, gets their lines added,
 * never anything taken away. Returns what was done, in words.
 */
export function ensureIgnoreFile(g: Git, extra: string[] = []): string | null {
  const file = join(g.cwd, ".gitignore");
  const tracked = git(g, ["ls-files", "-z"]).split("\0").filter(Boolean);
  const ecosystems = ownEcosystems([...tracked, ...readdirSafe(g.cwd)]);
  const present = [...generatedFoldersPresent(g, ecosystems, foldersOfPaths(tracked)), ...extra];
  if (!existsSync(file)) {
    // Build output the repository tracks on purpose stays out of the template.
    const trackedNames = new Set(
      [...foldersOfPaths(tracked)].map((f) => f.split("/").pop() as string),
    );
    const text = ignoreTemplate(ecosystems)
      .split("\n")
      .filter((l) => !(l.endsWith("/") && !NEVER.has(l) && trackedNames.has(l.slice(0, -1))))
      .join("\n");
    const more = missingIgnoreLines(text, present);
    writeFileSync(file, more.length ? `${text}${more.join("\n")}\n` : text);
    return "wrote a .gitignore for the project's tools, which it had none of";
  }
  const text = readFileSync(file, "utf8");
  const missing = missingIgnoreLines(text, present);
  if (!missing.length) return null;
  // What Oraknid writes there keeps its own state out too (ADR-072 §1).
  const own = missingIgnoreLines(text, [`${ORAKNID_DIR}/`]).filter((l) => !missing.includes(l));
  appendFileSync(
    file,
    `${text.endsWith("\n") || !text ? "" : "\n"}# Added by Oraknid: made by the project's tools\n${missing.join("\n")}\n${own.length ? `# Added by Oraknid: its own state, never tracked\n${own.join("\n")}\n` : ""}`,
  );
  return `added ${missing.map((m) => `\`${m}\``).join(", ")} to .gitignore`;
}

const NEVER = new Set(Object.values(NEVER_TRACKED).flat());

const readdirSafe = (dir: string) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

/**
 * Stages what belongs in a commit (ADR-067 §5): everything that changed,
 * then what a tool made by itself, build artifacts, files too large and
 * secrets taken out again, each recorded with why; an unusual commit
 * judged by folder. What stays out stays on disk, and stays out of the
 * next commit too (the ignore file for what a tool makes, the
 * repository's own exclude file for the rest).
 */
export async function stageAll(g: Git, o: StageOptions = {}): Promise<StageResult> {
  const ignore = o.ignoreFile ? ensureIgnoreFile(g) : null;
  await gitAsync(g, ["add", "-A", "--", ".", ...excluded(g)]);
  // Oraknid's own folder is never staged, even where a branch still tracks it (ADR-072 §1): its
  // untracking is a commit of its own, at the job's start.
  if (hasHead(g) && git(g, ["ls-files", "--", ORAKNID_DIR]).trim())
    git(g, ["reset", "-q", "HEAD", "--", ORAKNID_DIR]);
  const status = git(g, ["diff", "--cached", "--name-status", "-z", "--no-renames"]).split("\0");
  const files: CommitCandidate[] = [];
  for (let i = 0; i + 1 < status.length; i += 2) {
    const code = status[i] as string;
    const path = status[i + 1] as string;
    if (!path) continue;
    let size = 0;
    if (code !== "D")
      try {
        size = lstatSync(join(g.cwd, path)).size;
      } catch {}
    files.push({ path, size, tracked: code !== "A" });
  }
  const fresh0 = new Set(files.filter((f) => !f.tracked).map((f) => f.path));
  const tracked = git(g, ["ls-files", "-z"])
    .split("\0")
    .filter((p) => p && !fresh0.has(p));
  const ecosystems = ownEcosystems([...tracked, ...fresh0]);
  const existingTop = hasHead(g)
    ? git(g, ["ls-tree", "--name-only", "HEAD"]).split("\n").filter(Boolean)
    : [];
  const secret = (path: string) => {
    try {
      const p = join(g.cwd, path);
      if (lstatSync(p).size > SECRET_SCAN_BYTES) return null;
      const text = readFileSync(p, "utf8");
      if (text.includes("\0")) return null;
      return secretByPattern(text)?.what ?? null;
    } catch {
      return null;
    }
  };
  const plan = planCommit(files, {
    ecosystems,
    ...(o.scope ? { scope: o.scope } : {}),
    existingTop,
    secret,
    trackedFolders: foldersOfPaths(tracked),
    knownExtensions: new Set(
      tracked.map((p) => /\.[^./]+$/.exec(p)?.[0]?.toLowerCase()).filter((e): e is string => !!e),
    ),
    binary: (path) => {
      try {
        const p = join(g.cwd, path);
        if (lstatSync(p).size > SECRET_SCAN_BYTES) return true;
        return readFileSync(p).subarray(0, 8000).includes(0);
      } catch {
        return false;
      }
    },
  });
  const left: LeftOutFile[] = [...plan.leave];
  let judged: string | null = null;
  // What the rules don't settle, the steward settles (ADR-067 §5): a light model, once per
  // folder per project; its decisions and ignore lines are remembered.
  const learnedIgnore: string[] = [];
  if (plan.review && o.judge) {
    const keep = new Set(plan.keep);
    const fresh = files.filter((f) => !f.tracked && keep.has(f.path));
    const folders = foldersOf(fresh);
    const memory = o.memory ?? { folders: {}, ignore: [] };
    const known = folders.every((f) => memory.folders[f.folder]);
    let verdicts: { folder: string; include: boolean; reason: string }[] = [];
    try {
      if (known) {
        verdicts = folders.map((f) => ({
          folder: f.folder,
          ...(memory.folders[f.folder] as { include: boolean; reason: string }),
        }));
      } else {
        const answer = await o.judge({
          why: plan.review,
          folders,
          ignoreFile: existsSync(join(g.cwd, ".gitignore"))
            ? readFileSync(join(g.cwd, ".gitignore"), "utf8")
            : "",
        });
        verdicts = answer.folders;
        learnedIgnore.push(...(answer.ignore ?? []).map((l) => l.trim()).filter(okIgnoreLine));
        const next = {
          folders: { ...memory.folders },
          ignore: [...new Set([...memory.ignore, ...learnedIgnore])],
        };
        for (const v of verdicts) next.folders[v.folder] = { include: v.include, reason: v.reason };
        o.remember?.(next);
      }
      const out = verdicts.filter((v) => !v.include);
      for (const v of out) {
        const prefix = v.folder === "." ? "" : v.folder.replace(/\/?$/, "/");
        for (const f of fresh)
          if (prefix ? f.path.startsWith(prefix) : !f.path.includes("/"))
            left.push({
              path: f.path,
              why: "judged",
              detail: v.reason || "left out by the repository steward",
            });
      }
      judged = `${plan.review}${known ? " (decided before)" : ""}${out.length ? `; left out ${out.map((v) => `\`${v.folder}\` (${v.reason})`).join(", ")}` : "; all of it belongs"}${learnedIgnore.length ? `; to ignore: ${learnedIgnore.map((l) => `\`${l}\``).join(", ")}` : ""}`;
    } catch (error) {
      judged = `${plan.review}; the steward couldn't answer (${error instanceof Error ? error.message : String(error)}), so the rules stood`;
    }
  }
  // Ignore lines the steward wrote for this project (a kind the conventions don't know).
  if (learnedIgnore.length && o.ignoreFile) {
    const extended = ensureIgnoreFile(g, learnedIgnore);
    if (extended) {
      await gitAsync(g, ["add", "--", ".gitignore"]);
      // Files those lines now ignore leave the commit.
      const ignored = git(g, ["ls-files", "-z", "-ci", "--exclude-standard"])
        .split("\0")
        .filter((p) => p && fresh0.has(p) && !left.some((l) => l.path === p));
      for (const p of ignored)
        left.push({ path: p, why: "generated", detail: "ignored by the steward's lines" });
      if (!ignored.length && !left.length)
        return {
          staged: !ok(g, ["diff", "--cached", "--quiet"]),
          left,
          ignore: ignore ?? extended,
          judged,
        };
    }
  }
  if (left.length) {
    // Taken out of the index only: the files stay as they are.
    await gitRunWithPaths(
      g,
      ["rm", "--cached", "-q", "--ignore-unmatch"],
      left.map((l) => l.path),
    );
    const lines = [...new Set(left.flatMap((l) => (l.ignore ? [l.ignore] : [])))];
    let ignoreSaid = ignore;
    if (lines.length && o.ignoreFile) {
      const extended = ensureIgnoreFile(g, lines);
      if (extended) ignoreSaid = ignoreSaid ?? extended;
      await gitAsync(g, ["add", "--", ".gitignore"]);
    }
    // The rest stays out of later commits through the repository's own exclude file.
    // (Oraknid's own folder is excluded there already, whole.)
    const rest = left
      .filter((l) => (!l.ignore || !o.ignoreFile) && l.why !== "oraknid")
      .map((l) => `/${l.path}`);
    if (rest.length) {
      const file = join(gitDirOf(g), "info", "exclude");
      mkdirSync(dirname(file), { recursive: true });
      const text = existsSync(file) ? readFileSync(file, "utf8") : "";
      const have = new Set(text.split("\n"));
      const add = rest.filter((r) => !have.has(r));
      if (add.length)
        appendFileSync(
          file,
          `${text.endsWith("\n") || !text ? "" : "\n"}# Left out of a commit by Oraknid\n${add.join("\n")}\n`,
        );
    }
    return {
      staged: !ok(g, ["diff", "--cached", "--quiet"]),
      left,
      ignore: ignoreSaid,
      judged,
    };
  }
  return { staged: !ok(g, ["diff", "--cached", "--quiet"]), left, ignore, judged };
}

const hasHead = (g: Git) => ok(g, ["rev-parse", "--verify", "-q", "HEAD"]);

/** Paths given through stdin, literally (no globs), off the event loop. */
async function gitRunWithPaths(g: Git, args: string[], paths: string[]) {
  return new Promise<void>((resolveP, reject) => {
    const child = spawn(
      "git",
      [...SAFE, ...g.base, ...args, "--pathspec-from-file=-", "--pathspec-file-nul"],
      {
        cwd: g.cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_LITERAL_PATHSPECS: "1" },
        stdio: ["pipe", "ignore", "pipe"],
      },
    );
    const err: Buffer[] = [];
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolveP()
        : reject(
            new GitError(`${said(args)} failed: ${brief(Buffer.concat(err).toString("utf8"))}`),
          ),
    );
    child.stdin.end(`${paths.join("\0")}\0`);
  });
}

/** A short account of what a commit left out, for the task's report and Silk. */
export function leftOutSaid(left: LeftOutFile[], max = 8): string {
  if (!left.length) return "";
  const by = new Map<string, LeftOutFile[]>();
  for (const l of left) by.set(l.why, [...(by.get(l.why) ?? []), l]);
  const WORDS: Record<string, string> = {
    generated: "made by the project's tools",
    "too-large": "too large",
    artifact: "build artifacts or archives",
    secret: "secrets",
    judged: "judged not to belong",
    oraknid: "Oraknid's own state",
  };
  return [...by.entries()]
    .map(([why, list]) => {
      const shown = list
        .slice(0, max)
        .map(
          (l) =>
            `\`${l.path}\`${why === "too-large" || why === "secret" || why === "judged" ? ` (${l.detail})` : ""}`,
        )
        .join(", ");
      return `${list.length} ${WORDS[why] ?? why}: ${shown}${list.length > max ? `, and ${list.length - max} more` : ""}`;
    })
    .join("; ");
}

/** Commits what is staged. */
export async function commitStaged(g: Git, message: string): Promise<string> {
  await gitAsync(g, ["commit", "-q", "--no-verify", "-m", message], authorEnv(g));
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
    withPaths(g, ["checkout", ref], restore);
    if (ok(g, ["rev-parse", "--verify", "HEAD"])) withPaths(g, ["reset", "-q"], restore);
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

/** The files `branch` and `into` conflict on, computed without touching anything; none: it merges. */
export function mergeConflicts(repo: string, into: string, branch: string): string[] {
  const r = spawnSync(
    "git",
    ["merge-tree", "--write-tree", "--name-only", "--no-messages", into, branch],
    { cwd: repo, encoding: "utf8" },
  );
  if (r.status === 0) return [];
  const [, ...files] = r.stdout.split("\n").filter(Boolean);
  return files.length ? files : [(r.stderr || "the merge can't be computed").trim()];
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
    authorEnv(g),
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

// ── Tasks side by side (ADR-016) ────────────────────────────────────

/**
 * A worktree of its own for a task running beside others, on a branch from
 * the job branch's tip. Made again from the tip if a crash left it half made.
 */
export function createTaskWorktree(
  repoPath: string,
  jobId: string,
  taskId: string,
  jobBranch: string,
): { path: string; branch: string } {
  const g = { cwd: repoPath, base: [] };
  const path = join(
    repoPath,
    ".oraknid",
    "worktrees",
    `${jobId}-t-${taskId.slice(-6).toLowerCase()}`,
  );
  const branch = `${jobBranch}--t-${taskId.slice(-6).toLowerCase()}`;
  if (existsSync(path)) {
    try {
      worktreeGit(repoPath, path);
      return { path, branch };
    } catch {
      renameSync(path, `${path}.broken-${Date.now()}`);
      git(g, ["worktree", "prune"]);
    }
  }
  addTaskWorktree(repoPath, path, branch, jobBranch);
  // A fresh tree from the job's newer tip: the task's scope is measured from here, not from an
  // earlier attempt's tree (that made other tasks' merged files look like its own edits).
  const base = `refs/oraknid/${jobId}/${taskId}/base`;
  if (ok(g, ["rev-parse", "--verify", "--quiet", base])) git(g, ["update-ref", "-d", base]);
  return { path, branch };
}

/** A task's worktree at `path` on a new `branch` from `from` (a stale branch of that name goes first). */
export function addTaskWorktree(repoPath: string, path: string, branch: string, from: string) {
  const g = { cwd: repoPath, base: [] };
  if (ok(g, ["rev-parse", "--verify", `refs/heads/${branch}`])) git(g, ["branch", "-D", branch]);
  git(g, ["worktree", "add", "-q", "-b", branch, path, from]);
}

/** Removes a task's worktree and branch once its work is merged, or to start it again. */
export function removeTaskWorktree(repoPath: string, path: string, branch: string) {
  const g = { cwd: repoPath, base: [] };
  if (existsSync(path)) {
    try {
      git(g, ["worktree", "remove", "--force", path]);
    } catch {
      rmSync(path, { recursive: true, force: true });
      git(g, ["worktree", "prune"]);
    }
  }
  if (branch && ok(g, ["rev-parse", "--verify", `refs/heads/${branch}`]))
    git(g, ["branch", "-D", branch]);
}

/**
 * Merges a task's branch into the job worktree (Oraknid's own checkout of
 * the job branch). A conflict merges nothing and names the files.
 */
export async function mergeTaskBranch(
  jobG: Git,
  branch: string,
  message: string,
  /** Where files git won't overwrite, made by the project's tools, are moved to. */
  trash?: string,
  /** Generated files out of the way first (ADR-067 §2); off only to test the steward without it. */
  clean = true,
): Promise<{ ok: true; commit: string; cleared: string[] } | ({ ok: false } & MergeFailure)> {
  // Oraknid's own checkout: what the project's tools rewrote there (a check's cache, a lockfile
  // a check's install touched) is never work, and never stops a merge (ADR-067 §2).
  const cleared = clean ? discardGenerated(jobG) : [];
  for (let tries = 0; ; tries++) {
    const r = await gitRun(
      jobG,
      ["merge", "--no-ff", "--no-edit", "-m", message, branch],
      authorEnv(jobG),
    );
    if (r.code === 0) return { ok: true, commit: git(jobG, ["rev-parse", "HEAD"]).trim(), cleared };
    const unmerged = mergingNow(jobG)
      ? git(jobG, ["diff", "--name-only", "--diff-filter=U"]).split("\n").filter(Boolean)
      : [];
    // Two tasks that each added to .gitignore: both sides' lines, kept (ADR-067 §6).
    if (unmerged.length && unmerged.every((f) => f === ".gitignore" || f.endsWith("/.gitignore"))) {
      try {
        for (const f of unmerged) unionIgnore(jobG, f);
        await gitAsync(jobG, ["commit", "-q", "--no-verify", "--no-edit"], authorEnv(jobG));
        return { ok: true, commit: git(jobG, ["rev-parse", "HEAD"]).trim(), cleared };
      } catch {}
    }
    const failure = readMergeFailure(`${r.stderr}\n${r.stdout}`, unmerged);
    if (mergingNow(jobG))
      try {
        git(jobG, ["merge", "--abort"]);
      } catch {}
    // Files git won't overwrite that the project's tools make again: out of the way, once.
    if (
      clean &&
      tries === 0 &&
      (failure.kind === "local-changes" || failure.kind === "untracked") &&
      failure.files.length &&
      failure.files.every((f) => regenerated(f))
    ) {
      if (failure.kind === "local-changes") restoreFromHead(jobG, failure.files);
      else moveAside(jobG, failure.files, trash ?? join(jobG.cwd, ".oraknid", "trash"));
      cleared.push(...failure.files);
      continue;
    }
    return { ok: false, ...failure };
  }
}

const mergingNow = (g: Git) => ok(g, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);

/** Both sides' lines of a conflicted ignore file, each once, in order. */
function unionIgnore(g: Git, file: string) {
  const side = (n: number) => {
    try {
      return git(g, ["show", `:${n}:${file}`]).split("\n");
    } catch {
      return [];
    }
  };
  const lines: string[] = [];
  for (const l of [...side(2), ...side(3)])
    if (l.trim() === "" || !lines.includes(l)) lines.push(l);
  writeFileSync(join(g.cwd, file), `${lines.join("\n").replace(/\n+$/, "")}\n`);
  git(g, ["add", "--", file]);
}

/** Why a merge failed, as git said it (ADR-067 §2): never "conflicted ()". */
export interface MergeFailure {
  kind:
    | "conflict"
    | "local-changes"
    | "untracked"
    | "locked"
    | "unfinished"
    | "not-a-branch"
    | "other";
  /** The files it names: the conflicted ones, or those git won't overwrite. */
  files: string[];
  /** Git's own words, short. */
  git: string;
}

/** Reads git's words on a failed merge. `unmerged`: the files the merge left conflicted. */
export function readMergeFailure(text: string, unmerged: string[] = []): MergeFailure {
  const said = brief(text.replace(/\n{2,}/g, "\n"));
  const listAfter = (head: RegExp): string[] => {
    const lines = text.split("\n");
    const i = lines.findIndex((l) => head.test(l));
    if (i < 0) return [];
    const out: string[] = [];
    for (const l of lines.slice(i + 1)) {
      if (!/^\s/.test(l) || !l.trim()) break;
      out.push(l.trim());
    }
    return out;
  };
  if (/would be overwritten by merge|Your local changes to the following files/.test(text)) {
    if (/untracked working tree files would be/.test(text))
      return {
        kind: "untracked",
        files: listAfter(/untracked working tree files would be/),
        git: said,
      };
    return {
      kind: "local-changes",
      files: listAfter(/Your local changes to the following files/),
      git: said,
    };
  }
  if (/untracked working tree files would be (overwritten|removed)/.test(text))
    return {
      kind: "untracked",
      files: listAfter(/untracked working tree files would be/),
      git: said,
    };
  if (/index\.lock'?: File exists|Another git process seems to be running/.test(text))
    return { kind: "locked", files: [], git: said };
  if (
    /You have not concluded your merge|MERGE_HEAD exists|unmerged files|you need to resolve your current index first/i.test(
      text,
    )
  )
    return { kind: "unfinished", files: unmerged, git: said };
  if (/not something we can merge|unknown revision/.test(text))
    return { kind: "not-a-branch", files: [], git: said };
  if (unmerged.length || /CONFLICT/.test(text)) {
    const files = unmerged.length
      ? unmerged
      : [...text.matchAll(/CONFLICT \([^)]*\): (?:Merge conflict in )?(\S+)/g)].map(
          (m) => m[1] as string,
        );
    return { kind: "conflict", files, git: said };
  }
  return { kind: "other", files: [], git: said };
}

/** A merge failure in plain words, for the task's record and the owner. */
export function mergeFailureSaid(f: MergeFailure, max = 6): string {
  const list = (xs: string[]) =>
    `${xs
      .slice(0, max)
      .map((x) => `\`${x}\``)
      .join(", ")}${xs.length > max ? ` and ${xs.length - max} more` : ""}`;
  switch (f.kind) {
    case "conflict":
      return f.files.length
        ? `it conflicted with work merged meanwhile (${list(f.files)})`
        : `it conflicted with work merged meanwhile (git said: ${f.git})`;
    case "local-changes":
      return `the job's folder had uncommitted changes git won't overwrite${f.files.length ? ` (${list(f.files)})` : ""}, so git refused to merge; nothing conflicted`;
    case "untracked":
      return `files in the job's folder that git doesn't track would be overwritten${f.files.length ? ` (${list(f.files)})` : ""}, so git refused to merge; nothing conflicted`;
    case "locked":
      return "another git command held the repository's lock (an index.lock file), so the merge couldn't start";
    case "unfinished":
      return "an earlier merge in the job's folder was never finished, so git refused to start another";
    case "not-a-branch":
      return `the task's branch wasn't there to merge (git said: ${f.git})`;
    default:
      return `git refused to merge: ${f.git}`;
  }
}

/** Whether a merge failure is about the work's content (a redo on top can fix it) or the folder. */
export const isContentFailure = (f: Pick<MergeFailure, "kind">) => f.kind === "conflict";

/**
 * Discards what the project's tools changed in a checkout that is
 * Oraknid's own (ADR-067 §2): tracked files they rewrote or deleted go
 * back to the commit; nothing else is touched. Returns those files.
 */
export function discardGenerated(g: Git): string[] {
  let out = "";
  try {
    out = git(g, ["status", "--porcelain=v1", "-z", "--untracked-files=no"]);
  } catch {
    return [];
  }
  const paths: string[] = [];
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i] as string;
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const path = entry.slice(3);
    // A rename carries its old name next.
    if (xy.includes("R") || xy.includes("C")) i++;
    if (xy.includes("U") || xy.includes("A")) continue;
    if (regenerated(path)) paths.push(path);
  }
  if (paths.length) restoreFromHead(g, paths);
  return paths;
}

/** Tracked files put back as the commit has them, index and work tree. */
function restoreFromHead(g: Git, paths: string[]) {
  if (!paths.length) return;
  withPaths(g, ["checkout", "-q", "HEAD"], paths);
}

/** Files moved to `trash`, their folders kept, never deleted. */
function moveAside(g: Git, paths: string[], trash: string) {
  const to = join(trash, new Date().toISOString().replace(/[:.]/g, "-"));
  for (const p of paths) {
    const from = join(g.cwd, p);
    if (!existsSync(from)) continue;
    mkdirSync(dirname(join(to, p)), { recursive: true });
    renameSync(from, join(to, p));
  }
}

/**
 * Generated folders a repository tracks (ADR-067 §1), untracked on the
 * branch checked out at `g`: `git rm -r --cached` (every file stays on
 * disk), their lines added to .gitignore, and one commit, "chore: stop
 * tracking generated files". Null when there was nothing to do.
 */
export async function untrackGenerated(
  g: Git,
): Promise<{ folders: { folder: string; files: number }[]; commit: string } | null> {
  if (!hasHead(g)) return null;
  const tracked = git(g, ["ls-files", "-z"]).split("\0").filter(Boolean);
  const ignoreFile = tracked.includes(".gitignore") || existsSync(join(g.cwd, ".gitignore"));
  const found = trackedGenerated(tracked, { ignoreFile }).filter(
    (f) => !(g.exclude ?? []).some((x) => f.folder === x || f.folder.startsWith(`${x}/`)),
  );
  if (!found.length) return null;
  // Only these paths change in the index; the commit takes what is staged (nothing else is in
  // Oraknid's own checkout).
  await gitRunWithPaths(
    g,
    ["rm", "-r", "-q", "--cached", "--ignore-unmatch"],
    found.map((f) => f.folder),
  );
  const file = join(g.cwd, ".gitignore");
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const missing = missingIgnoreLines(text, [...new Set(found.map((f) => f.pattern))]);
  if (missing.length)
    writeFileSync(
      file,
      `${text}${text && !text.endsWith("\n") ? "\n" : ""}# Added by Oraknid: made by the project's tools, never tracked\n${missing.join("\n")}\n`,
    );
  git(g, ["add", "--", ".gitignore"]);
  await gitAsync(
    g,
    [
      "commit",
      "-q",
      "--no-verify",
      "-m",
      "chore: stop tracking generated files",
      "-m",
      `Untracked (the files stay on disk): ${found.map((f) => `${f.folder}/ (${f.files} files)`).join(", ")}.`,
    ],
    authorEnv(g),
  );
  return {
    folders: found.map((f) => ({ folder: f.folder, files: f.files })),
    commit: git(g, ["rev-parse", "HEAD"]).trim(),
  };
}

/**
 * Oraknid's own folder, untracked on the branch checked out at `g` where
 * a branch tracks it (ADR-072 §1): `git rm -r --cached` (every file stays
 * on disk, Legs still read the mirror there), `.oraknid/` added to
 * .gitignore and to the repository's exclude file, and one commit,
 * "chore: stop tracking Oraknid's own files". Null when there was nothing
 * to do.
 */
export async function untrackOraknid(g: Git): Promise<{ files: number; commit: string } | null> {
  excludeOraknid(g, gitDirOf(g));
  if (!hasHead(g)) return null;
  const tracked = git(g, ["ls-files", "-z"])
    .split("\0")
    .filter((p) => p && isOraknidPath(p));
  if (!tracked.length) return null;
  const folders = [
    ...new Set(
      tracked.map((p) => {
        const segs = p.split("/");
        return segs.slice(0, segs.indexOf(ORAKNID_DIR) + 1).join("/");
      }),
    ),
  ];
  // Only these paths change in the index; what Oraknid wrote there stays on disk as it is.
  await gitRunWithPaths(g, ["rm", "-r", "-q", "-f", "--cached", "--ignore-unmatch"], folders);
  const file = join(g.cwd, ".gitignore");
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const missing = missingIgnoreLines(text, [`${ORAKNID_DIR}/`]);
  if (missing.length)
    writeFileSync(
      file,
      `${text}${text && !text.endsWith("\n") ? "\n" : ""}# Added by Oraknid: its own state (the Silk mirror, trash, worktrees), never tracked\n${missing.join("\n")}\n`,
    );
  git(g, ["add", "--", ".gitignore"]);
  await gitAsync(
    g,
    [
      "commit",
      "-q",
      "--no-verify",
      "-m",
      "chore: stop tracking Oraknid's own files",
      "-m",
      `Untracked (the files stay on disk): ${folders.map((f) => `${f}/`).join(", ")} (${tracked.length} files), Oraknid's own state, which is never part of the project's history.`,
    ],
    authorEnv(g),
  );
  return { files: tracked.length, commit: git(g, ["rev-parse", "HEAD"]).trim() };
}

/** Takes back the merge just made (its checks failed on the merged tree). */
export function undoMerge(jobG: Git) {
  git(jobG, ["reset", "-q", "--hard", "HEAD^1"]);
}

/** A folder's own idea of its `.git`, read without asking git (which would walk up to a parent). */
function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The record (`<common>/worktrees/<name>`) of the worktree at `folder`, if git still has one. */
function worktreeRecord(repoPath: string, folder: string): string | null {
  const admins = join(gitDirOf({ cwd: repoPath, base: [] }), "worktrees");
  if (!existsSync(admins)) return null;
  const want = new Set([join(folder, ".git"), join(realOrSelf(folder), ".git")]);
  for (const name of readdirSync(admins)) {
    const file = join(admins, name, "gitdir");
    if (!existsSync(file)) continue;
    if (want.has(readFileSync(file, "utf8").trim())) return join(admins, name);
  }
  return null;
}

/**
 * Whether a job's folder is still a worktree of its project (Jobs-and-Projects
 * → Ending a job, after the piano job, 2026-10-03): its `.git` is a file that
 * points to a record in the project's repository, and that record points
 * back. Null when it is; otherwise what went wrong, in plain words.
 */
export function worktreeProblem(repoPath: string, folder: string): string | null {
  const dotgit = join(folder, ".git");
  let isDir = false;
  try {
    isDir = statSync(dotgit).isDirectory();
  } catch {
    return "its .git was removed, so it no longer belongs to the project's repository";
  }
  if (isDir) return "it was turned into a separate git repository (a .git folder of its own)";
  const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotgit, "utf8"));
  if (!m) return "its .git file was changed";
  const admin = realOrSelf(resolve(folder, (m[1] as string).trim()));
  const common = realOrSelf(gitDirOf({ cwd: repoPath, base: [] }));
  if (dirname(admin) !== join(common, "worktrees")) return "its .git points to another repository";
  const back = existsSync(join(admin, "gitdir"))
    ? realOrSelf(dirname(readFileSync(join(admin, "gitdir"), "utf8").trim()))
    : "";
  if (back !== realOrSelf(folder))
    return "the project's repository no longer knows it as a worktree";
  return null;
}

/**
 * Puts a job's folder back as a worktree of the project on `branch`,
 * keeping its files as they are: whatever stands in for its `.git` is moved
 * to `trash`, the worktree's link is written again (its record made again
 * when git lost it), and the index is set to the branch's tip, so the
 * files' content shows as changes on the job branch. Returns where the
 * replaced `.git` went, if anything was there.
 */
export function restoreWorktree(
  repoPath: string,
  folder: string,
  branch: string,
  trash: string,
): string | null {
  const dotgit = join(folder, ".git");
  let kept: string | null = null;
  if (existsSync(dotgit)) {
    mkdirSync(trash, { recursive: true });
    kept = join(trash, `${basename(folder)}.git-${Date.now()}`);
    renameSync(dotgit, kept);
  }
  let admin = worktreeRecord(repoPath, folder);
  if (admin) {
    writeFileSync(dotgit, `gitdir: ${admin}\n`);
  } else {
    // Git lost the record (pruned, or deleted with the .git): a new one, made beside the folder
    // without a checkout, then moved in, so no file of the folder is touched.
    const g = { cwd: repoPath, base: [] };
    const beside = `${folder}.restoring-${Date.now()}`;
    git(g, ["worktree", "add", "-q", "-f", "--no-checkout", beside, branch]);
    admin = /^gitdir:\s*(.+)$/m.exec(readFileSync(join(beside, ".git"), "utf8"))?.[1]?.trim() ?? "";
    renameSync(join(beside, ".git"), dotgit);
    rmSync(beside, { recursive: true, force: true });
    writeFileSync(join(admin, "gitdir"), `${dotgit}\n`);
  }
  // The index follows the branch's tip; the files stay as the Leg left them.
  git(worktreeGit(repoPath, folder), ["reset", "-q"]);
  return kept;
}
