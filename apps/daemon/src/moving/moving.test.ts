import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import type { Router } from "../api/router.ts";
import { type Daemon, startDaemon } from "../daemon.ts";
import { closeDatabase, openDatabase } from "../db/open.ts";
import { events, jobs, projects, sessions, silkEntries } from "../db/schema.ts";
import { Secrets } from "../os/secrets.ts";
import { resolvePaths } from "../paths.ts";
import { fakeOs } from "../testing/fake-os.ts";
import { seedJob } from "../testing/fixtures.ts";
import { applyPendingImport, exportAll, importAll, isFresh, openArchive } from "./move.ts";
import { unzip, zip } from "./zip.ts";

// Exporting a job or a project as a zip and importing it; moving the whole
// Oraknid to another computer through an encrypted archive (ADR-061).

const dirs: string[] = [];
const daemons: Daemon[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = (name: string) => {
  const d = mkdtempSync(join(tmpdir(), `oraknid-${name}-`));
  dirs.push(d);
  return d;
};

describe("Oraknid's zips", () => {
  it("hold what they were given, and nothing outside their folders", () => {
    const z = zip([
      { name: "manifest.json", data: Buffer.from("{}") },
      { name: "aa/x", data: Buffer.alloc(5000, 7) },
    ]);
    const files = unzip(z);
    expect(files.get("manifest.json")?.toString()).toBe("{}");
    expect(files.get("aa/x")?.equals(Buffer.alloc(5000, 7))).toBe(true);
    // The same zip, its second name made "../x": refused.
    const bad = Buffer.from(z);
    let at = bad.lastIndexOf(Buffer.from("aa/x"));
    bad.write("../x", at);
    at = bad.lastIndexOf(Buffer.from("aa/x"));
    bad.write("../x", at);
    expect(() => unzip(bad)).toThrow(/outside its folders/);
    expect(() => zip([{ name: "/etc/passwd", data: Buffer.alloc(1) }])).toThrow();
    expect(() => unzip(Buffer.from("not a zip at all, not at all"))).toThrow(/isn't a zip/);
  });
});

const SECRET = "sk-test-0123456789abcdefghijklmn";

async function daemon(name: string) {
  const dir = temp(name);
  const d = await startDaemon({
    paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
    port: 0,
    dbFile: ":memory:",
    os: fakeOs({ keychain: true }).os,
    adapters: {},
  });
  daemons.push(d);
  const api = createORPCClient<RouterClient<Router>>(
    new RPCLink({ url: `${d.url}/api`, headers: { authorization: `Bearer ${d.cliToken}` } }),
  );
  return { d, api, dir };
}

describe("a job or a project as a zip (Persistence-and-Recovery → Export)", () => {
  it("exports a job's record, Silk and logs, secrets scrubbed, and imports it as an ended record", async () => {
    const a = await daemon("export");
    await a.d.secrets.set("some.key", SECRET);
    const jobId = seedJob(a.d.db, "running");
    const logDir = join(a.dir, "logs", "jobs", jobId);
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, "s1.ndjson"), `{"text":"used ${SECRET}"}\n`);
    a.d.db
      .insert(sessions)
      .values({
        id: "s1",
        jobId,
        legId: "leg",
        legModelId: "m",
        logFile: join(logDir, "s1.ndjson"),
        startedAt: 1,
        endedAt: 2,
      })
      .run();
    a.d.db
      .insert(silkEntries)
      .values({
        id: "silk1",
        jobId,
        kind: "decision",
        title: "Use SQLite",
        body: "Because it is one file.",
        authoredBy: { kind: "eye" },
        createdAt: 1,
      })
      .run();
    a.d.bus.publish({ type: "job.note", topic: `job:${jobId}`, jobId, payload: { text: "hi" } });

    const link = await a.api.records.exportJob({ id: jobId });
    expect(link.name).toMatch(/^oraknid-job-t-\d{4}-\d\d-\d\d\.zip$/);
    const res = await fetch(`${a.d.url}${link.url}`);
    expect(res.status).toBe(200);
    const data = Buffer.from(await res.arrayBuffer());
    const files = unzip(data);
    expect([...files.keys()].sort()).toEqual([
      `jobs/${jobId}/job.json`,
      `jobs/${jobId}/logs/s1.ndjson`,
      `jobs/${jobId}/rows.json`,
      `jobs/${jobId}/silk/decision-silk1.md`,
      "manifest.json",
    ]);
    expect(files.get(`jobs/${jobId}/silk/decision-silk1.md`)?.toString()).toBe(
      "# Use SQLite\n\nBecause it is one file.\n",
    );
    for (const f of files.values()) expect(f.toString()).not.toContain(SECRET);
    // The link is good once.
    expect((await fetch(`${a.d.url}${link.url}`)).status).toBe(404);

    // Into another Oraknid: under a new project of its name, ended, read-only.
    const b = await daemon("import");
    const r = await fetch(`${b.d.url}/api/records/import`, {
      method: "POST",
      headers: { authorization: `Bearer ${b.d.cliToken}`, "content-type": "application/zip" },
      body: data,
    });
    expect(r.status).toBe(200);
    const out = (await r.json()) as { imported: { id: string }[]; projectId: string };
    expect(out.imported.map((j) => j.id)).toEqual([jobId]);
    const job = b.d.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    expect(job?.state).toBe("cancelled");
    expect(job?.projectId).toBe(out.projectId);
    expect(
      b.d.db.select().from(silkEntries).where(eq(silkEntries.jobId, jobId)).all(),
    ).toHaveLength(1);
    expect(
      b.d.db.select().from(events).where(eq(events.type, "job.note")).all().length,
    ).toBeGreaterThan(0);
    const session = b.d.db.select().from(sessions).where(eq(sessions.id, "s1")).get();
    expect(session?.logFile).toBe(join(b.dir, "logs", "jobs", jobId, "s1.ndjson"));
    expect(readFileSync(session?.logFile ?? "", "utf8")).toContain("[secret]");
    // Twice: skipped, said so.
    const again = await fetch(`${b.d.url}/api/records/import`, {
      method: "POST",
      headers: { authorization: `Bearer ${b.d.cliToken}` },
      body: data,
    });
    expect(((await again.json()) as { skipped: { why: string }[] }).skipped[0]?.why).toBe(
      "It is already here.",
    );
  });

  it("exports every job of a project, and refuses a zip that isn't Oraknid's", async () => {
    const a = await daemon("project");
    const j1 = seedJob(a.d.db, "completed");
    const projectId = a.d.db.select().from(jobs).where(eq(jobs.id, j1)).get()?.projectId as string;
    const link = await a.api.records.exportProject({ id: projectId });
    const files = unzip(Buffer.from(await (await fetch(`${a.d.url}${link.url}`)).arrayBuffer()));
    expect(files.has("project.json")).toBe(true);
    expect(files.has(`jobs/${j1}/job.json`)).toBe(true);
    const r = await fetch(`${a.d.url}/api/records/import`, {
      method: "POST",
      headers: { authorization: `Bearer ${a.d.cliToken}` },
      body: zip([{ name: "hello.txt", data: Buffer.from("hi") }]),
    });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { message: string }).message).toMatch(/has no manifest\.json/);
  });
});

