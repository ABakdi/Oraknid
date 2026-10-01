import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { closeDatabase, openDatabase } from "../db/open.ts";
import { nightlyBackup } from "./storage.ts";

describe("nightly backups", () => {
  it("takes one a day and keeps seven", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oraknid-backup-"));
    const db = await openDatabase({ file: join(dir, "o.db"), backupsDir: join(dir, "b") });
    const day = 86_400_000;
    const start = Date.parse("2026-10-01T03:00:00Z");
    expect(await nightlyBackup(db, join(dir, "b"), start)).toBe("nightly-2026-10-01.db");
    expect(await nightlyBackup(db, join(dir, "b"), start + 3_600_000)).toBeNull();
    for (let i = 1; i < 10; i++) await nightlyBackup(db, join(dir, "b"), start + i * day);
    const files = readdirSync(join(dir, "b")).filter((f) => f.startsWith("nightly-"));
    expect(files).toHaveLength(7);
    expect(files.sort()[0]).toBe("nightly-2026-10-04.db");
    expect(existsSync(join(dir, "b", "nightly-2026-10-10.db"))).toBe(true);
    closeDatabase(db);
  });
});
