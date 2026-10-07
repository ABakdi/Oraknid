import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";

// "An agent may not make a check pass another way" (ADR-052 §2, ADR-056 §4),
// as one simple rule the Verifier enforces: a check that failed, then
// passes once the attempt has created files outside the task's scope and
// notes that the check's command names, is run again with those files
// hidden. Still passing, it passes; failing then, it failed, and the agent
// is told why. Files it created inside its scope are the work itself.

/** Folders never walked: git's, dependencies, Oraknid's own. */
const SKIP = new Set([".git", "node_modules", ".oraknid", ".venv", "target", "dist", ".next"]);
/** A walk stops here: a tree this big is not looked through. */
const MAX_FILES = 20_000;

/** The files under `cwd`, relative to it, or null when there are too many to look at. */
export function filesUnder(cwd: string): Set<string> | null {
  const out = new Set<string>();
  const walk = (dir: string): boolean => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return true;
    }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const path = join(dir, e.name);
      if (e.isDirectory()) {
        if (!walk(path)) return false;
      } else if (e.isFile() || e.isSymbolicLink()) {
        out.add(relative(cwd, path).split(sep).join("/"));
        if (out.size > MAX_FILES) return false;
      }
    }
    return true;
  };
  return walk(cwd) ? out : null;
}

/**
 * The files made since `before` that are outside the scope and that the
 * command names (by path, or by a file name of at least three characters).
 */
export function suspectFiles(
  command: string,
  before: Set<string>,
  now: Set<string>,
  inScope: (path: string) => boolean,
): string[] {
  const words = new Set(command.split(/[\s'"`=:;|&<>()]+/).filter(Boolean));
  return [...now].filter((path) => {
    if (before.has(path) || inScope(path)) return false;
    const name = basename(path);
    return (
      command.includes(path) ||
      words.has(name) ||
      [...words].some((w) => w.endsWith(`/${name}`)) ||
      (name.length >= 3 && words.has(name.replace(/\.[^.]+$/, "")))
    );
  });
}

/**
 * Moves `paths` (relative to `cwd`) aside, beside the folder, for the
 * length of `fn`, and puts them back whatever happens.
 */
export async function withHidden<T>(
  cwd: string,
  paths: string[],
  fn: () => Promise<T>,
): Promise<T> {
  const aside = join(dirname(cwd), `.oraknid-hidden-${randomBytes(4).toString("hex")}`);
  const moved: [string, string][] = [];
  try {
    for (const [i, p] of paths.entries()) {
      const to = join(aside, String(i));
      mkdirSync(aside, { recursive: true, mode: 0o700 });
      renameSync(join(cwd, p), to);
      moved.push([join(cwd, p), to]);
    }
    return await fn();
  } finally {
    for (const [from, to] of moved.reverse()) {
      try {
        mkdirSync(dirname(from), { recursive: true });
        renameSync(to, from);
      } catch {}
    }
    rmSync(aside, { recursive: true, force: true });
  }
}

/** What the agent is told when a check passed only with its files outside the task. */
export function anotherWay(paths: string[]): string {
  return `This check failed, then passed only with files created outside the task's scope after it failed (${paths.join(", ")}). Run without them, it fails. A check must pass because the work is done, not another way: change the work, not what the check reads.`;
}
