import { spawnSync } from "node:child_process";
import { type Dirent, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * What a sandbox must bind for git to work in a worktree (M13.22). A job
 * works in a worktree of its project: its `.git` is a file pointing at the
 * worktree's own folder in the project's `.git/worktrees/<name>`, and the
 * objects and refs live in the project's `.git`. Bound only the worktree,
 * every git command inside said "not a git repository" (and OpenCode, seeing
 * no repo, ran `git init`: the piano job, 2026-10-03).
 *
 * Inside, the project's `.git` is a throwaway folder (`layer`, a tmpfs)
 * holding the real one's entries:
 * - `writable`: the objects, refs and logs (what `add`, `commit` and
 *   `switch -c` write), and this worktree's own git folder (HEAD, index);
 * - `readonly`: everything else, its config, hooks and packed refs first;
 * - `protect`: read-only over those, the links that say where the
 *   repository is: the worktree's `.git` file, its `commondir` and `gitdir`.
 *
 * What git writes beside them (a lock on the packed refs, which `commit`
 * takes) lands in the throwaway folder; so does anything a Leg would add
 * there to steer Oraknid's own git, which runs outside the sandbox (a
 * `commondir`, a hook, a config naming a `core.fsmonitor` program).
 *
 * In a job folder of several repos (ADR-042), the repos' worktrees are
 * found up to two levels down.
 */
export interface GitBinds {
  layer: string[];
  readonly: string[];
  writable: string[];
  protect: string[];
}

/** What git writes in a project's `.git` for work on a branch: shared by its worktrees. */
const WRITTEN = new Set(["objects", "refs", "logs", "lfs", "rr-cache"]);

export function gitBinds(cwd: string): GitBinds {
  const out: GitBinds = { layer: [], readonly: [], writable: [], protect: [] };
  // A worktree itself, or a job folder of several repos: theirs are up to two levels down.
  const folders = [cwd];
  const below = (dir: string, depth: number) => {
    if (depth > 2 || existsSync(join(dir, ".git"))) return;
    let entries: Dirent[] = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
      folders.push(join(dir, e.name));
      below(join(dir, e.name), depth + 1);
    }
  };
  below(cwd, 1);
  for (const folder of folders) {
    const dotgit = join(folder, ".git");
    let text: string;
    try {
      if (!statSync(dotgit).isFile()) continue;
      text = readFileSync(dotgit, "utf8");
    } catch {
      continue;
    }
    const m = /^gitdir:\s*(.+)$/m.exec(text);
    if (!m) continue;
    const admin = resolve(folder, (m[1] as string).trim());
    const commondir = join(admin, "commondir");
    // Only a worktree's: a submodule's git folder is a whole repository, its config included.
    if (!existsSync(commondir)) continue;
    const common = resolve(admin, readFileSync(commondir, "utf8").trim());
    if (!existsSync(join(common, "objects"))) continue;
    // A first reflog needs its folder in the real `.git`: made here, outside the sandbox.
    mkdirSync(join(common, "logs"), { recursive: true });
    out.layer.push(common);
    for (const name of readdirSync(common)) {
      if (name === "worktrees") continue;
      (WRITTEN.has(name) ? out.writable : out.readonly).push(join(common, name));
    }
    out.writable.push(admin);
    out.protect.push(
      dotgit,
      ...["commondir", "gitdir", "config.worktree"]
        .map((f) => join(admin, f))
        .filter((f) => existsSync(f)),
    );
  }
  const dedupe = (xs: string[]) => [...new Set(xs)];
  return {
    layer: dedupe(out.layer),
    readonly: dedupe(out.readonly),
    writable: dedupe(out.writable),
    protect: dedupe(out.protect),
  };
}

let mine: { name: string; email: string } | null = null;

/** My identity in git, read once: from my global config, else Oraknid's. */
function hostIdentity(): { name: string; email: string } {
  if (!mine) {
    const read = (key: string) => {
      const r = spawnSync("git", ["config", "--global", key], { encoding: "utf8", timeout: 5000 });
      return r.status === 0 ? r.stdout.trim() : "";
    };
    const name = read("user.name");
    const email = read("user.email");
    mine = name && email ? { name, email } : { name: "Oraknid", email: "oraknid@localhost" };
  }
  return mine;
}

/** Whether a repository's own config names who commits. */
function namesIdentity(common: string): boolean {
  const r = spawnSync("git", ["config", "--file", join(common, "config"), "--get", "user.email"], {
    encoding: "utf8",
    timeout: 5000,
  });
  return r.status === 0 && r.stdout.trim() !== "";
}

/**
 * Git's settings inside a sandbox, at the command line's level so the
 * project's config can't take them back: any owner is fine (the sandbox
 * maps ids), and no automatic gc or maintenance in a `.git` it sees only
 * part of.
 * And who commits: the sandbox's HOME is the job's, not mine, so without
 * this a commit said "Author identity unknown". A repository that names
 * its own identity keeps it; otherwise mine, as Oraknid's own commits.
 */
export function gitEnv(binds: GitBinds): Record<string, string> {
  const settings: [string, string][] = [
    ["safe.directory", "*"],
    ["gc.auto", "0"],
    ["maintenance.auto", "false"],
  ];
  if (binds.layer.length && !binds.layer.every(namesIdentity)) {
    const me = hostIdentity();
    settings.push(["user.name", me.name], ["user.email", me.email]);
  }
  return {
    GIT_CONFIG_COUNT: String(settings.length),
    ...Object.fromEntries(
      settings.flatMap(([k, v], i) => [
        [`GIT_CONFIG_KEY_${i}`, k],
        [`GIT_CONFIG_VALUE_${i}`, v],
      ]),
    ),
  };
}
