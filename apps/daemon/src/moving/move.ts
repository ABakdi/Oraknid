import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { Decrypter, Encrypter } from "age-encryption";
import Database from "better-sqlite3";
import type { Db } from "../db/open.ts";
import type { Secrets } from "../os/secrets.ts";
import type { Paths } from "../paths.ts";
import { VERSION } from "../version.ts";
import { safeName, unzip, type ZipEntry, zip } from "./zip.ts";

// Moving Oraknid to another computer (ADR-061): one archive, a zip
// encrypted with age to a passphrase, holding the database (taken with
// `.backup()`), the config folder's files, every keychain entry of this
// data folder, and a manifest. Projects' folders are not in it: their
// paths and repos are listed, to clone again on the new computer.

export const MOVE_FORMAT = "oraknid.move";
export const MOVE_VERSION = 1;
/** The database waiting to replace this one at the next start. */
export const pendingDb = (paths: Paths) => join(paths.dataDir, "import-pending.db");

export interface MoveProject {
  id: string;
  name: string;
  folder: string;
  repos: { name: string; folder: string; github: string | null }[];
}

export interface MoveManifest {
  format: string;
  version: number;
  exportedAt: number;
  oraknid: string;
  counts: { projects: number; jobs: number; servers: number; secrets: number };
  projects: MoveProject[];
}

const SQLITE_MAGIC = "SQLite format 3\0";

/** What a passphrase must be, in words, or null. */
export function passphraseProblem(p: string): string | null {
  if (p.length < 12)
    return "Use a passphrase of at least 12 characters: it is the archive's only lock.";
  return null;
}

/** The projects and counts of a database file, read without changing it. */
function describeDb(file: string): Pick<MoveManifest, "counts" | "projects"> {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const count = (table: string, where = "") => {
      try {
        return (db.prepare(`select count(*) as n from ${table} ${where}`).get() as { n: number }).n;
      } catch {
        return 0;
      }
    };
    const rows = db
      .prepare(
        "select id, name, workspace_path as folder, repos from projects where server_id is null",
      )
      .all() as { id: string; name: string; folder: string; repos: string | null }[];
    return {
      counts: {
        projects: rows.length,
        jobs: count("jobs"),
        servers: count("servers"),
        secrets: 0,
      },
      projects: rows.map((r) => {
        let repos: {
          name?: string;
          folder?: string;
          github?: { owner?: string; name?: string } | null;
        }[] = [];
        try {
          repos = JSON.parse(r.repos ?? "[]");
        } catch {}
        return {
          id: r.id,
          name: r.name,
          folder: r.folder,
          repos: repos.map((x) => ({
            name: String(x.name ?? ""),
            folder: String(x.folder ?? ""),
            github: x.github?.owner && x.github.name ? `${x.github.owner}/${x.github.name}` : null,
          })),
        };
      }),
    };
  } finally {
    db.close();
  }
}

/** The config folder's files, small ones only, by their path inside it. */
function configFiles(dir: string): ZipEntry[] {
  if (!existsSync(dir)) return [];
  const out: ZipEntry[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && statSync(p).size <= 10 * 1024 * 1024) {
        const rel = relative(dir, p).split(sep).join("/");
        if (safeName(rel)) out.push({ name: `config/${rel}`, data: readFileSync(p) });
      }
    }
  };
  walk(dir);
  return out;
}

export interface ExportAllOptions {
  paths: Paths;
  secrets: Secrets;
  passphrase: string;
  /** The daemon's open database; without it, the file is opened read-only for its backup. */
  db?: Db;
  now?: () => number;
  /** scrypt's work factor (log2 N); age's own, 18, unless a test makes it lighter. */
  scryptLogN?: number;
}

