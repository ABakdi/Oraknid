import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BackupRunView } from "@oraknid/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  container,
  docker,
  hasDocker,
  logs,
  removeContainers,
  rigDaemon,
  settle,
  sshdContainer,
  until,
  watchArgv,
} from "../testing/backup-rig.ts";
import { fakeSsh } from "../testing/fake-ssh.ts";

// Real dumps of real databases (ADR-044), in throwaway Docker containers
// reached through a stand-in SSH server whose commands run here (so
// `docker exec` reaches them), and a real sshd in a container as a second
// server. Skipped where Docker isn't available.

const closing: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const c of closing.splice(0).reverse()) await c();
});
afterAll(removeContainers, 120_000);

const secret = (what: string) => `${what}-S3cr3t-${Math.random().toString(36).slice(2, 10)}`;

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

/** Every event's payload, as stored: the audit trail. */
const eventsText = (api: {
  daemon: { db: { $client: { prepare(s: string): { all(): unknown[] } } } };
}) => JSON.stringify(api.daemon.db.$client.prepare("select type, payload from events").all());

const daily = { kind: "daily", at: "03:30" } as const;

describe.skipIf(!hasDocker)("backups of real databases (ADR-044)", () => {
  describe("PostgreSQL", () => {
    const password = secret("pg");
    let pg = "";
    beforeAll(async () => {
      pg = container("pg", [
        "-e",
        "POSTGRES_USER=app",
        "-e",
        `POSTGRES_PASSWORD=${password}`,
        "-e",
        "POSTGRES_DB=shop",
        // A password even from inside the container (the image trusts local logins otherwise).
        "-e",
        "POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 --auth-local=scram-sha-256",
        "postgres:16",
      ]);
      await until("postgres", () => {
        docker("exec", pg, "pg_isready", "-h", "127.0.0.1", "-U", "app");
        return true;
      });
      docker(
        "exec",
        "-e",
        `PGPASSWORD=${password}`,
        pg,
        "psql",
        "-U",
        "app",
        "-d",
        "shop",
        "-c",
        "create table items(id int primary key, name text); insert into items values (1,'violin'),(2,'cello');",
      );
    }, 120_000);

    it("encrypts a dump to this computer, never with the password on a command line, verifies it and restores it into a fresh database", async () => {
      const { api, daemon, ssh, serverId, dir } = await rig();
      const key = await api.backups.createKey({ name: "offsite" });
      expect(key.publicKey).toMatch(/^age1/);
      const plan = await api.backups.createPlan({
        name: "Shop DB",
        target: {
          serverId,
          kind: "postgres",
          container: pg,
          // Over TCP inside the container, so the password is asked for.
          host: "127.0.0.1",
          port: null,
          database: "shop",
          user: "app",
          path: null,
        },
        schedule: daily,
        destination: { kind: "local", folder: join(dir, "out") },
        retention: { count: 5, days: null },
        keyId: key.id,
        enabled: true,
        password,
      });
      expect(plan).toMatchObject({ hasPassword: true, enabled: true });
      expect(JSON.stringify(plan)).not.toContain(password);

      const {
        result: run,
        seen,
        looks,
      } = await watchArgv(password, async () => {
        const { runId } = await api.backups.run({ id: plan.id });
        return settle(api, runId);
      });
      expect(run).toMatchObject({ state: "ok", error: null, location: "this computer" });
      expect(looks).toBeGreaterThan(5);
      // Not on any command line while it ran, nor in what was sent over SSH, nor in the events.
      expect(seen).toEqual([]);
      expect(ssh.commands.join("\n")).not.toContain(password);
      expect(ssh.commands.join("\n")).toContain(pg);
      expect(eventsText({ daemon })).not.toContain(password);

      // The file: encrypted (age's header), only mine, the checksum recorded.
      expect(run.path).toMatch(/shop\.sql\.zst\.age$/);
      const bytes = readFileSync(run.path as string);
      expect(bytes.subarray(0, 21).toString()).toBe("age-encryption.org/v1");
      expect(bytes.toString("latin1")).not.toContain("violin");
      expect(run.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(run.size).toBe(bytes.length);
      expect(readdirSync(join(run.path as string, "..")).some((f) => f.endsWith(".part"))).toBe(
        false,
      );

      const verified = await api.backups.verify({ runId: run.id });
      expect(verified).toMatchObject({ verifyOk: true });
      expect(verified.verifyNote).toMatch(/of a PostgreSQL dump, complete/);

      // Into a fresh database, in another container, with its own password.
      const other = secret("pg2");
      const pg2 = container("pg2", [
        "-e",
        "POSTGRES_USER=app",
        "-e",
        `POSTGRES_PASSWORD=${other}`,
        "-e",
        "POSTGRES_DB=postgres",
        "-e",
        "POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 --auth-local=scram-sha-256",
        "postgres:16",
      ]);
      await until("postgres 2", () => {
        docker("exec", pg2, "pg_isready", "-h", "127.0.0.1", "-U", "app");
        return true;
      });
      const target = { ...plan.target, container: pg2, database: "restored" };
      const preview = await api.backups.prepareRestore({
        runId: run.id,
        target,
        password: other,
      });
      expect(preview.summary).toMatch(
        /Replace the database "restored" in the container .* on db-box/,
      );
      expect(preview.confirmWord).toBe("restored");
      // The second step wants the word: without it, nothing happens.
      await expect(api.backups.restore({ token: preview.token, confirm: "yes" })).rejects.toThrow(
        /Type "restored"/,
      );
      const again = await api.backups.prepareRestore({ runId: run.id, target, password: other });
      const { seen: seenRestore } = await watchArgv(other, () =>
        api.backups.restore({ token: again.token, confirm: "restored" }),
      );
      expect(seenRestore).toEqual([]);
      expect(
        docker(
          "exec",
          "-e",
          `PGPASSWORD=${other}`,
          pg2,
          "psql",
          "-U",
          "app",
          "-d",
          "restored",
          "-tAc",
          "select name from items order by id",
        ),
      ).toBe("violin\ncello");
      // A token is good once.
      await expect(
        api.backups.restore({ token: again.token, confirm: "restored" }),
      ).rejects.toThrow(/in time/);
    }, 180_000);

    it("says what went wrong in plain words, notifies, and leaves no file behind", async () => {
      const { api, daemon, fake, serverId, dir } = await rig();
      const wrong = secret("wrong");
      const plan = await api.backups.createPlan({
        name: "Wrong password",
        target: {
          serverId,
          kind: "postgres",
          container: pg,
          host: "127.0.0.1",
          port: null,
          database: "shop",
          user: "app",
          path: null,
        },
        schedule: daily,
        destination: { kind: "local", folder: join(dir, "out") },
        retention: { count: null, days: null },
        keyId: null,
        enabled: true,
        password: wrong,
      });
      const { runId } = await api.backups.run({ id: plan.id });
      const run = await settle(api, runId);
      expect(run.state).toBe("failed");
      expect(run.error).toBe(
        'PostgreSQL refused the login of "app": check the user and password in the plan.',
      );
      expect(eventsText({ daemon })).not.toContain(wrong);
      await until("notification", () =>
        fake.sent.some((s) => s.n.title === "Backup failed: Wrong password"),
      );
      const folder = join(dir, "out");
      const files = existsSync(folder)
        ? readdirSync(folder, { recursive: true }).filter((f) => String(f).includes("."))
        : [];
      expect(files).toEqual([]);

      // A container that isn't there.
      await api.backups.updatePlan({
        id: plan.id,
        target: { ...plan.target, container: "no-such-thing-here" },
      });
      const gone = await settle(api, (await api.backups.run({ id: plan.id })).runId);
      expect(gone.error).toBe('There\'s no container named "no-such-thing-here" on db-box.');
    }, 120_000);
  });

  it("MariaDB: streamed to another server over its SSH, kept by count there", async () => {
    const password = secret("maria");
    const db = container("maria", [
      "-e",
      `MARIADB_ROOT_PASSWORD=${secret("root")}`,
      "-e",
      "MARIADB_DATABASE=shop",
      "-e",
      "MARIADB_USER=app",
      "-e",
      `MARIADB_PASSWORD=${password}`,
      "mariadb:11",
    ]);
    const dest = await sshdContainer();
    await until(
      "mariadb",
      () => logs(db).includes("ready for connections") && /port: 3306/.test(logs(db)),
    );
    await until("mariadb tcp", () => {
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
        "create table if not exists items(id int primary key, name text); replace into items values (1,'violin'),(2,'cello');",
      );
      return true;
    });
    const { api, daemon, serverId } = await rig();
    const destServer = await api.servers.add({
      name: "storage-box",
      host: "127.0.0.1",
      port: dest.port,
      user: dest.user,
      password: dest.password,
    });
    const plan = await api.backups.createPlan({
      name: "Shop (MariaDB)",
      target: {
        serverId,
        kind: "mysql",
        container: db,
        host: "127.0.0.1",
        port: 3306,
        database: "shop",
        user: "app",
        path: null,
      },
      schedule: { kind: "hourly", minute: 5 },
      destination: { kind: "server", serverId: destServer.id, folder: "~/backups" },
      retention: { count: 2, days: null },
      keyId: null,
      enabled: true,
      password,
    });
    const runs: BackupRunView[] = [];
    for (let i = 0; i < 3; i++) {
      const { result, seen } = await watchArgv(password, async () =>
        settle(api, (await api.backups.run({ id: plan.id })).runId),
      );
      expect(seen).toEqual([]);
      expect(result).toMatchObject({ state: "ok", location: "storage-box" });
      runs.push(result);
      // A second apart: each its own file.
      await new Promise((r) => setTimeout(r, 1100));
    }
    expect(eventsText({ daemon })).not.toContain(password);
    const listed = docker("exec", dest.name, "sh", "-c", "ls /home/me/backups/*/");
    // Retention: the oldest is gone from the server, the two newest stay.
    expect(listed.split("\n").filter(Boolean)).toHaveLength(2);
    expect(listed).toContain(String(runs[2]?.path).split("/").pop());
    expect(listed).not.toContain(String(runs[0]?.path).split("/").pop());
    const all = await api.backups.runs({ planId: plan.id });
    expect(all.find((r) => r.id === runs[0]?.id)?.prunedAt).not.toBeNull();
    // Only the login's own.
    expect(
      docker(
        "exec",
        dest.name,
        "stat",
        "-c",
        "%a",
        runs[2]?.path?.replace(/^backups/, "/home/me/backups") as string,
      ),
    ).toBe("600");

    const v = await api.backups.verify({ runId: runs[2]?.id as string });
    expect(v.verifyNote).toMatch(/of a MariaDB dump, complete/);
    expect(v.verifyOk).toBe(true);
    // A pruned one can't be verified or restored.
    await expect(api.backups.prepareRestore({ runId: runs[0]?.id as string })).rejects.toThrow(
      /isn't kept/,
    );
    // A row lost, then the database itself restored, with the plan's own password.
    const sql = (q: string) =>
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
        "-N",
        "-e",
        q,
      );
    sql("delete from items where id=2");
    expect(sql("select count(*) from items")).toBe("1");
    const p = await api.backups.prepareRestore({ runId: runs[2]?.id as string });
    expect(p.confirmWord).toBe("shop");
    const { seen: seenRestore } = await watchArgv(password, () =>
      api.backups.restore({ token: p.token, confirm: "shop" }),
    );
    expect(seenRestore).toEqual([]);
    expect(sql("select name from items order by id")).toBe("violin\ncello");
  }, 240_000);

  it("MongoDB: an archive, verified, restored into a fresh container", async () => {
    const password = secret("mongo");
    const start = (name: string) => {
      const c = container(name, [
        "-e",
        "MONGO_INITDB_ROOT_USERNAME=root",
        "-e",
        `MONGO_INITDB_ROOT_PASSWORD=${password}`,
        "mongo:7",
      ]);
      return c;
    };
    const m1 = start("mongo");
    const m2 = start("mongo2");
    for (const m of [m1, m2])
      await until(
        "mongo",
        () =>
          logs(m).includes("MongoDB init process complete") &&
          /Waiting for connections[\s\S]*Waiting for connections/.test(logs(m)),
        120_000,
      );
    docker(
      "exec",
      m1,
      "mongosh",
      "--quiet",
      "-u",
      "root",
      "-p",
      password,
      "--authenticationDatabase",
      "admin",
      "shop",
      "--eval",
      'db.items.insertMany([{n:"violin"},{n:"cello"}])',
    );
    const { api, serverId, dir } = await rig();
    const key = await api.backups.createKey({ name: "k" });
    const plan = await api.backups.createPlan({
      name: "Mongo shop",
      target: {
        serverId,
        kind: "mongodb",
        container: m1,
        host: null,
        port: null,
        database: "shop",
        user: "root",
        path: null,
      },
      schedule: daily,
      destination: { kind: "local", folder: join(dir, "out") },
      retention: { count: null, days: 30 },
      keyId: key.id,
      enabled: true,
      password,
    });
    const { result: run, seen } = await watchArgv(password, async () =>
      settle(api, (await api.backups.run({ id: plan.id })).runId),
    );
    expect(seen).toEqual([]);
    expect(run).toMatchObject({ state: "ok" });
    expect((await api.backups.verify({ runId: run.id })).verifyNote).toMatch(
      /MongoDB archive, complete/,
    );
    // No password file left in the container.
    expect(docker("exec", m1, "sh", "-c", "grep -rl 'password:' /tmp 2>/dev/null || true")).toBe(
      "",
    );
    const target = { ...plan.target, container: m2 };
    const p = await api.backups.prepareRestore({ runId: run.id, target, password });
    await api.backups.restore({ token: p.token, confirm: "shop" });
    expect(
      docker(
        "exec",
        m2,
        "mongosh",
        "--quiet",
        "-u",
        "root",
        "-p",
        password,
        "--authenticationDatabase",
        "admin",
        "shop",
        "--eval",
        "db.items.countDocuments()",
      ),
    ).toBe("2");
  }, 300_000);

  it("Redis: BGSAVE and its RDB file, restored into a fresh container that comes back with it", async () => {
    const password = secret("redis");
    const r1 = container("redis", ["redis:7-alpine", "redis-server", "--requirepass", password]);
    const r2 = container("redis2", ["redis:7-alpine", "redis-server", "--requirepass", password]);
    for (const r of [r1, r2])
      await until("redis", () => logs(r).includes("Ready to accept connections"));
    docker("exec", "-e", `REDISCLI_AUTH=${password}`, r1, "redis-cli", "set", "greeting", "hello");
    const { api, serverId, dir } = await rig();
    const plan = await api.backups.createPlan({
      name: "Cache",
      target: {
        serverId,
        kind: "redis",
        container: r1,
        host: null,
        port: null,
        database: null,
        user: null,
        path: null,
      },
      schedule: daily,
      destination: { kind: "local", folder: join(dir, "out") },
      retention: { count: 3, days: null },
      keyId: null,
      enabled: true,
      password,
    });
    // The password is on redis-server's own command line (this test started it so): look for another.
    const run = await settle(api, (await api.backups.run({ id: plan.id })).runId);
    expect(run).toMatchObject({ state: "ok" });
    expect(run.path).toMatch(/all\.rdb\.zst$/);
    expect((await api.backups.verify({ runId: run.id })).verifyNote).toMatch(/Redis RDB file/);
    const p = await api.backups.prepareRestore({
      runId: run.id,
      target: { ...plan.target, container: r2 },
      password,
    });
    expect(p.summary).toMatch(/Redis stops and starts again/);
    expect(p.confirmWord).toBe("db-box");
    await api.backups.restore({ token: p.token, confirm: "db-box" });
    await until(
      "redis back",
      () =>
        docker("inspect", "-f", "{{.State.Running}}", r2) === "true" &&
        docker("exec", "-e", `REDISCLI_AUTH=${password}`, r2, "redis-cli", "get", "greeting") ===
          "hello",
      30_000,
    );
  }, 180_000);
});
