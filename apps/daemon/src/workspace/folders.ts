import {
  accessSync,
  constants,
  type Dirent,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { FolderEntry, FolderList, FolderListInput, NewFolderInput } from "@oraknid/contracts";

// The folder picker (Web-UI → The folder picker, 2026-10-04): a folder on
// this machine, chosen in the browser, from here or from a phone. Only
// folders are listed, by name; no file's name or content leaves here.

/** At most this many folders a listing (the rest: type the path). */
const MAX_ENTRIES = 1000;

/** `~` and `~/…` are my home; anything else must be a full path. */
export function expandPath(path: string | undefined, home = homedir()): string {
  const p = (path ?? "").trim();
  if (!p || p === "~") return home;
  if (p.startsWith("~/")) return resolve(home, p.slice(2));
  if (!isAbsolute(p))
    throw new Error(`Give a full path, like ${join(home, "code")}: ${p} isn't one.`);
  return resolve(p);
}

const can = (path: string, mode: number) => {
  try {
    accessSync(path, mode);
    return true;
  } catch {
    return false;
  }
};

const isGitRepo = (path: string) => existsSync(join(path, ".git"));

/** The folders in one folder; refused, in words, when it isn't there or can't be read. */
export function listFolders(input: Partial<FolderListInput>, home = homedir()): FolderList {
  const path = expandPath(input.path, home);
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EACCES") throw new Error(`Oraknid isn't allowed to look in ${path}.`);
    throw new Error(`${path} doesn't exist.`);
  }
  if (!stat.isDirectory()) throw new Error(`${path} is a file, not a folder.`);
  let all: Dirent[];
  try {
    all = readdirSync(path, { withFileTypes: true });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM")
      throw new Error(`Oraknid isn't allowed to look in ${path}: permission denied.`);
    throw new Error(`${path} can't be read (${code ?? "unknown error"}).`);
  }
  const entries: FolderEntry[] = [];
  let hidden = 0;
  for (const d of all) {
    const full = join(path, d.name);
    let symlink = false;
    if (d.isSymbolicLink()) {
      // A link counts when it leads to a folder; a broken one is left out.
      try {
        if (!statSync(full).isDirectory()) continue;
      } catch {
        continue;
      }
      symlink = true;
    } else if (!d.isDirectory()) continue;
    if (d.name.startsWith(".") && !input.showHidden) {
      hidden++;
      continue;
    }
    const readable = can(full, constants.R_OK | constants.X_OK);
    entries.push({
      name: d.name,
      path: full,
      isGitRepo: readable && isGitRepo(full),
      symlink,
      readable,
    });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  const parent = dirname(path);
  return {
    path,
    parent: parent === path ? null : parent,
    home,
    isGitRepo: isGitRepo(path),
    writable: can(path, constants.W_OK),
    entries: entries.slice(0, MAX_ENTRIES),
    hidden,
    truncated: entries.length > MAX_ENTRIES,
  };
}

/** A new empty folder inside one I chose; refused when it is there already. */
export function makeFolder(input: NewFolderInput, home = homedir()): { path: string } {
  const parent = expandPath(input.parent, home);
  if (!existsSync(parent) || !statSync(parent).isDirectory())
    throw new Error(`${parent} doesn't exist.`);
  if (!can(parent, constants.W_OK)) throw new Error(`${parent} is not writable.`);
  const path = join(parent, input.name);
  if (existsSync(path)) throw new Error(`${path} exists already.`);
  mkdirSync(path);
  return { path };
}