/** Everything, as one archive encrypted to the passphrase (ADR-061). */
export async function exportAll(
  o: ExportAllOptions,
): Promise<{ name: string; data: Buffer; manifest: MoveManifest }> {
  const problem = passphraseProblem(o.passphrase);
  if (problem) throw new Error(problem);
  const now = o.now?.() ?? Date.now();
  const tmp = join(o.paths.dataDir, "tmp", `move-${process.pid}-${now}.db`);
  mkdirSync(dirname(tmp), { recursive: true, mode: 0o700 });
  try {
    // `.backup()`: consistent while the daemon writes; copying the file is not (ADR-002).
    if (o.db) await o.db.$client.backup(tmp);
    else {
      if (!existsSync(o.paths.db)) throw new Error(`There is no database at ${o.paths.db}.`);
      const src = new Database(o.paths.db, { readonly: true, fileMustExist: true });
      try {
        await src.backup(tmp);
      } finally {
        src.close();
      }
    }
    const one = new Database(tmp);
    try {
      one.pragma("journal_mode = DELETE");
    } finally {
      one.close();
    }
    const described = describeDb(tmp);
    const names = await o.secrets.names();
    const secrets: Record<string, string> = {};
    for (const n of names) {
      const v = await o.secrets.get(n);
      if (v !== undefined) secrets[n] = v;
    }
    const manifest: MoveManifest = {
      format: MOVE_FORMAT,
      version: MOVE_VERSION,
      exportedAt: now,
      oraknid: VERSION,
      counts: { ...described.counts, secrets: Object.keys(secrets).length },
      projects: described.projects,
    };
    const archive = zip(
      [
        { name: "manifest.json", data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) },
        { name: "oraknid.db", data: readFileSync(tmp) },
        { name: "secrets.json", data: Buffer.from(JSON.stringify(secrets)) },
        ...configFiles(o.paths.configDir),
      ],
      new Date(now),
    );
    const e = new Encrypter();
    e.setPassphrase(o.passphrase);
    if (o.scryptLogN) e.setScryptWorkFactor(o.scryptLogN);
    const data = Buffer.from(await e.encrypt(archive));
    archive.fill(0);
    const day = new Date(now).toISOString().slice(0, 10);
    return { name: `oraknid-move-${day}.age`, data, manifest };
  } finally {
    rmSync(tmp, { force: true });
  }
}

export interface Archive {
  manifest: MoveManifest;
  files: Map<string, Buffer>;
}

/** The archive opened with its passphrase and checked, or refused in words. */
export async function openArchive(data: Buffer, passphrase: string): Promise<Archive> {
  if (!data.subarray(0, 32).toString("latin1").startsWith("age-encryption.org/v1"))
    throw new Error("That file isn't an archive of Oraknid's (it isn't age-encrypted).");
  const d = new Decrypter();
  d.addPassphrase(passphrase);
  let plain: Uint8Array;
  try {
    plain = await d.decrypt(new Uint8Array(data));
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    throw new Error(
      /passphrase|identity|stanza|decrypt/i.test(why)
        ? "That passphrase doesn't open the archive."
        : `The archive is damaged: ${why}`,
    );
  }
  const files = unzip(Buffer.from(plain), 4 * 1024 * 1024 * 1024);
  const raw = files.get("manifest.json");
  if (!raw) throw new Error("That archive has no manifest: it isn't one of Oraknid's.");
  const manifest = JSON.parse(raw.toString("utf8")) as MoveManifest;
  if (manifest.format !== MOVE_FORMAT) throw new Error("That archive isn't a move of Oraknid's.");
  if (manifest.version > MOVE_VERSION)
    throw new Error(
      `That archive comes from a newer Oraknid (${manifest.oraknid}): update this one first.`,
    );
  const db = files.get("oraknid.db");
  if (!db || db.subarray(0, 16).toString("latin1") !== SQLITE_MAGIC)
    throw new Error("The archive's database is missing or damaged.");
  return { manifest, files };
}