describe("moving Oraknid to another computer (ADR-061)", () => {
  async function oldComputer() {
    const dir = temp("old");
    const paths = resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: join(dir, "config") });
    const db = await openDatabase({ file: paths.db, backupsDir: paths.backups });
    const project = temp("project-folder");
    const jobId = seedJob(db, "completed", join(project, "gone"));
    db.update(projects)
      .set({
        repos: [
          {
            name: "app",
            folder: "",
            releaseBranch: "main",
            workBranch: "dev",
            github: {
              account: "me",
              owner: "me",
              name: "app",
              visibility: "private",
              origin: "existing",
              created: true,
            },
          },
        ] as never,
      })
      .run();
    closeDatabase(db);
    mkdirSync(paths.configDir, { recursive: true });
    writeFileSync(join(paths.configDir, "tui.json"), '{"project":"x"}');
    const keychain = fakeOs({ keychain: true }).os.keychain;
    if (!keychain) throw new Error("no keychain");
    const secrets = new Secrets(dir, keychain);
    await secrets.init();
    await secrets.set("server.key.1", "-----BEGIN OPENSSH PRIVATE KEY-----abc");
    await secrets.set("project.secret.2", SECRET);
    return { paths, secrets, jobId };
  }

  async function newComputer() {
    const dir = temp("new");
    const paths = resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: join(dir, "config") });
    const keychain = fakeOs({ keychain: true }).os.keychain;
    if (!keychain) throw new Error("no keychain");
    const secrets = new Secrets(dir, keychain);
    await secrets.init();
    return { paths, secrets };
  }

  it("carries the database, the config and the keychain's entries, encrypted to a passphrase", async () => {
    const old = await oldComputer();
    const out = await exportAll({
      paths: old.paths,
      secrets: old.secrets,
      passphrase: "correct horse battery",
      scryptLogN: 10,
    });
    expect(out.name).toMatch(/^oraknid-move-\d{4}-\d\d-\d\d\.age$/);
    expect(out.manifest.counts).toEqual({ projects: 1, jobs: 1, servers: 0, secrets: 2 });
    // Nothing in clear.
    expect(out.data.includes(Buffer.from(SECRET))).toBe(false);
    expect(out.data.includes(Buffer.from("SQLite format 3"))).toBe(false);
    await expect(openArchive(out.data, "the wrong passphrase")).rejects.toThrow(
      "That passphrase doesn't open the archive.",
    );

    const fresh = await newComputer();
    expect(isFresh(fresh.paths)).toBe(true);
    const r = await importAll({
      paths: fresh.paths,
      secrets: fresh.secrets,
      data: out.data,
      passphrase: "correct horse battery",
    });
    expect(r.applied).toBe(true);
    expect(r.secrets).toBe(2);
    expect(await fresh.secrets.get("project.secret.2")).toBe(SECRET);
    expect(readFileSync(join(fresh.paths.configDir, "tui.json"), "utf8")).toBe('{"project":"x"}');
    expect(r.missing.map((p) => p.repos[0]?.github)).toEqual(["me/app"]);
    const db = new Database(fresh.paths.db, { readonly: true });
    try {
      expect(db.prepare("select id from jobs").all()).toEqual([{ id: old.jobId }]);
    } finally {
      db.close();
    }
    // Now it isn't fresh: another import is refused unless it replaces.
    expect(isFresh(fresh.paths)).toBe(false);
    await expect(
      importAll({
        paths: fresh.paths,
        secrets: fresh.secrets,
        data: out.data,
        passphrase: "correct horse battery",
      }),
    ).rejects.toThrow(/already has projects or jobs/);
    const replaced = await importAll({
      paths: fresh.paths,
      secrets: fresh.secrets,
      data: out.data,
      passphrase: "correct horse battery",
      replace: true,
    });
    expect(replaced.applied).toBe(true);
    // The database it replaced is kept.
    expect(readdirSync(fresh.paths.backups).some((f) => f.startsWith("pre-import-"))).toBe(true);
  });

  it("refuses a short passphrase, and a staged import waits for the next start", async () => {
    const old = await oldComputer();
    await expect(
      exportAll({ paths: old.paths, secrets: old.secrets, passphrase: "short" }),
    ).rejects.toThrow(/at least 12 characters/);
    const out = await exportAll({
      paths: old.paths,
      secrets: old.secrets,
      passphrase: "correct horse battery",
      scryptLogN: 10,
    });
    const fresh = await newComputer();
    const r = await importAll({
      paths: fresh.paths,
      secrets: fresh.secrets,
      data: out.data,
      passphrase: "correct horse battery",
      stageOnly: true,
    });
    expect(r.applied).toBe(false);
    expect(existsSync(fresh.paths.db)).toBe(false);
    expect(await applyPendingImport(fresh.paths)).toBe(true);
    expect(existsSync(fresh.paths.db)).toBe(true);
    expect(await applyPendingImport(fresh.paths)).toBe(false);
  });
});
