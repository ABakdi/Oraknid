import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerDatabases } from "@oraknid/contracts";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import { afterEach, describe, expect, it } from "vitest";
import type { Router } from "../api/router.ts";
import { readSizes, sizeCommand } from "../backups/dump.ts";
import { type Daemon, startDaemon } from "../daemon.ts";
import { openDatabase } from "../db/open.ts";
import { attempts, jobs, projects, tasks } from "../db/schema.ts";
import { EventBus } from "../events/bus.ts";
import type { EyeBrain } from "../eye/brain.ts";
import { resolvePaths } from "../paths.ts";
import { fakeOs } from "../testing/fake-os.ts";
import { fakeServerTools } from "../testing/fake-server-tools.ts";
import { fakeSsh } from "../testing/fake-ssh.ts";
import { seedJob } from "../testing/fixtures.ts";
import { refreshAfterStop, startRefreshAfterStop } from "./after-end.ts";
import { attachSizes, sqlitePaths } from "./insight.ts";

// A server not reached is stale, with its last document and readings
// (ADR-026); a job that stopped without completing refreshes its servers'
// documents too (Servers → The state document); SQLite files and sizes with
// a plan's login in the Databases tab (ADR-043).

let daemon: Daemon | undefined;
const closing: (() => unknown)[] = [];
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  for (const c of closing.splice(0).reverse()) await c();
});

async function ready(doc = (name: string) => `# ${name}`) {
  const ssh = await fakeSsh({
    password: "pw",
    path: fakeServerTools(),
    env: { ORAKNID_MONITOR_ROOT: mkdtempSync(join(tmpdir(), "oraknid-root-")) },
  });
  closing.push(ssh.close);
  const dir = mkdtempSync(join(tmpdir(), "oraknid-stale-"));
  closing.push(() => rmSync(dir, { recursive: true, force: true }));
  let now = Date.parse("2026-10-07T12:00:00Z");
  const brain = {
    serverState: async (i: { name: string }) => ({ document: doc(i.name) }),
  } as unknown as EyeBrain;
  daemon = await startDaemon({
    paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
    port: 0,
    dbFile: ":memory:",
    os: fakeOs({ keychain: true }).os,
    adapters: {},
    brain,
    now: () => now,
    serverSampleSec: 3600,
  });
  const api = createORPCClient<RouterClient<Router>>(
    new RPCLink({
      url: `${daemon.url}/api`,
      headers: { authorization: `Bearer ${daemon.cliToken}` },
    }),
  );
  const s = await api.servers.add({
    name: "shop",
    host: "127.0.0.1",
    port: ssh.port,
    user: "me",
    description: "",
    password: "pw",
  });
  await api.servers.setup({ id: s.id });
  await daemon.servers.sampleAll();
  return { api, ssh, id: s.id, d: daemon, tick: (ms: number) => (now += ms) };
}

describe("a server not reached (ADR-026)", () => {
  it("is marked stale, keeping its last document and readings", async () => {
    const { api, ssh, id, d, tick } = await ready();
    const view = async () => {
      const v = (await api.servers.list()).find((x) => x.id === id);
      if (!v) throw new Error("no server");
      return v;
    };
    const before = await view();
    expect(before.stale).toBe(false);
    expect(before.latest).not.toBeNull();
    const events: string[] = [];
    d.bus.subscribe((e) => events.push(e.type));

    await ssh.close();
    tick(60_000);
    await d.servers.sampleAll(); // the open connection fails: dropped
    tick(60_000);
    await d.servers.sampleAll(); // connecting fails: an error, stale
    const v = await view();
    expect(v.stale).toBe(true);
    expect(v.error).toBeTruthy();
    expect(v.latest).toEqual(before.latest);
    expect(v.stateVersion).toBe(1);
    expect((await api.servers.state({ id }))?.body).toBe("# shop");
    expect(events.filter((e) => e === "server.stale")).toHaveLength(1);
    await d.servers.sampleAll();
    expect(events.filter((e) => e === "server.stale")).toHaveLength(1);

    // No reading for long, even without an error: stale too.
    const row = d.servers.row(id);
    const at = Date.parse("2026-10-07T12:02:00Z");
    // Readings every hour here: three missed rounds make it stale.
    expect(d.servers.isStale({ ...row, error: null, lastSeenAt: at - 4 * 3_600_000 })).toBe(true);
    expect(d.servers.isStale({ ...row, error: null, lastSeenAt: at - 60_000 })).toBe(false);
  }, 120_000);
});

