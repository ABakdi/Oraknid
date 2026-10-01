import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { closeDatabase, openDatabase } from "./open.ts";
import { projects } from "./schema.ts";

describe("openDatabase", () => {
  it("applies the migrations and uses WAL with synchronous=FULL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oraknid-db-"));
    const db = await openDatabase({ file: join(dir, "o.db"), backupsDir: join(dir, "backups") });
    expect(db.$client.pragma("journal_mode", { simple: true })).toBe("wal");
    // 2 = FULL
    expect(db.$client.pragma("synchronous", { simple: true })).toBe(2);
    expect(db.$client.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.select().from(projects).all()).toEqual([]);
    closeDatabase(db);
  });

  it("does not back up a fresh database, and reopening applies nothing twice", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oraknid-db-"));
    const file = join(dir, "o.db");
    const backupsDir = join(dir, "backups");
    closeDatabase(await openDatabase({ file, backupsDir }));
    const db = await openDatabase({ file, backupsDir });
    db.insert(projects)
      .values({
        id: "01J9Z3K8W2Q4V6X8Y0A1B2C3D4",
        name: "p",
        workspacePath: "/tmp/p",
        isGitRepo: true,
        releaseBranch: "main",
        workBranch: "dev",
        createdAt: 1,
      })
      .run();
    closeDatabase(db);
    const again = await openDatabase({ file, backupsDir });
    expect(again.select().from(projects).all()).toHaveLength(1);
    closeDatabase(again);
    // No migration was pending on any reopen, so there is nothing to back up.
    expect(() => readdirSync(backupsDir)).toThrow();
  });

  it("backs up an existing database before applying a pending migration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oraknid-db-"));
    const file = join(dir, "o.db");
    const backupsDir = join(dir, "backups");
    const db = await openDatabase({ file, backupsDir });
    // Pretend the last migration has not been applied yet.
    db.$client.exec("delete from __drizzle_migrations");
    db.$client.exec("create table if not exists keep_me (x)");
    // Drop every app table so the init migration can run again cleanly.
    const tables = db.$client
      .prepare(
        "select name from sqlite_master where type='table' and name not like 'sqlite_%' and name not in ('__drizzle_migrations','keep_me')",
      )
      .all() as { name: string }[];
    db.$client.pragma("foreign_keys = OFF");
    for (const { name } of tables) db.$client.exec(`drop table "${name}"`);
    closeDatabase(db);

    closeDatabase(await openDatabase({ file, backupsDir }));
    const backups = readdirSync(backupsDir);
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^pre-migrate-.*\.db$/);
  });
});
