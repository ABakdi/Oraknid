import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sandbox, SandboxSpec } from "@oraknid/os";
import { eq } from "drizzle-orm";
import type { Client } from "ssh2";
import { afterEach, describe, expect, it } from "vitest";
import { type Db, openDatabase } from "../db/open.ts";
import { events, jobs, projectSecrets, projects, servers } from "../db/schema.ts";
import { EventBus } from "../events/bus.ts";
import { withEnv } from "../legs/supervisor.ts";
import { Secrets } from "../os/secrets.ts";
import type { Servers } from "../servers/service.ts";
import { connect } from "../servers/ssh.ts";
import { fakeOs } from "../testing/fake-os.ts";
import { fakeSsh } from "../testing/fake-ssh.ts";
import { seedJob } from "../testing/fixtures.ts";
import { parseDotEnv, toDotEnv } from "./dotenv.ts";
import { envFilePath, ProjectSecrets, refusedName, secretKey } from "./service.ts";
import { envCall, envTool } from "./tool.ts";

// A project's secrets per environment (ADR-059): kept in the keychain,
// never read back, given only to its own jobs, written on its servers by
// Oraknid with the values on stdin, and never in an event.

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "oraknid-secrets-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const db = await openDatabase({ file: ":memory:", backupsDir: join(dir, "b") });
  const bus = new EventBus(db, Date.now);
  const keychain = fakeOs({ keychain: true }).os.keychain;
  const secrets = new Secrets(dir, keychain);
  await secrets.init();
  const service = new ProjectSecrets({ db, bus, secrets });
  return { db, bus, secrets, service, dir };
}

const projectOf = (db: Db, jobId: string) =>
  (db.select().from(jobs).where(eq(jobs.id, jobId)).get() as { projectId: string }).projectId;

const allEvents = (db: Db) => JSON.stringify(db.select().from(events).all());

const VALUE = "sk-live-0123456789abcdefSECRET";

