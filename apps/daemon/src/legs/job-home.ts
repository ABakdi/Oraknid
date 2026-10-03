import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";

/**
 * A home per job on a shared Leg (Audit 2, S2-08). Two jobs running at once
 * on one Leg shared its home and its Claude config folder: one job's server
 * keys, transcripts and files were the other's to read.
 *
 * Each job gets its own home (and, for Claude Code, its own config folder)
 * under `<leg>/jobs/<job>/`. What the Leg's home holds — its login, its
 * settings — is linked into it, entry by entry, so signing in once still
 * serves every job, and a refreshed token reaches the Leg. What a session
 * keeps of its own work (SSH keys, caches, histories, transcripts) is not
 * linked: each job's is its own. A job's sandbox binds its own folders and
 * the linked entries, never the Leg's home as a whole, nor another job's.
 */

/** Never shared from a Leg's home: each job has its own. */
const HOME_PRIVATE = [
  ".ssh",
  ".cache",
  ".bash_history",
  ".python_history",
  ".node_repl_history",
  ".lesshst",
  ".local/state",
  // OpenCode's sessions and their snapshots; its sign-in (auth.json) stays shared.
  ".local/share/opencode/storage",
  ".local/share/opencode/snapshot",
  ".local/share/opencode/log",
];

/** Never shared from a Claude Code Leg's config folder: its sessions and what they leave. */
const CLAUDE_PRIVATE = [
  "projects",
  "todos",
  "shell-snapshots",
  "file-history",
  "session-env",
  "plans",
  "history.jsonl",
  "debug",
  "ide",
];

export interface JobHome {
  /** HOME for the job's sessions. */
  home: string;
  /** The Claude config folder for the job's sessions, when the Leg has one. */
  configDir: string | null;
  /** The Leg's entries linked in: bound at their own path in the job's sandbox. */
  shared: string[];
}

/** Where a Leg keeps its jobs' homes: beside its own, never inside it. */
export function jobsDir(legsDir: string, legId: string): string {
  return join(legsDir, legId, "jobs");
}

/** A job's home on a Leg (made by prepareJobHome). */
export function jobHomeDir(legsDir: string, legId: string, jobId: string): string {
  return join(jobsDir(legsDir, legId), safe(jobId), "home");
}

/**
 * The job's home on this Leg, made or brought up to date: entries the Leg
 * has gained since are linked in, and a linked file a program replaced
 * (a token written by rename) goes back to the Leg first.
 */
export function prepareJobHome(o: {
  legsDir: string;
  legId: string;
  jobId: string;
  legHome: string;
  legConfigDir?: string | null;
}): JobHome {
  const home = jobHomeDir(o.legsDir, o.legId, o.jobId);
  const root = dirname(home);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  syncBack(o.legsDir, o.legId, o.legHome, o.legConfigDir ?? null);
  const shared: string[] = [];
  mirror(o.legHome, home, HOME_PRIVATE, shared);
  let configDir: string | null = null;
  if (o.legConfigDir) {
    configDir = join(root, "claude-config");
    mirror(o.legConfigDir, configDir, CLAUDE_PRIVATE, shared);
  }
  return { home, configDir, shared };
}

/**
 * Removes a job's homes on every Leg, once it has ended: its keys and
 * files go with it. A login a program rewrote there goes back to the Leg first.
 */
export function removeJobHomes(
  legsDir: string,
  jobId: string,
  configDirOf: (legId: string) => string | null = () => null,
): void {
  if (!existsSync(legsDir)) return;
  for (const leg of readdirSync(legsDir)) {
    const dir = join(jobsDir(legsDir, leg), safe(jobId));
    if (!existsSync(dir)) continue;
    backInto(join(legsDir, leg, "home"), join(dir, "home"), HOME_PRIVATE);
    const configDir = configDirOf(leg);
    if (configDir) backInto(configDir, join(dir, "claude-config"), CLAUDE_PRIVATE);
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Every linked file of every job of this Leg that a program replaced
 * (written to a new file and renamed over the link) goes back to the Leg
 * when newer, and becomes a link again: one login for all its jobs.
 */
export function syncBack(
  legsDir: string,
  legId: string,
  legHome: string,
  legConfigDir: string | null,
): void {
  const dir = jobsDir(legsDir, legId);
  if (!existsSync(dir)) return;
  for (const job of readdirSync(dir)) {
    backInto(legHome, join(dir, job, "home"), HOME_PRIVATE);
    if (legConfigDir) backInto(legConfigDir, join(dir, job, "claude-config"), CLAUDE_PRIVATE);
  }
}

function backInto(src: string, dst: string, privates: string[]): void {
  if (!existsSync(src) || !existsSync(dst)) return;
  for (const name of readdirSync(src)) {
    if (privates.includes(name)) continue;
    const from = join(src, name);
    const to = join(dst, name);
    const below = privates.filter((p) => p.startsWith(`${name}/`));
    if (below.length) {
      if (isDir(from))
        backInto(
          from,
          to,
          below.map((p) => p.slice(name.length + 1)),
        );
      continue;
    }
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(to);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    try {
      if (st.mtimeMs > statSync(from).mtimeMs && statSync(from).isFile()) {
        const tmp = `${from}.oraknid-${process.pid}`;
        copyFileSync(to, tmp);
        renameSync(tmp, from);
      }
      unlinkSync(to);
      symlinkSync(from, to);
    } catch {}
  }
}

/**
 * Makes `dst` mirror `src`: each entry linked, except the private ones;
 * a folder holding a private entry deeper down is made for real and
 * mirrored in turn. What `dst` already has is left as it is.
 */
function mirror(src: string, dst: string, privates: string[], shared: string[]): void {
  mkdirSync(dst, { recursive: true, mode: 0o700 });
  if (!existsSync(src)) return;
  for (const name of readdirSync(src)) {
    if (privates.includes(name)) continue;
    const from = join(src, name);
    const to = join(dst, name);
    const below = privates.filter((p) => p.startsWith(`${name}/`));
    if (below.length && isDir(from)) {
      if (existsSync(to) && lstatSync(to).isSymbolicLink()) unlinkSync(to);
      mirror(
        from,
        to,
        below.map((p) => p.slice(name.length + 1)),
        shared,
      );
      continue;
    }
    shared.push(from);
    let present = true;
    try {
      lstatSync(to);
    } catch {
      present = false;
    }
    if (!present) symlinkSync(from, to);
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** A job id as a folder name: ULIDs already are; anything else is made so. */
function safe(id: string): string {
  return id.replace(/[^\w.-]/g, "_");
}
