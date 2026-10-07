import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BackupPlanTest,
  BackupTarget,
  NewCloudProvider,
  ServerDatabases,
} from "@oraknid/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { addLogins } from "../servers/insight.ts";
import { connect } from "../servers/ssh.ts";
import {
  type Api,
  container,
  docker,
  hasDocker,
  logs,
  removeContainers,
  rigDaemon,
  settle,
  until,
  watchArgv,
} from "../testing/backup-rig.ts";
import { cloudSkip, minio, testRclone } from "../testing/cloud-rig.ts";
import { fakeSsh } from "../testing/fake-ssh.ts";

// The plan form's help (ADR-044 → Changed 2026-10-04) against real
// databases in throwaway unprivileged containers, reached through the
// stand-in SSH server: Test connection and each way it fails, each kind's
// own fields reaching the dump (a backup and Verify with them), and a
// container's login read from its environment, never its password.
// Every container is removed after, and by the rig's watcher should the
// run end early.

const closing: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const c of closing.splice(0).reverse()) await c();
});
afterAll(removeContainers, 120_000);

const secret = (what: string) => `${what}-S3cr3t-${Math.random().toString(36).slice(2, 10)}`;
const daily = { kind: "daily", at: "03:30" } as const;

async function rig() {
  const ssh = await fakeSsh({ password: "pw" });
  closing.push(ssh.close);
  const r = await rigDaemon();
  closing.push(() => r.daemon.close());
  const server = await r.api.servers.add({
    name: "db-box",
    host: "127.0.0.1",
    port: ssh.port,
    user: "me",
    password: "pw",
  });
  return { ...r, ssh, serverId: server.id };
}

/** A port nothing listens on. */
async function closedPort() {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise((r) => s.close(r));
  return port;
}

const target = (serverId: string, t: Partial<BackupTarget>): BackupTarget => ({
  serverId,
  kind: "postgres",
  container: null,
  host: null,
  port: null,
  database: null,
  user: null,
  path: null,
  ...t,
});

const form = (
  t: BackupTarget,
  folder: string,
  extra: Partial<BackupPlanTest> = {},
): BackupPlanTest => ({
  name: "",
  target: t,
  schedule: daily,
  destination: { kind: "local", folder },
  retention: { count: null, days: null },
  keyId: null,
  ...extra,
});

/** The logins read from containers' environments, through SSH as the insight reads them. */
async function loginsOf(port: number, found: ServerDatabases["databases"]) {
  const { client } = await connect({
    host: "127.0.0.1",
    port,
    user: "me",
    password: "pw",
    hostKey: null,
  } as never);
  try {
    const data: ServerDatabases = { databases: found, notes: [] };
    await addLogins(client, data);
    return data.databases;
  } finally {
    client.end();
  }
}

const found = (kind: "postgres" | "mysql" | "mongodb" | "redis", name: string) => ({
  kind,
  name,
  source: "container" as const,
  version: null,
  state: "running",
  port: null,
  sizeBytes: null,
  note: null,
  login: null,
  sizes: null,
});

async function testWatched(api: Api, input: BackupPlanTest, password: string) {
  const { result, seen } = await watchArgv(password, () => api.backups.testPlan(input));
  expect(seen).toEqual([]);
  expect(JSON.stringify(result)).not.toContain(password);
  return result;
}