describe("project secrets (ADR-059)", () => {
  it("keeps a value in the keychain only, lists it masked, replaces it, and audits names only", async () => {
    const { db, service, secrets } = await setup();
    const projectId = projectOf(db, seedJob(db));
    const set = await service.set({
      projectId,
      environment: "dev",
      name: "STRIPE_KEY",
      value: VALUE,
    });
    expect(set.masked).toBe("••••••••");
    expect(JSON.stringify(set)).not.toContain(VALUE);
    expect(await secrets.get(secretKey(set.id))).toBe(VALUE);
    // The row holds no value.
    expect(JSON.stringify(db.select().from(projectSecrets).all())).not.toContain(VALUE);
    const list = service.list(projectId);
    expect(list.defaultEnvironment).toBe("dev");
    expect(list.secrets.map((s) => [s.environment, s.name])).toEqual([["dev", "STRIPE_KEY"]]);
    expect(JSON.stringify(list)).not.toContain(VALUE);

    await service.set({ projectId, environment: "dev", name: "STRIPE_KEY", value: "second-value" });
    expect(service.list(projectId).secrets).toHaveLength(1);
    expect(await secrets.get(secretKey(set.id))).toBe("second-value");
    const audit = db.select().from(events).where(eq(events.type, "project.secret.set")).all();
    expect(audit.map((e) => (e.payload as { replaced: boolean }).replaced)).toEqual([false, true]);
    expect(allEvents(db)).not.toContain(VALUE);
    expect(allEvents(db)).not.toContain("second-value");

    await service.remove(set.id);
    expect(service.list(projectId).secrets).toEqual([]);
    expect(await secrets.get(secretKey(set.id))).toBeUndefined();
    expect(
      db.select().from(events).where(eq(events.type, "project.secret.removed")).all(),
    ).toHaveLength(1);
  });

  it("refuses names Oraknid sets itself, and names that aren't variables", async () => {
    const { db, service } = await setup();
    const projectId = projectOf(db, seedJob(db));
    for (const name of ["PATH", "HOME", "ORAKNID_TOKEN", "CLAUDE_CONFIG_DIR", "GIT_DIR"])
      await expect(
        service.set({ projectId, environment: "dev", name, value: "x" }),
      ).rejects.toThrow(/set by Oraknid/);
    expect(refusedName("lower")).toMatch(/environment variable/);
    expect(refusedName("DATABASE_URL")).toBeNull();
  });

  it("reads a pasted .env: export, quotes, comments, lines it can't read said by number", async () => {
    const { db, service, secrets } = await setup();
    const projectId = projectOf(db, seedJob(db));
    const text = [
      "# a comment",
      "export API_KEY=abc123",
      'DATABASE_URL="postgres://u:p@h/db" # inline',
      "SINGLE='it''s'",
      'MULTI="line one',
      'line two"',
      "PLAIN=value # comment",
      "not a line",
      "PATH=/evil",
      "EMPTY=",
    ].join("\n");
    const r = await service.importDotEnv({ projectId, environment: "testing", text });
    expect(r.set).toEqual(["API_KEY", "DATABASE_URL", "SINGLE", "MULTI", "PLAIN"]);
    expect(r.skipped.map((s) => s.line)).toEqual([8, 9, 10]);
    expect(JSON.stringify(r)).not.toContain("/evil");
    const values = await service.values(projectId, "testing");
    expect(values).toEqual({
      API_KEY: "abc123",
      DATABASE_URL: "postgres://u:p@h/db",
      SINGLE: "it",
      MULTI: "line one\nline two",
      PLAIN: "value",
    });
    expect([...secrets.known()]).toContain("abc123");
    // Written back as a file and read again, the same values.
    expect(
      Object.fromEntries(parseDotEnv(toDotEnv(values)).entries.map((e) => [e.name, e.value])),
    ).toEqual(values);
  });

  it("gives a job only its own project's secrets of its environment, said by name", async () => {
    const { db, service, secrets } = await setup();
    const jobA = seedJob(db);
    const jobB = seedJob(db);
    const a = projectOf(db, jobA);
    const b = projectOf(db, jobB);
    await service.set({ projectId: a, environment: "dev", name: "TOKEN", value: "a-dev-value" });
    await service.set({
      projectId: a,
      environment: "production",
      name: "TOKEN",
      value: "a-prod-value",
    });
    await service.set({ projectId: b, environment: "dev", name: "OTHER", value: "b-dev-value" });

    expect(await service.envForJob(jobA)).toEqual({ TOKEN: "a-dev-value" });
    expect(await service.envForJob(jobB)).toEqual({ OTHER: "b-dev-value" });
    // The project's default, then the job's own.
    service.setDefaultEnvironment(a, "production");
    expect(await service.envForJob(jobA)).toEqual({ TOKEN: "a-prod-value" });
    service.setJobEnvironment(jobA, "testing");
    expect(await service.envForJob(jobA)).toEqual({});
    expect([...secrets.known()]).toEqual(
      expect.arrayContaining(["a-dev-value", "a-prod-value", "b-dev-value"]),
    );
    const used = db.select().from(events).where(eq(events.type, "project.secrets.used")).all();
    expect(used.map((e) => [e.jobId, e.payload])).toEqual([
      [jobA, { environment: "dev", names: ["TOKEN"] }],
      [jobB, { environment: "dev", names: ["OTHER"] }],
      [jobA, { environment: "production", names: ["TOKEN"] }],
    ]);
    expect(allEvents(db)).not.toMatch(/a-dev-value|a-prod-value|b-dev-value/);
  });

  it("sets a job's secrets in its sandbox's environment, under the adapter's own variables", () => {
    const seen: SandboxSpec[] = [];
    const sandbox: Sandbox = {
      status: () => ({ available: true, detail: "" }),
      wrap: (spec) => {
        seen.push(spec);
        return { command: "bwrap", args: [] };
      },
    };
    const plan = { sandbox, home: "/h", writable: [], readonly: [], env: { PATH: "/usr/bin" } };
    const wrapped = withEnv(plan, { API_KEY: "v", PATH: "/not-this" });
    wrapped.sandbox.wrap({
      command: "x",
      args: [],
      cwd: "/w",
      writable: [],
      readonly: [],
      home: "/h",
      env: { PATH: "/usr/bin", HOME: "/h" },
    });
    expect(seen[0]?.env).toEqual({ API_KEY: "v", PATH: "/usr/bin", HOME: "/h" });
    expect(withEnv(plan, {})).toBe(plan);
  });

  it("removes a deleted project's secrets with it", async () => {
    const { db, bus, service, secrets } = await setup();
    const projectId = projectOf(db, seedJob(db));
    const s = await service.set({ projectId, environment: "dev", name: "K", value: "gone-value" });
    bus.publish({
      type: "project.deleted",
      topic: "overview",
      jobId: null,
      payload: { id: projectId },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(db.select().from(projectSecrets).all()).toEqual([]);
    expect(await secrets.get(secretKey(s.id))).toBeUndefined();
  });

  it("checks env file paths", () => {
    expect(envFilePath("~/app/.env")).toBe("app/.env");
    expect(envFilePath("/srv/app/.env")).toBe("/srv/app/.env");
    expect(() => envFilePath("/srv/../etc/passwd")).toThrow(/\.\./);
    expect(() => envFilePath("~root/.env")).toThrow();
    expect(() => envFilePath("/srv/app/")).toThrow(/folder/);
    expect(() => envFilePath("a\nb")).toThrow(/control/);
  });

  it("writes an env file on the job's server: 0600, values on stdin only, names in the audit", async () => {
    const { db, service } = await setup();
    const ssh = await fakeSsh({ password: "pw" });
    cleanup.push(() => rmSync(ssh.home, { recursive: true, force: true }));
    cleanup.push(ssh.close);
    const clients: Client[] = [];
    cleanup.push(() => {
      for (const c of clients) c.end();
    });
    db.insert(servers)
      .values([
        {
          id: "srv1",
          name: "VPS",
          host: "127.0.0.1",
          port: ssh.port,
          user: "me",
          description: "",
          auth: "password",
          setup: "ready",
          createdAt: 0,
        },
        {
          id: "srv2",
          name: "Prod",
          host: "127.0.0.1",
          port: ssh.port,
          user: "me",
          description: "",
          auth: "password",
          setup: "ready",
          production: true,
          createdAt: 0,
        },
        {
          id: "srv3",
          name: "Elsewhere",
          host: "127.0.0.1",
          port: ssh.port,
          user: "me",
          description: "",
          auth: "password",
          setup: "ready",
          createdAt: 0,
        },
      ])
      .run();
    const stub = {
      row: (id: string) => {
        const r = db.select().from(servers).where(eq(servers.id, id)).get();
        if (!r) throw new Error(`No server ${id}.`);
        return r;
      },
      isProduction: (id: string) => id === "srv2",
      client: async () => {
        const { client } = await connect({
          host: "127.0.0.1",
          port: ssh.port,
          user: "me",
          password: "pw",
          hostKey: null,
        });
        clients.push(client);
        return client;
      },
    };
    service.attachServers(stub as unknown as Servers);
    const jobId = seedJob(db);
    const projectId = projectOf(db, jobId);
    db.update(projects)
      .set({ serverIds: ["srv1", "srv2"] })
      .where(eq(projects.id, projectId))
      .run();
    const weird = 'with "quotes" $HOME `x`\nand a line';
    await service.set({ projectId, environment: "testing", name: "API_KEY", value: VALUE });
    await service.set({ projectId, environment: "testing", name: "WEIRD", value: weird });
    await service.set({
      projectId,
      environment: "production",
      name: "API_KEY",
      value: "prod-only-value",
    });
    service.setJobEnvironment(jobId, "testing");

    const said = await envCall(service, jobId, "write_env_file", {
      server: "oraknid-vps",
      path: "~/app/.env",
    });
    expect(said).toMatch(/Wrote 2 variables \(API_KEY, WEIRD\) to app\/\.env on VPS, mode 0600/);
    expect(said).not.toContain(VALUE);
    const file = join(ssh.home, "app", ".env");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const back = parseDotEnv(readFileSync(file, "utf8")).entries;
    expect(Object.fromEntries(back.map((e) => [e.name, e.value]))).toEqual({
      API_KEY: VALUE,
      WEIRD: weird,
    });
    // Never on a command line, never in an event.
    expect(ssh.commands.join("\n")).not.toContain(VALUE);
    expect(ssh.commands.join("\n")).not.toContain("quotes");
    expect(ssh.commands.some((c) => c.includes("umask 077"))).toBe(true);
    expect(allEvents(db)).not.toContain(VALUE);
    const written = db.select().from(events).where(eq(events.type, "project.secret.written")).get();
    expect(written?.payload).toMatchObject({
      server: "VPS",
      path: "app/.env",
      names: ["API_KEY", "WEIRD"],
    });

    // Production values only to a production server, and a production server only them.
    await expect(
      envCall(service, jobId, "write_env_file", {
        server: "VPS",
        path: "x.env",
        environment: "production",
      }),
    ).rejects.toThrow(/isn't production/);
    await expect(
      envCall(service, jobId, "write_env_file", { server: "Prod", path: "x.env" }),
    ).rejects.toThrow(/is production/);
    expect(
      await envCall(service, jobId, "write_env_file", { server: "Prod", path: "/tmp/../x" }).catch(
        (e: Error) => e.message,
      ),
    ).toMatch(/\.\./);
    // A server the project doesn't have.
    await expect(
      envCall(service, jobId, "write_env_file", { server: "Elsewhere", path: "x.env" }),
    ).rejects.toThrow(/isn't one of this job's servers/);
    // Listing names, never values.
    const listed = await envCall(service, jobId, "list_env", {});
    expect(listed).toBe("This job's environment is testing: API_KEY, WEIRD.");
    // The policy: a deploy for production values, an external write otherwise.
    const tool = envTool(service);
    expect(tool.judge?.({ jobId }, "write_env_file", { environment: "production" })).toBe("deploy");
    expect(tool.judge?.({ jobId }, "write_env_file", {})).toBe("external-write");
    expect(tool.judge?.({ jobId }, "list_env", {})).toBeUndefined();
  });

  it("follows a server job's server for its environment", async () => {
    const { db, service } = await setup();
    const jobId = seedJob(db);
    const projectId = projectOf(db, jobId);
    db.insert(servers)
      .values({
        id: "s1",
        name: "S",
        host: "h",
        port: 22,
        user: "u",
        description: "",
        auth: "password",
        createdAt: 0,
      })
      .run();
    db.update(projects).set({ serverId: "s1" }).where(eq(projects.id, projectId)).run();
    let prod = false;
    service.attachServers({ isProduction: () => prod } as unknown as Servers);
    expect(service.jobEnvironment(jobId)).toBe("testing");
    prod = true;
    expect(service.jobEnvironment(jobId)).toBe("production");
  });
});