/** Whether this data folder is fresh: no database yet, or one with no project and no job. */
export function isFresh(paths: Paths): boolean {
  if (!existsSync(paths.db)) return true;
  const db = new Database(paths.db, { readonly: true, fileMustExist: true });
  try {
    const n = (sql: string) => {
      try {
        return (db.prepare(sql).get() as { n: number }).n;
      } catch {
        return 0;
      }
    };
    return (
      n("select count(*) as n from projects where server_id is null") === 0 &&
      n("select count(*) as n from jobs") === 0
    );
  } finally {
    db.close();
  }
}

export interface ImportAllOptions {
  paths: Paths;
  /** This data folder's secret store, ready (its keychain service, or the unlocked file). */
  secrets: Secrets;
  data: Buffer;
  passphrase: string;
  /** Replace a data folder that has projects or jobs (its database backed up first). */
  replace?: boolean;
  /** The daemon runs: the database waits for its next start. */
  stageOnly?: boolean;
  now?: () => number;
}

export interface ImportAllResult {
  manifest: MoveManifest;
  /** Projects whose folder isn't on this computer, with their repos to clone again. */
  missing: MoveProject[];
  secrets: number;
  /** The database is in place (false: at the next start). */
  applied: boolean;
}

/**
 * The archive put in place (ADR-061): its secrets stored in this
 * computer's keychain under this data folder's own id, its config files,
 * and its database, now (the daemon stopped) or at the next start.
 */
export async function importAll(o: ImportAllOptions): Promise<ImportAllResult> {
  const { manifest, files } = await openArchive(o.data, o.passphrase);
  if (!o.replace && !isFresh(o.paths))
    throw new Error(
      "This Oraknid already has projects or jobs: import into a fresh install, or replace them (oraknid import --replace, its database backed up first).",
    );
  // Every check passed: now things are written.
  let secrets: Record<string, string> = {};
  try {
    secrets = JSON.parse((files.get("secrets.json") ?? Buffer.from("{}")).toString("utf8"));
  } catch {
    throw new Error("The archive's secrets can't be read.");
  }
  let stored = 0;
  for (const [name, value] of Object.entries(secrets)) {
    if (typeof value !== "string" || !name || name.length > 256) continue;
    await o.secrets.set(name, value);
    stored++;
  }
  for (const [name, data] of files) {
    if (!name.startsWith("config/")) continue;
    const rel = name.slice("config/".length);
    if (!safeName(rel)) continue;
    const to = join(o.paths.configDir, ...rel.split("/"));
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    writeFileSync(to, data, { mode: 0o600 });
  }
  mkdirSync(o.paths.dataDir, { recursive: true, mode: 0o700 });
  const pending = pendingDb(o.paths);
  writeFileSync(pending, files.get("oraknid.db") as Buffer, { mode: 0o600 });
  const applied = o.stageOnly ? false : await applyPendingImport(o.paths, o.now);
  return {
    manifest,
    missing: manifest.projects.filter((p) => !existsSync(p.folder)),
    secrets: stored,
    applied,
  };
}

/**
 * A staged database put in place before the daemon opens its own (at its
 * start, or by `oraknid import`): the one there before kept in `backups/`
 * with `.backup()`. Returns whether there was one.
 */
export async function applyPendingImport(paths: Paths, now = Date.now): Promise<boolean> {
  const pending = pendingDb(paths);
  if (!existsSync(pending)) return false;
  if (existsSync(paths.db)) {
    mkdirSync(paths.backups, { recursive: true, mode: 0o700 });
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, "-");
    const old = new Database(paths.db, { fileMustExist: true });
    try {
      await old.backup(join(paths.backups, `pre-import-${stamp}.db`));
    } finally {
      old.close();
    }
  }
  for (const f of [paths.db, `${paths.db}-wal`, `${paths.db}-shm`]) rmSync(f, { force: true });
  renameSync(pending, paths.db);
  chmodSync(paths.db, 0o600);
  return true;
}