describe("SQLite files and database sizes (ADR-043)", () => {
  it("lists the SQLite files the state document names, sized", async () => {
    const home: { dir: string } = { dir: "" };
    const { api, id, ssh } = await ready(
      (name) =>
        `# ${name}\n\nThe app keeps its data in \`${home.dir}/app/data.db\` and logs in /var/log/app.\n`,
    );
    home.dir = ssh.home;
    mkdirSync(join(ssh.home, "app"), { recursive: true });
    writeFileSync(join(ssh.home, "app", "data.db"), Buffer.alloc(4096));
    await api.servers.discover({ id });
    const dbs = await api.servers.databases({ id, fresh: true });
    expect(dbs.data.databases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "sqlite",
          source: "file",
          name: join(ssh.home, "app", "data.db"),
          sizeBytes: 4096,
        }),
      ]),
    );
  }, 120_000);

  it("finds paths, and puts a plan's sizes on the database it reaches", () => {
    expect(
      sqlitePaths("Files: `/srv/app/db.sqlite3`, /var/lib/x/state.db; not /proc/1/x.db or ../a.db"),
    ).toEqual(["/srv/app/db.sqlite3", "/var/lib/x/state.db"]);
    const data: ServerDatabases = {
      databases: [
        {
          kind: "postgres",
          name: "db",
          source: "container",
          version: "16",
          state: "running",
          port: null,
          sizeBytes: null,
          note: null,
          login: null,
          sizes: null,
        },
      ],
      notes: [],
    };
    const files = attachSizes(data, [
      {
        plan: "shop db",
        target: { kind: "postgres", container: "db", port: null, path: null },
        databases: [
          { name: "shop", bytes: 1000 },
          { name: "postgres", bytes: 24 },
        ],
        error: null,
      },
      {
        plan: "other",
        target: { kind: "mysql", container: null, port: 3306, path: null },
        databases: [],
        error: "The login was refused.",
      },
      {
        plan: "notes",
        target: { kind: "sqlite", container: null, port: null, path: "/srv/notes.db" },
        databases: [],
        error: null,
      },
    ]);
    expect(files).toEqual(["/srv/notes.db"]);
    expect(data.databases[0]?.sizeBytes).toBe(1024);
    expect(data.databases[0]?.sizes?.plan).toBe("shop db");
    expect(data.notes[0]).toMatch(
      /"other" reaches a database not found here: The login was refused/,
    );
  });

  it("reads sizes with the password on stdin, never on the command line", () => {
    const t = {
      serverId: ulid(),
      kind: "postgres" as const,
      container: "db",
      host: null,
      port: null,
      database: null,
      user: "app",
      path: null,
    };
    const cmd = sizeCommand(t) as string;
    expect(cmd).toContain("pg_database_size");
    expect(cmd).toContain("read -r ORAKNID_S");
    expect(cmd).toContain("-e PGPASSWORD");
    expect(sizeCommand({ ...t, kind: "redis" })).toBeNull();
    expect(readSizes("shop\t1000\npostgres\t24\n\nbad\n")).toEqual([
      { name: "shop", bytes: 1000 },
      { name: "postgres", bytes: 24 },
    ]);
  });
});

describe("a job that stopped without completing (Servers → The state document)", () => {
  it("refreshes its servers' documents when something ran, once per stop", async () => {
    const db = await openDatabase({ file: ":memory:" });
    const bus = new EventBus(db);
    const jobId = seedJob(db, "running");
    const job = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    const serverId = ulid();
    db.update(projects)
      .set({ serverIds: [serverId], serverId })
      .where(eq(projects.id, job?.projectId as string))
      .run();
    const task = (id: string, kind: string, title: string) =>
      db
        .insert(tasks)
        .values({
          id,
          jobId,
          title,
          instructions: "",
          kind,
          scope: [],
          verify: [],
          requiredCapabilities: [],
          difficulty: "low",
          state: kind === "research" ? "done" : "failed",
        })
        .run();
    task("T1", "research", "Look at nginx");
    task("T2", "code", "Install fail2ban");
    const calls: { id: string; since?: string; job?: unknown }[] = [];
    const servers = {
      discover: async (id: string, since?: string, job?: unknown) => {
        calls.push({ id, ...(since ? { since } : {}), job });
        return {} as never;
      },
    };
    const attempt = (taskId: string, at: number) =>
      db
        .insert(attempts)
        .values({
          id: ulid(),
          taskId,
          jobId,
          legId: "L",
          legModelId: "M",
          startedAt: at,
          escalations: [],
        })
        .run();
    // Only a research task ran: nothing changed there.
    attempt("T1", 10);
    let now = 100;
    expect(
      await refreshAfterStop({ db, bus, servers, now: () => now }, jobId, "failed"),
    ).toBeNull();

    attempt("T2", 20);
    const off = startRefreshAfterStop({ db, bus, servers, now: () => now });
    bus.publish({
      type: "job.state",
      topic: `job:${jobId}`,
      jobId,
      payload: { from: "running", to: "blocked", reason: '"Install fail2ban" failed 3 attempts.' },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.since).toMatch(/stopped on a failure/);
    expect(calls[0]?.since).toContain("Install fail2ban (not finished: failed)");
    expect(calls[0]?.job).toMatchObject({
      id: jobId,
      changes: ["Install fail2ban (not finished: failed)"],
    });

    // Waiting for quota is no failure; cancelling with nothing new run does nothing.
    bus.publish({
      type: "job.state",
      topic: `job:${jobId}`,
      jobId,
      payload: { from: "running", to: "blocked", reason: "Claude is out of quota until 18:00." },
    });
    now = 200;
    bus.publish({
      type: "job.state",
      topic: `job:${jobId}`,
      jobId,
      payload: { from: "blocked", to: "cancelled", reason: "" },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(1);

    // Resumed, it ran again, then was cancelled: refreshed again.
    attempt("T2", 150);
    bus.publish({
      type: "job.state",
      topic: `job:${jobId}`,
      jobId,
      payload: { from: "running", to: "cancelled", reason: "" },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(2);
    expect(calls[1]?.since).toMatch(/was cancelled/);
    off();
  });
});
