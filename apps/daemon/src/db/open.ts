import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.ts";

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

export interface OpenOptions {
  /** Path of the database file, or ":memory:". */
  file: string;
  /** Where pre-migration backups go. Required for files. */
  backupsDir?: string;
  /** How many pre-migration backups to keep. */
  keepBackups?: number;
}

/**
 * Opens the database with the pragmas ADR-002 decided, backs it up when
 * migrations are pending, and applies them.
 */
export async function openDatabase(options: OpenOptions): Promise<Db> {
  const inMemory = options.file === ":memory:";
  if (!inMemory) mkdirSync(dirname(options.file), { recursive: true });

  const client = new Database(options.file);
  client.pragma("journal_mode = WAL");
  // FULL: a commit acknowledged before a power cut must survive it (BR-8).
  client.pragma("synchronous = FULL");
  client.pragma("foreign_keys = ON");
  client.pragma("busy_timeout = 5000");
  // Mine alone, whatever the folder's mode (Audit 2).
  if (!inMemory)
    for (const f of [options.file, `${options.file}-wal`, `${options.file}-shm`])
      if (existsSync(f)) chmodSync(f, 0o600);

  const migrationsFolder = findMigrationsFolder();
  const pending = countPendingMigrations(client, migrationsFolder);

  if (!inMemory && pending > 0 && hasUserTables(client)) {
    if (!options.backupsDir) throw new Error("backupsDir is required to migrate a database file");
    await backupBeforeMigrate(client, options.backupsDir, options.keepBackups ?? 10);
  }

  const db = drizzle(client, { schema });
  migrate(db, { migrationsFolder });
  return db;
}

export function closeDatabase(db: Db): void {
  const client = db.$client;
  if (!client.open) return;
  if (!client.memory) client.pragma("wal_checkpoint(TRUNCATE)");
  client.close();
}

/** Walks up from this module to the package's drizzle/ folder (works from src/ and dist/). */
function findMigrationsFolder(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, "drizzle");
    if (existsSync(join(candidate, "meta", "_journal.json"))) return candidate;
    dir = dirname(dir);
  }
  throw new Error(
    "Migrations folder not found: the daemon's drizzle/ folder is missing from the install.",
  );
}

function countPendingMigrations(client: Database.Database, folder: string): number {
  const journal = JSON.parse(readFileSync(join(folder, "meta", "_journal.json"), "utf8")) as {
    entries: unknown[];
  };
  const table = client
    .prepare(
      "select name from sqlite_master where type = 'table' and name = '__drizzle_migrations'",
    )
    .get();
  if (!table) return journal.entries.length;
  const row = client.prepare("select count(*) as n from __drizzle_migrations").get() as {
    n: number;
  };
  return journal.entries.length - row.n;
}

function hasUserTables(client: Database.Database): boolean {
  const row = client
    .prepare(
      "select count(*) as n from sqlite_master where type = 'table' and name not like 'sqlite_%' and name != '__drizzle_migrations'",
    )
    .get() as { n: number };
  return row.n > 0;
}

async function backupBeforeMigrate(client: Database.Database, dir: string, keep: number) {
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  // .backup() is consistent while the database is open; copying the file is not.
  await client.backup(join(dir, `pre-migrate-${stamp}.db`));
  const old = readdirSync(dir)
    .filter((f) => f.startsWith("pre-migrate-") && f.endsWith(".db"))
    .sort()
    .slice(0, -keep);
  for (const f of old) rmSync(join(dir, f));
}