describe.skipIf(!hasDocker)("the plan form against real databases (ADR-044)", () => {
  describe("PostgreSQL", () => {
    const password = secret("pg");
    let pg = "";
    beforeAll(async () => {
      pg = container("form-pg", [
        "-e",
        "POSTGRES_USER=app",
        "-e",
        `POSTGRES_PASSWORD=${password}`,
        "-e",
        "POSTGRES_DB=shop",
        "-e",
        "POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 --auth-local=scram-sha-256",
        "postgres:16",
      ]);
      await until("postgres", () => {
        docker("exec", pg, "pg_isready", "-h", "127.0.0.1", "-U", "app");
        return true;
      });
      await until("postgres tables", () => {
        docker(
          "exec",
          "-e",
          `PGPASSWORD=${password}`,
          pg,
          "psql",
          "-h",
          "127.0.0.1",
          "-U",
          "app",
          "-d",
          "shop",
          "-c",
          "create schema if not exists sales; create table if not exists sales.items(id int primary key, name text); insert into sales.items values (1,'violin'),(2,'cello') on conflict do nothing; create table if not exists public.notes(id int);",
        );
        return true;
      });
    }, 180_000);

    it("Test connection: the server, the login (its version and databases) and a folder made and removed; the password on no command line", async () => {
      const { api, ssh, serverId, dir } = await rig();
      const folder = join(dir, "not", "there", "yet");
      const t = target(serverId, {
        container: pg,
        host: "127.0.0.1",
        database: "shop",
        user: "app",
      });
      const r = await testWatched(api, form(t, folder, { password }), password);
      expect(r.server).toEqual({ ok: true, said: "Reached db-box over SSH as me." });
      expect(r.database.ok).toBe(true);
      expect(r.database.version).toMatch(/^16\./);
      expect(r.database.databases).toEqual(expect.arrayContaining(["postgres", "shop"]));
      expect(r.database.said).toMatch(
        /^PostgreSQL 16\.\d+.* in oraknid-test-form-pg-\w+ let the login in; its databases: .*shop/,
      );
      expect(r.destination.ok).toBe(true);
      // The folders it made to try are gone again.
      expect(existsSync(join(dir, "not"))).toBe(false);
      expect(ssh.commands.join("\n")).not.toContain(password);
      // Nothing was saved.
      expect(await api.backups.plans()).toEqual([]);
    }, 60_000);

    it("says why not: a wrong password, a database that isn't there, sslmode the server doesn't speak, a folder it can't write", async () => {
      const { api, serverId, dir, daemon } = await rig();
      const t = target(serverId, {
        container: pg,
        host: "127.0.0.1",
        database: "shop",
        user: "app",
      });
      const wrong = secret("wrong");
      const bad = await testWatched(api, form(t, dir, { password: wrong }), wrong);
      expect(bad.server.ok).toBe(true);
      expect(bad.database).toMatchObject({
        ok: false,
        said: 'PostgreSQL refused the login of "app": check the user and password in the plan.',
      });
      const missing = await api.backups.testPlan(
        form({ ...t, database: "nope" }, dir, { password }),
      );
      expect(missing.database.ok).toBe(false);
      expect(missing.database.said).toMatch(/There's no database "nope"/);
      const ssl = await api.backups.testPlan(
        form({ ...t, options: { postgres: { sslmode: "require" } } } as BackupTarget, dir, {
          password,
        }),
      );
      expect(ssl.database.ok).toBe(false);
      expect(ssl.database.said).toMatch(/didn't agree on TLS.*check TLS under Advanced/);
      const locked = join(dir, "locked");
      mkdirSync(locked);
      chmodSync(locked, 0o500);
      const ro = await api.backups.testPlan(form(t, join(locked, "backups"), { password }));
      expect(ro.database.ok).toBe(true);
      expect(ro.destination).toEqual({
        ok: false,
        said: `Oraknid can't write in ${join(locked, "backups")} on this computer: permission denied.`,
      });
      // Another server as the destination, its folder not writable for its login.
      const elsewhere = await api.backups.testPlan(
        form(t, "", {
          password,
          destination: { kind: "server", serverId, folder: join(locked, "x") },
        }),
      );
      expect(elsewhere.destination).toEqual({
        ok: false,
        said: `me can't write in ${join(locked, "x")} on db-box: permission denied.`,
      });
      const fine = await api.backups.testPlan(
        form(t, "", {
          password,
          destination: { kind: "server", serverId, folder: join(dir, "remote", "deep") },
        }),
      );
      expect(fine.destination).toEqual({
        ok: true,
        said: `db-box's folder ${join(dir, "remote", "deep")} takes backups.`,
      });
      expect(existsSync(join(dir, "remote"))).toBe(false);
      chmodSync(locked, 0o700);
      const events = JSON.stringify(
        daemon.db.$client.prepare("select type, payload from events").all(),
      );
      expect(events).not.toContain(wrong);
      expect(events).not.toContain(password);
    }, 60_000);

    it("a server that doesn't answer: said, and the database not tried", async () => {
      const { api, dir } = await rig();
      const gone = await api.servers.add({
        name: "gone-box",
        host: "127.0.0.1",
        port: await closedPort(),
        user: "me",
        password: "pw",
      });
      const r = await api.backups.testPlan(
        form(target(gone.id, { container: pg, user: "app" }), dir, { password }),
      );
      expect(r.server).toMatchObject({ ok: false });
      expect(r.server.said).toMatch(
        /^gone-box \(127\.0\.0\.1:\d+\) refused the connection: is SSH running there, on that port\?$/,
      );
      expect(r.database).toMatchObject({ ok: null, said: "Not tried: the server wasn't reached." });
      expect(r.destination.ok).toBe(true);
    }, 60_000);

    it("its own fields reach the dump: the custom format, a schema, an extra option and sslmode; verified and restored with pg_restore", async () => {
      const { api, ssh, serverId, dir } = await rig();
      const t = target(serverId, {
        container: pg,
        host: "127.0.0.1",
        database: "shop",
        user: "app",
        options: {
          postgres: {
            sslmode: "disable",
            schemas: ["sales"],
            format: "custom",
            extra: ["--no-comments", "--exclude-table-data=sales.none"],
          },
        },
      });
      const tested = await testWatched(api, form(t, dir, { password }), password);
      expect(tested.database.ok).toBe(true);
      const plan = await api.backups.createPlan({
        ...form(t, join(dir, "out")),
        name: "Shop (custom)",
        enabled: true,
        password,
      });
      expect(plan.target.options?.postgres).toEqual({
        sslmode: "disable",
        schemas: ["sales"],
        format: "custom",
        extra: ["--no-comments", "--exclude-table-data=sales.none"],
      });
      // Reject what isn't on the list, in words.
      await expect(
        api.backups.updatePlan({
          id: plan.id,
          target: {
            ...t,
            options: { postgres: { extra: ["--file=/etc/passwd"] } },
          } as BackupTarget,
        }),
      ).rejects.toThrow();
      const { result: run, seen } = await watchArgv(password, async () =>
        settle(api, (await api.backups.run({ id: plan.id })).runId),
      );
      expect(seen).toEqual([]);
      expect(run).toMatchObject({ state: "ok", error: null });
      expect(run.path).toMatch(/shop\.dump\.zst$/);
      const dump = ssh.commands.find((c) => c.includes("pg_dump") && c.includes("-Fc")) ?? "";
      for (const part of [
        "PGSSLMODE=disable",
        "-n",
        "sales",
        "--no-comments",
        "--exclude-table-data=sales.none",
      ])
        expect(dump).toContain(part);
      const v = await api.backups.verify({ runId: run.id });
      expect(v.verifyOk).toBe(true);
      expect(v.verifyNote).toMatch(/PostgreSQL custom-format dump/);
      // Into a fresh database, with pg_restore.
      const p = await api.backups.prepareRestore({
        runId: run.id,
        target: { ...plan.target, database: "copy" },
        password,
      });
      await api.backups.restore({ token: p.token, confirm: "copy" });
      expect(
        docker(
          "exec",
          "-e",
          `PGPASSWORD=${password}`,
          pg,
          "psql",
          "-h",
          "127.0.0.1",
          "-U",
          "app",
          "-d",
          "copy",
          "-tAc",
          "select string_agg(name, ',' order by id) from sales.items",
        ),
      ).toBe("violin,cello");
      // Only the schema asked for.
      expect(
        docker(
          "exec",
          "-e",
          `PGPASSWORD=${password}`,
          pg,
          "psql",
          "-h",
          "127.0.0.1",
          "-U",
          "app",
          "-d",
          "copy",
          "-tAc",
          "select count(*) from information_schema.tables where table_name = 'notes'",
        ),
      ).toBe("0");
    }, 180_000);

    it("a found container's login comes from its environment, its password never", async () => {
      const { ssh } = await rig();
      const [d] = await loginsOf(ssh.port, [found("postgres", pg)]);
      expect(d?.login).toEqual({ user: "app", database: "shop", passwordSet: true });
      expect(JSON.stringify(d)).not.toContain(password);
      expect(ssh.commands.join("\n")).not.toContain(password);
    }, 30_000);
  });

  describe("MariaDB", () => {
    const password = secret("maria");
    const root = secret("root");
    let db = "";
    beforeAll(async () => {
      db = container("form-maria", [
        "-e",
        `MARIADB_ROOT_PASSWORD=${root}`,
        "-e",
        "MARIADB_DATABASE=shop",
        "-e",
        "MARIADB_USER=app",
        "-e",
        `MARIADB_PASSWORD=${password}`,
        "mariadb:11",
      ]);
      await until(
        "mariadb",
        () => logs(db).includes("ready for connections") && /port: 3306/.test(logs(db)),
        120_000,
      );
      await until("mariadb tables", () => {
        docker(
          "exec",
          "-e",
          `MYSQL_PWD=${password}`,
          db,
          "mariadb",
          "-h",
          "127.0.0.1",
          "-uapp",
          "shop",
          "-e",
          "create table if not exists items(id int primary key, name text); replace into items values (1,'violin'),(2,'cello'); create trigger if not exists t1 before insert on items for each row set new.name = new.name;",
        );
        return true;
      });
    }, 180_000);

    it("Test connection, a wrong password, and its own fields in the dump (events, no triggers, no single transaction, TLS off)", async () => {
      const { api, ssh, serverId, dir } = await rig();
      const t = target(serverId, {
        kind: "mysql",
        container: db,
        host: "127.0.0.1",
        port: 3306,
        database: "shop",
        user: "app",
      });
      const ok = await testWatched(api, form(t, dir, { password }), password);
      expect(ok.database).toMatchObject({ ok: true });
      expect(ok.database.version).toMatch(/MariaDB/);
      expect(ok.database.databases).toContain("shop");
      const wrong = secret("wrong");
      const bad = await testWatched(api, form(t, dir, { password: wrong }), wrong);
      expect(bad.database.said).toBe(
        'MySQL/MariaDB refused the login of "app": check the user and password in the plan.',
      );
      const withOptions = {
        ...t,
        options: {
          mysql: {
            tls: "off",
            singleTransaction: false,
            routines: true,
            events: true,
            triggers: false,
          },
        },
      } as BackupTarget;
      expect((await api.backups.testPlan(form(withOptions, dir, { password }))).database.ok).toBe(
        true,
      );
      const plan = await api.backups.createPlan({
        ...form(withOptions, join(dir, "out")),
        name: "Shop (MariaDB)",
        enabled: true,
        password,
      });
      const { result: run, seen } = await watchArgv(password, async () =>
        settle(api, (await api.backups.run({ id: plan.id })).runId),
      );
      expect(seen).toEqual([]);
      expect(run.state).toBe("ok");
      const dump = ssh.commands.find((c) => c.includes("--quick")) ?? "";
      expect(dump).toContain("--events");
      expect(dump).toContain("--skip-triggers");
      expect(dump).toContain("--skip-ssl");
      expect(dump).not.toContain("--single-transaction");
      expect((await api.backups.verify({ runId: run.id })).verifyNote).toMatch(
        /MariaDB dump, complete/,
      );
    }, 120_000);

    it("a found container's login from its environment: MARIADB_USER and MARIADB_DATABASE, the passwords only as set", async () => {
      const { ssh } = await rig();
      const [d] = await loginsOf(ssh.port, [found("mysql", db)]);
      expect(d?.login).toEqual({ user: "app", database: "shop", passwordSet: true });
      expect(JSON.stringify(d)).not.toContain(password);
      expect(JSON.stringify(d)).not.toContain(root);
    }, 30_000);
  });

  describe("MongoDB, a user in its own authentication database", () => {
    const rootPw = secret("mroot");
    const password = secret("mapp");
    let m = "";
    beforeAll(async () => {
      m = container("form-mongo", [
        "-e",
        "MONGO_INITDB_ROOT_USERNAME=root",
        "-e",
        `MONGO_INITDB_ROOT_PASSWORD=${rootPw}`,
        "mongo:7",
      ]);
      await until(
        "mongo",
        () =>
          logs(m).includes("MongoDB init process complete") &&
          /Waiting for connections[\s\S]*Waiting for connections/.test(logs(m)),
        120_000,
      );
      await until("mongo user", () => {
        docker(
          "exec",
          m,
          "mongosh",
          "--quiet",
          "-u",
          "root",
          "-p",
          rootPw,
          "--authenticationDatabase",
          "admin",
          "shop",
          "--eval",
          `if (!db.getUser("app")) db.createUser({user: "app", pwd: ${JSON.stringify(password)}, roles: [{role: "readWrite", db: "shop"}]}); db.items.deleteMany({}); db.items.insertMany([{n:"violin"},{n:"cello"}])`,
        );
        return true;
      });
    }, 180_000);

    it("Test connection with authSource; the wrong one said as such; a backup with a read preference, verified", async () => {
      const { api, ssh, serverId, dir } = await rig();
      const t = target(serverId, {
        kind: "mongodb",
        container: m,
        database: "shop",
        user: "app",
        options: { mongodb: { authSource: "shop", readPreference: "primaryPreferred" } },
      } as Partial<BackupTarget>);
      const ok = await testWatched(api, form(t, dir, { password }), password);
      expect(ok.database).toMatchObject({ ok: true });
      expect(ok.database.version).toMatch(/^7\./);
      expect(ok.database.databases).toContain("shop");
      const wrongSource = await testWatched(
        api,
        form({ ...t, options: { mongodb: { authSource: "admin" } } } as BackupTarget, dir, {
          password,
        }),
        password,
      );
      expect(wrongSource.database).toMatchObject({
        ok: false,
        said: 'MongoDB refused the login of "app" against the authentication database "admin": check the user, the password and the authentication database (Advanced).',
      });
      const plan = await api.backups.createPlan({
        ...form(t, join(dir, "out")),
        name: "Mongo shop",
        enabled: true,
        password,
      });
      const { result: run, seen } = await watchArgv(password, async () =>
        settle(api, (await api.backups.run({ id: plan.id })).runId),
      );
      expect(seen).toEqual([]);
      expect(run).toMatchObject({ state: "ok", error: null });
      const dump = ssh.commands.find((c) => c.includes("--archive")) ?? "";
      expect(dump).toContain("--authenticationDatabase");
      expect(dump).toContain("'\\''shop'\\''");
      expect(dump).toContain("primaryPreferred");
      expect((await api.backups.verify({ runId: run.id })).verifyNote).toMatch(
        /MongoDB archive, complete/,
      );
      // No file with a login left in the container.
      expect(
        docker("exec", m, "sh", "-c", "grep -rlE 'password|app' /tmp 2>/dev/null || true"),
      ).toBe("");
    }, 120_000);

    it("a connection string instead of the fields: kept as a secret, tested, backed up, never on a command line", async () => {
      const { api, ssh, serverId, dir, daemon } = await rig();
      const uri = `mongodb://app:${encodeURIComponent(password)}@127.0.0.1:27017/shop?authSource=shop`;
      const t = target(serverId, { kind: "mongodb", container: m, database: "shop" });
      const ok = await testWatched(api, form(t, dir, { uri }), password);
      expect(ok.database).toMatchObject({ ok: true });
      const plan = await api.backups.createPlan({
        ...form(t, join(dir, "out")),
        name: "Mongo by URI",
        enabled: true,
        uri,
      });
      expect(plan).toMatchObject({ hasUri: true, hasPassword: false });
      expect(JSON.stringify(plan)).not.toContain(password);
      // Editing without typing it again keeps it; Test uses the kept one.
      const kept = await api.backups.testPlan({ ...form(t, dir), planId: plan.id });
      expect(kept.database.ok).toBe(true);
      await api.backups.updatePlan({ id: plan.id, name: "Mongo (URI)" });
      expect((await api.backups.plans())[0]).toMatchObject({ name: "Mongo (URI)", hasUri: true });
      const { result: run, seen } = await watchArgv(password, async () =>
        settle(api, (await api.backups.run({ id: plan.id })).runId),
      );
      expect(seen).toEqual([]);
      expect(run).toMatchObject({ state: "ok", error: null });
      expect(ssh.commands.join("\n")).not.toContain(password);
      expect(
        JSON.stringify(daemon.db.$client.prepare("select type, payload from events").all()),
      ).not.toContain(password);
      expect((await api.backups.verify({ runId: run.id })).verifyOk).toBe(true);
    }, 120_000);

    it("a found container's login: MONGO_INITDB_ROOT_USERNAME, never its password", async () => {
      const { ssh } = await rig();
      const [d] = await loginsOf(ssh.port, [found("mongodb", m)]);
      expect(d?.login).toEqual({ user: "root", database: null, passwordSet: true });
      expect(JSON.stringify(d)).not.toContain(rootPw);
    }, 30_000);
  });

  describe("Redis, an ACL user", () => {
    const password = secret("racl");
    let r = "";
    beforeAll(async () => {
      r = container("form-redis", ["redis:7-alpine"]);
      await until("redis", () => logs(r).includes("Ready to accept connections"));
      // The user and its password made inside, not on redis-server's own command line.
      docker(
        "exec",
        r,
        "redis-cli",
        "ACL",
        "SETUSER",
        "backup",
        "on",
        `>${password}`,
        "~*",
        "&*",
        "+@all",
      );
      docker("exec", r, "redis-cli", "-n", "2", "set", "greeting", "hello");
    }, 120_000);

    it("Test connection as the ACL user (its databases, the number asked for), a wrong password, TLS it doesn't speak; a backup as that user, verified", async () => {
      const { api, ssh, serverId, dir } = await rig();
      const t = target(serverId, { kind: "redis", container: r, user: "backup", database: "2" });
      const ok = await testWatched(api, form(t, dir, { password }), password);
      expect(ok.database).toMatchObject({ ok: true });
      expect(ok.database.version).toMatch(/^7\./);
      expect(ok.database.databases).toEqual(["db2"]);
      const wrong = secret("wrong");
      const bad = await testWatched(api, form(t, dir, { password: wrong }), wrong);
      expect(bad.database.said).toBe(
        'Redis refused the login of "backup": check the user and password in the plan.',
      );
      const tls = await api.backups.testPlan(
        form({ ...t, options: { redis: { tls: "on" } } } as BackupTarget, dir, { password }),
      );
      expect(tls.database.ok).toBe(false);
      expect(tls.database.said).toMatch(/TLS/);
      const plan = await api.backups.createPlan({
        ...form(t, join(dir, "out")),
        name: "Cache",
        enabled: true,
        password,
      });
      const { result: run, seen } = await watchArgv(password, async () =>
        settle(api, (await api.backups.run({ id: plan.id })).runId),
      );
      expect(seen).toEqual([]);
      expect(run).toMatchObject({ state: "ok", error: null });
      expect(run.path).toMatch(/all\.rdb\.zst$/);
      expect(ssh.commands.find((c) => c.includes("BGSAVE"))).toContain("--user");
      expect((await api.backups.verify({ runId: run.id })).verifyNote).toMatch(/Redis RDB file/);
    }, 120_000);
  });

  describe.skipIf(!!cloudSkip)("cloud storage as the destination", () => {
    it("Test connection writes a small file there and removes it", async () => {
      const mm = await minio();
      const ssh = await fakeSsh({ password: "pw" });
      closing.push(ssh.close);
      const rr = await rigDaemon({ rclone: () => testRclone });
      closing.push(() => rr.daemon.close());
      const server = await rr.api.servers.add({
        name: "db-box",
        host: "127.0.0.1",
        port: ssh.port,
        user: "me",
        password: "pw",
      });
      const provider = await rr.api.cloud.addProvider({
        kind: "s3",
        name: "Bucket",
        preset: "Minio",
        endpoint: mm.endpoint,
        region: "us-east-1",
        bucket: "probe",
        accessKeyId: mm.user,
        secretAccessKey: mm.password,
        folder: "",
        limitBytes: null,
        unlimited: false,
      } as NewCloudProvider);
      const dir = mkdtempSync(join(tmpdir(), "oraknid-probe-"));
      const res = await rr.api.backups.testPlan(
        form(target(server.id, { kind: "sqlite", path: join(dir, "x.db") }), "", {
          destination: { kind: "cloud", providerId: provider.id, folder: "Backups" },
        }),
      );
      expect(res.destination).toEqual({
        ok: true,
        said: "Cloud storage (Bucket) took a test file in Backups and let it be removed.",
      });
      // Put there, then removed.
      const events = rr.daemon.db.$client
        .prepare("select type, payload from events where type like 'cloud.file.%'")
        .all() as { type: string; payload: string }[];
      expect(events.map((e) => e.type)).toEqual(["cloud.file.uploaded", "cloud.file.deleted"]);
      expect(events[1]?.payload).toMatch(/Backups\/\.oraknid-probe-[0-9a-f]+/);
      expect(readdirSync(dir)).toEqual([]);
    }, 180_000);
  });
});
