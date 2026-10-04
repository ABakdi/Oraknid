import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BackupRunView, MongoOptions, MysqlOptions, PgOptions } from "@oraknid/contracts";
import { generateX25519Identity } from "age-encryption";
import { afterEach, describe, expect, it } from "vitest";
import { remoteAllowed } from "../auth/lock.ts";
import { BACKUP_ACTIONS } from "../helper/backups-actions.ts";
import type { HelperDeps } from "../helper/service.ts";
import { rigDaemon, settle } from "../testing/backup-rig.ts";
import { fakeOs } from "../testing/fake-os.ts";
import { fakeSsh } from "../testing/fake-ssh.ts";
import { checkTarget, dumpCommand, plainError, restoreCommand, sane, secretLine } from "./dump.ts";

// Backups without Docker (ADR-044): a SQLite database on the "server"
// (a stand-in SSH server whose commands run here), keys, Verify, the
// schedule with a fake clock, the helper's limits.

const closing: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const c of closing.splice(0).reverse()) await c();
});

const hasSqlite = spawnSync("sqlite3", ["-version"]).status === 0;
const at = (s: string) => new Date(s).getTime();

function sqliteDb() {
  const dir = mkdtempSync(join(tmpdir(), "oraknid-sqlite-"));
  const file = join(dir, "shop.db");
  execFileSync("sqlite3", [
    file,
    "create table items(id integer primary key, name text); insert into items(name) values ('violin'),('cello');",
  ]);
  return file;
}

async function setup(o: Parameters<typeof rigDaemon>[0] = {}) {
  const ssh = await fakeSsh({ password: "pw" });
  closing.push(ssh.close);
  const r = await rigDaemon(o);
  closing.push(() => r.daemon.close());
  const server = await r.api.servers.add({
    name: "box",
    host: "127.0.0.1",
    port: ssh.port,
    user: "me",
    password: "pw",
  });
  return { ...r, ssh, serverId: server.id };
}

const sqlitePlan = (serverId: string, path: string, folder: string, keyId: string | null) => ({
  name: "Shop SQLite",
  target: {
    serverId,
    kind: "sqlite" as const,
    container: null,
    host: null,
    port: null,
    database: null,
    user: null,
    path,
  },
  schedule: { kind: "daily" as const, at: "03:30" },
  destination: { kind: "local" as const, folder },
  retention: { count: 2, days: null },
  keyId,
  enabled: true,
});

describe.skipIf(!hasSqlite)("backups (ADR-044)", () => {
  it("keys: made here, the public half shown, the private one exported once, imported, kept while needed", async () => {
    const { api, serverId, dir } = await setup();
    const k = await api.backups.createKey({ name: "Laptop" });
    expect(k).toMatchObject({ name: "Laptop", imported: false, exportedAt: null, planCount: 0 });
    expect(JSON.stringify(await api.backups.keys())).not.toContain("AGE-SECRET-KEY");
    const out = await api.backups.exportKey({ id: k.id });
    expect(out.privateKey).toMatch(/^AGE-SECRET-KEY-1[0-9A-Z]+$/);
    expect(out.publicKey).toBe(k.publicKey);
    await expect(api.backups.exportKey({ id: k.id })).rejects.toThrow(/already taken once/);
    expect((await api.backups.keys())[0]?.exportedAt).not.toBeNull();
    // The same key again: refused; another of mine: kept, nothing to export.
    await expect(api.backups.importKey({ name: "x", privateKey: out.privateKey })).rejects.toThrow(
      /already here, as "Laptop"/,
    );
    await expect(api.backups.importKey({ name: "x", privateKey: "hello" })).rejects.toThrow(
      /isn't an age private key/,
    );
    const mine = await api.backups.importKey({
      name: "From my USB stick",
      privateKey: await generateX25519Identity(),
    });
    expect(mine).toMatchObject({ imported: true });
    expect(mine.exportedAt).not.toBeNull();

    // In use by a plan: it stays.
    const plan = await api.backups.createPlan(
      sqlitePlan(serverId, sqliteDb(), join(dir, "out"), k.id),
    );
    await expect(api.backups.removeKey({ id: k.id })).rejects.toThrow(/encrypts with this key/);
    await api.backups.updatePlan({ id: plan.id, keyId: null });
    await api.backups.removeKey({ id: k.id });
    expect((await api.backups.keys()).map((x) => x.name)).toEqual(["From my USB stick"]);
  });

  it("backs a SQLite file up on the host, encrypted; verifies it, notices a damaged one, prunes by count and restores", async () => {
    const { api, daemon, fake, serverId, dir } = await setup();
    const k = await api.backups.createKey({ name: "k" });
    const db = sqliteDb();
    const plan = await api.backups.createPlan(sqlitePlan(serverId, db, join(dir, "out"), k.id));
    expect(plan.nextRunAt).toBeGreaterThan(Date.now());
    const runs: BackupRunView[] = [];
    for (let i = 0; i < 3; i++) {
      runs.push(await settle(api, (await api.backups.run({ id: plan.id })).runId));
      await new Promise((r) => setTimeout(r, 1100));
    }
    for (const r of runs) expect(r).toMatchObject({ state: "ok", trigger: "manual" });
    // Count 2: the oldest went, from the disk too.
    const all = await api.backups.runs({ planId: plan.id });
    expect(all.filter((r) => r.prunedAt).map((r) => r.id)).toEqual([runs[0]?.id]);
    expect(() => readFileSync(runs[0]?.path as string)).toThrow();

    const good = await api.backups.verify({ runId: runs[2]?.id as string });
    expect(good).toMatchObject({ verifyOk: true });
    expect(good.verifyNote).toMatch(/of a SQLite database, complete/);

    // One byte changed: the checksum says so.
    const path = runs[1]?.path as string;
    const bytes = readFileSync(path);
    bytes.writeUInt8((bytes.at(-20) ?? 0) ^ 0xff, bytes.length - 20);
    writeFileSync(path, bytes);
    const bad = await api.backups.verify({ runId: runs[1]?.id as string });
    expect(bad).toMatchObject({ verifyOk: false });
    expect(bad.verifyNote).toMatch(/checksum changed|can't be decrypted/);

    // Without its private key it can't be read back.
    const secretName = `backup.key.${k.id}`;
    const kept = fake.store.get(secretName) as string;
    fake.store.delete(secretName);
    const nokey = await api.backups.verify({ runId: runs[2]?.id as string });
    expect(nokey.verifyNote).toMatch(/isn't in the keychain/);
    fake.store.set(secretName, kept);

    // A row lost, then restored over the same file.
    execFileSync("sqlite3", [db, "delete from items where id = 2"]);
    const p = await api.backups.prepareRestore({ runId: runs[2]?.id as string });
    expect(p.confirmWord).toBe("shop.db");
    expect(p.summary).toMatch(/Replace the SQLite file .*shop\.db on box/);
    await api.backups.restore({ token: p.token, confirm: "shop.db" });
    expect(
      execFileSync("sqlite3", [db, "select name from items order by id"], { encoding: "utf8" }),
    ).toBe("violin\ncello\n");
    // Restored by me: in the audit trail as mine.
    const restored = daemon.db.$client
      .prepare("select actor from events where type = 'backup.restore.ended'")
      .all() as { actor: string }[];
    expect(restored.map((e) => e.actor)).toEqual(["owner"]);
    // Running twice at once: refused.
    const { runId } = await api.backups.run({ id: plan.id });
    await expect(api.backups.run({ id: plan.id })).rejects.toThrow(/running already/);
    await settle(api, runId);
  }, 60_000);

  it("runs at its time, and a time missed while Oraknid was off runs when it's back, said so", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oraknid-missed-"));
    const fake = fakeOs({ keychain: true });
    let clock = at("2026-10-03T03:00:00");
    const opts = { dir, dbFile: join(dir, "oraknid.db"), os: fake.os, now: () => clock };
    const ssh = await fakeSsh({ password: "pw" });
    closing.push(ssh.close);
    const first = await rigDaemon(opts);
    const server = await first.api.servers.add({
      name: "box",
      host: "127.0.0.1",
      port: ssh.port,
      user: "me",
      password: "pw",
    });
    const plan = await first.api.backups.createPlan(
      sqlitePlan(server.id, sqliteDb(), join(dir, "out"), null),
    );
    expect(plan.nextRunAt).toBe(at("2026-10-03T03:30:00"));
    await first.daemon.close();

    // Off at 03:30; back at 09:00.
    clock = at("2026-10-03T09:00:00");
    const second = await rigDaemon(opts);
    closing.push(() => second.daemon.close());
    await second.daemon.backups.settled();
    let runs = await second.api.backups.runs({ planId: plan.id });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ trigger: "missed", state: "ok" });
    const started = second.daemon.db.$client
      .prepare("select payload from events where type = 'backup.run.started'")
      .all() as { payload: string }[];
    expect(started.at(-1)?.payload).toMatch(/Oraknid was off at its time/);
    // Once only, and the next time is tomorrow's.
    expect((await second.api.backups.plans()).at(0)?.nextRunAt).toBe(at("2026-10-04T03:30:00"));
    await second.daemon.backups.tick();
    expect(await second.api.backups.runs({ planId: plan.id })).toHaveLength(1);

    // At its time: a scheduled run.
    clock = at("2026-10-04T03:30:20");
    await second.daemon.backups.tick();
    await second.daemon.backups.settled();
    runs = await second.api.backups.runs({ planId: plan.id });
    expect(runs.map((r) => r.trigger)).toEqual(["schedule", "missed"]);
    // Paused: nothing runs.
    await second.api.backups.updatePlan({ id: plan.id, enabled: false });
    clock = at("2026-10-06T03:31:00");
    await second.daemon.backups.tick();
    expect(await second.api.backups.runs({ planId: plan.id })).toHaveLength(2);
  }, 60_000);

  it("the helper sets plans up and makes keys, asks before anything that writes on a server, never shows a private key, and can't restore", async () => {
    const { daemon, serverId, dir } = await setup();
    const d = { backups: daemon.backups } as unknown as HelperDeps;
    const made = await BACKUP_ACTIONS.make_backup_key?.run(d, { name: "helper's" } as never);
    expect(made?.result).toMatch(/age1/);
    expect(made?.result).not.toMatch(/AGE-SECRET-KEY/);
    const local = {
      ...sqlitePlan(serverId, "/x.db", join(dir, "o"), null),
      target: {
        ...sqlitePlan(serverId, "/x.db", "", null).target,
        kind: "postgres",
        path: null,
        database: "shop",
      },
    };
    const confirm = (name: string, input: unknown) =>
      BACKUP_ACTIONS[name]?.confirm(BACKUP_ACTIONS[name].input.parse(input) as never);
    expect(confirm("create_backup_plan", local)).toBe(false);
    expect(
      confirm("create_backup_plan", {
        ...local,
        destination: { kind: "server", serverId, folder: "b" },
      }),
    ).toBe(true);
    expect(
      confirm("create_backup_plan", {
        ...local,
        target: { ...local.target, kind: "redis", database: null },
      }),
    ).toBe(true);
    expect(confirm("run_backup", { id: "x" })).toBe(true);
    expect(confirm("verify_backup", { runId: "x" })).toBe(false);
    // No password through the chat, and no restore at all.
    expect(
      BACKUP_ACTIONS.create_backup_plan?.input.safeParse({ ...local, password: "p" }).data,
    ).not.toHaveProperty("password");
    expect(Object.keys(BACKUP_ACTIONS).filter((n) => /restore|export/.test(n))).toEqual([]);
    const created = await BACKUP_ACTIONS.create_backup_plan?.run(
      d,
      BACKUP_ACTIONS.create_backup_plan.input.parse(local) as never,
    );
    expect(created?.result).toMatch(/Add the database's password in its form/);
    const read = await BACKUP_ACTIONS.list_backups?.run(d, {} as never);
    expect(read?.data).toMatch(/Restoring is the owner's alone/);
    expect(read?.data).not.toMatch(/AGE-SECRET-KEY/);
  });
});

describe("backup commands (ADR-044)", () => {
  const t = {
    serverId: "01M41GSETJFT8T355BQF7W9QQ6",
    kind: "postgres" as const,
    container: "shop-db",
    host: null,
    port: null,
    database: "shop",
    user: "app",
    path: null,
  };

  it("never put a password on a command line: it's read from stdin and handed on by name", () => {
    for (const kind of ["postgres", "mysql", "mongodb", "redis", "sqlite"] as const) {
      const c = dumpCommand({ ...t, kind, ...(kind === "sqlite" ? { path: "/d.db" } : {}) });
      expect(c).toMatch(/read -r ORAKNID_S/);
      expect(c).not.toMatch(/--password|PGPASSWORD=(?!\$ORAKNID_S)|MYSQL_PWD=(?!\$ORAKNID_S)/);
      expect(restoreCommand({ ...t, kind }, "shop")).toMatch(/read -r ORAKNID_S/);
    }
    expect(dumpCommand(t)).toContain("exec -i -e PGPASSWORD");
  });

  it("turns tools' errors into plain words, without the password", () => {
    const o = { server: "vps", user: "deploy", password: "hunter2" };
    expect(
      plainError(
        t,
        1,
        "Got permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock",
        o,
      ),
    ).toMatch(/can't use Docker on vps: add it to the docker group/);
    expect(plainError({ ...t, container: null }, 127, "sh: 1: pg_dump: not found", o)).toBe(
      "pg_dump isn't installed in vps: PostgreSQL's own tools are needed there.",
    );
    expect(plainError(t, 1, 'pg_dump: error: FATAL: database "shop" does not exist', o)).toBe(
      'There\'s no database "shop" in the container shop-db.',
    );
    expect(plainError(t, 2, "weird hunter2 failure", o)).toBe(
      "The PostgreSQL tool stopped: weird ••• failure",
    );
  });

  it("tells a whole dump from a cut one", () => {
    const pg = Buffer.from("--\n-- PostgreSQL database dump\n--\n");
    expect(
      sane("postgres", pg, Buffer.from("-- PostgreSQL database dump complete\n"), 100).ok,
    ).toBe(true);
    expect(sane("postgres", pg, Buffer.from("INSERT INTO"), 100).note).toMatch(/cut short/);
    expect(sane("mysql", Buffer.from("garbage"), Buffer.alloc(0), 7).note).toMatch(
      /doesn't start like/,
    );
    expect(
      sane("redis", Buffer.from("REDIS0011..."), Buffer.from([1, 0xff, 1, 2, 3, 4, 5, 6, 7, 8]), 30)
        .ok,
    ).toBe(true);
    expect(sane("sqlite", Buffer.alloc(0), Buffer.alloc(0), 0).note).toMatch(/empty/);
  });

  it("each kind's own fields become its flags or its environment; a secret only on stdin", () => {
    const pg = {
      ...t,
      options: {
        postgres: PgOptions.parse({
          sslmode: "verify-full",
          schemas: ["sales", "public"],
          format: "custom",
          extra: ["--no-comments"],
        }),
      },
    };
    const c = dumpCommand(pg);
    for (const part of ["PGSSLMODE=verify-full", "-Fc", "sales", "--no-comments"])
      expect(c).toContain(part);
    expect(c).not.toContain("--clean");
    expect(restoreCommand(pg, "shop", { pgFormat: "custom" })).toContain("pg_restore");
    const mysql = {
      ...t,
      kind: "mysql" as const,
      options: {
        mysql: MysqlOptions.parse({ tls: "verify", singleTransaction: false, events: true }),
      },
    };
    const m = dumpCommand(mysql);
    expect(m).toContain("VERIFY_IDENTITY");
    expect(m).toContain("--ssl-verify-server-cert");
    expect(m).toContain("--events");
    expect(m).not.toContain("--single-transaction");
    const mongo = {
      ...t,
      kind: "mongodb" as const,
      options: {
        mongodb: MongoOptions.parse({
          authSource: "shop",
          replicaSet: "rs0",
          tls: "insecure",
          readPreference: "secondary",
        }),
      },
    };
    const g = dumpCommand(mongo);
    for (const part of ["rs0/127.0.0.1:27017", "--sslAllowInvalidCertificates", "secondary"])
      expect(g).toContain(part);
    // With a connection string, it says where and who: no host or user flags.
    expect(dumpCommand(mongo, { uri: true })).not.toContain("--username");
    const line = secretLine("mongodb", "pw", "mongodb://a:pw@h/db");
    expect(JSON.parse(line)).toEqual({ password: "pw", uri: "mongodb://a:pw@h/db" });
    expect(() => secretLine("postgres", "a\nb")).toThrow(/line break/);
    // An option off the list never reaches pg_dump.
    expect(PgOptions.safeParse({ extra: ["--file=/etc/passwd"] }).success).toBe(false);
    expect(PgOptions.safeParse({ extra: ["--exclude-table=x;rm"] }).success).toBe(false);
    expect(() =>
      checkTarget({
        ...t,
        database: null,
        options: { postgres: PgOptions.parse({ format: "custom" }) },
      }),
    ).toThrow(/name the database/);
    expect(
      plainError(mongo, 1, "MongoServerError: Authentication failed.", {
        server: "vps",
        user: "me",
      }),
    ).toMatch(/against the authentication database "shop"/);
    expect(
      plainError(mongo, 1, "connect to mongodb://app:hunter2@x:1/ failed", {
        server: "vps",
        user: "me",
      }),
    ).not.toContain("hunter2");
    // pg_dump's custom format: "PGDMP", and a last data block ending in a zero length.
    const head = Buffer.concat([Buffer.from("PGDMP"), Buffer.from([1, 16, 0, 4, 8, 1])]);
    expect(sane("postgres", head, Buffer.from([7, 0, 0, 0, 0, 0]), 2000).note).toMatch(
      /custom-format dump, complete/,
    );
  });

  it("Test connection reads a SQLite file read-only and says what's missing, in words", async () => {
    if (!hasSqlite) return;
    const { api, serverId, dir } = await setup();
    const file = sqliteDb();
    const base = sqlitePlan(serverId, file, join(dir, "probe"), null);
    const ok = await api.backups.testPlan(base);
    expect(ok.server.ok).toBe(true);
    expect(ok.database).toMatchObject({ ok: true, databases: ["main"] });
    expect(ok.database.said).toMatch(/^SQLite 3\.\S+ opened .*shop\.db \(read only\)\.$/);
    expect(ok.destination).toMatchObject({ ok: true });
    const missing = await api.backups.testPlan({
      ...base,
      target: { ...base.target, path: join(dir, "nope.db") },
    });
    expect(missing.database).toMatchObject({
      ok: false,
      said: `There's no file ${join(dir, "nope.db")} in box.`,
    });
    // Nothing saved by testing.
    expect(await api.backups.plans()).toEqual([]);
  });

  it("a change keeps what it doesn't name: a paused plan stays paused, each kind's fields stay", async () => {
    const { api, serverId, dir } = await setup();
    const plan = await api.backups.createPlan({
      ...sqlitePlan(serverId, "/srv/x.db", join(dir, "out"), null),
      name: "PG",
      target: {
        ...t,
        serverId,
        container: null,
        options: { postgres: PgOptions.parse({ sslmode: "require", schemas: ["sales"] }) },
      },
      enabled: false,
    });
    await api.backups.updatePlan({ id: plan.id, name: "PG (renamed)" });
    // The target again, without its kind's fields (the helper, an older form): they stay.
    const { options: _, ...bare } = plan.target;
    const after = await api.backups.updatePlan({ id: plan.id, target: { ...bare, port: 5433 } });
    expect(after).toMatchObject({ name: "PG (renamed)", enabled: false });
    expect(after.target.port).toBe(5433);
    expect(after.target.options?.postgres).toMatchObject({
      sslmode: "require",
      schemas: ["sales"],
    });
    // The helper's change too.
    expect(
      BACKUP_ACTIONS.update_backup_plan?.input.parse({ id: plan.id, name: "x" }),
    ).not.toHaveProperty("enabled");
  });

  it("restoring and changing plans and keys stay at home, or with full rights", () => {
    for (const p of [
      "/backups/restore",
      "/backups/prepareRestore",
      "/backups/exportKey",
      "/backups/createPlan",
      "/backups/testPlan",
    ])
      expect(remoteAllowed(p, false), p).toBe(false);
    for (const p of ["/backups/run", "/backups/verify", "/backups/plans", "/backups/createKey"])
      expect(remoteAllowed(p, false), p).toBe(true);
    expect(remoteAllowed("/backups/restore", true)).toBe(true);
  });
});
