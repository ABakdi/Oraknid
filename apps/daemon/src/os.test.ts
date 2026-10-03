import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerFrame } from "@oraknid/contracts";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { Router } from "./api/router.ts";
import { type Daemon, startDaemon } from "./daemon.ts";
import { jobs, projects, skills } from "./db/schema.ts";
import { createInhibitController } from "./os/inhibit-controller.ts";
import { resolvePaths } from "./paths.ts";
import { fakeOs } from "./testing/fake-os.ts";

let daemon: Daemon | undefined;
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  vi.useRealTimers();
});

async function start(opts: { keychain?: boolean } = {}) {
  const fake = fakeOs(opts);
  const dir = mkdtempSync(join(tmpdir(), "oraknid-os-"));
  daemon = await startDaemon({
    paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
    port: 0,
    dbFile: ":memory:",
    os: fake.os,
    metricsIntervalMs: 50,
  });
  const api = createORPCClient<RouterClient<Router>>(
    new RPCLink({
      url: `${daemon.url}/api`,
      headers: { authorization: `Bearer ${daemon.cliToken}` },
    }),
  );
  return { d: daemon, api, ...fake };
}

const ULID = (n: number) => `01J9Z3K8W2Q4V6X8Y0A1B2C3D${n}`;

function insertJob(d: Daemon, state: string) {
  d.db
    .insert(projects)
    .values({
      id: ULID(1),
      name: "p",
      workspacePath: "/tmp/p",
      isGitRepo: true,
      releaseBranch: "main",
      workBranch: "dev",
      createdAt: 0,
    })
    .onConflictDoNothing()
    .run();
  d.db
    .insert(skills)
    .values({
      id: ULID(2),
      version: 1,
      name: "s",
      description: "",
      source: "built-in",
      body: "",
      interview: false,
      requiredTools: [],
      verify: [],
      createdAt: 0,
    })
    .onConflictDoNothing()
    .run();
  d.db
    .insert(jobs)
    .values({
      id: ULID(3),
      projectId: ULID(1),
      title: "t",
      goal: "g",
      inputs: [],
      skillId: ULID(2),
      skillVersion: 1,
      autonomy: "standard",
      allowedLegIds: [],
      budget: {
        tokens: null,
        quotaShare: null,
        wallClockMs: null,
        money: { limit: 0, hard: true },
      },
      state,
      createdAt: 0,
    })
    .run();
}

describe("sleep inhibition (BR-11)", () => {
  it("holds the lock while a job is active and releases it after the grace period", async () => {
    vi.useFakeTimers();
    let active = 0;
    const { inhibitor } = fakeOs();
    const c = createInhibitController({
      inhibitor,
      activeJobs: () => active,
      releaseAfterMs: 45_000,
    });

    expect((await c.reconcile()).held).toBe(false);
    active = 2;
    expect((await c.reconcile()).why).toBe("2 jobs running");
    active = 0;
    await c.reconcile();
    await vi.advanceTimersByTimeAsync(44_000);
    expect(inhibitor.state().held).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(inhibitor.state().held).toBe(false);
    await c.stop();
  });

  it("does not release if a job becomes active again during the grace period", async () => {
    vi.useFakeTimers();
    let active = 1;
    const { inhibitor } = fakeOs();
    const c = createInhibitController({
      inhibitor,
      activeJobs: () => active,
      releaseAfterMs: 45_000,
    });
    await c.reconcile();
    active = 0;
    await c.reconcile();
    await vi.advanceTimersByTimeAsync(20_000);
    active = 1;
    await c.reconcile();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(inhibitor.state().held).toBe(true);
    await c.stop();
  });

  it("the daemon takes the lock when a job.state event shows an active job", async () => {
    const { d, inhibitor } = await start();
    insertJob(d, "running");
    d.bus.publish({
      type: "job.state",
      topic: `job:${ULID(3)}`,
      jobId: ULID(3),
      payload: "running",
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(inhibitor.calls).toContain("acquire:1 job running");
    expect(d.bus.since(0, ["overview"], 100).map((e) => e.type)).toContain("system.inhibitor");
  });
});

describe("system status", () => {
  it("reports the inhibitor, secrets, sandbox and service", async () => {
    const { api } = await start();
    const s = await api.system.status();
    expect(s.inhibitor.held).toBe(false);
    expect(s.secrets.kind).toBe("none");
    expect(s.sandbox.available).toBe(true);
    expect(s.service.fix).toMatch(/oraknid install/);
  });
});

describe("secrets", () => {
  it("stays locked without a keychain until unlocked with a passphrase", async () => {
    const { api } = await start({ keychain: false });
    await expect(api.secrets.unlock({ passphrase: "short" })).rejects.toThrow(/at least 8/);
    const s = await api.secrets.unlock({ passphrase: "correct horse battery" });
    expect(s.kind).toBe("encrypted-file");
    expect((await api.system.status()).secrets.available).toBe(true);
  });

  it("uses the keychain directly when it answers", async () => {
    const { api } = await start({ keychain: true });
    expect((await api.system.status()).secrets.kind).toBe("keychain");
  });
});

describe("notifications", () => {
  it("will not turn email on before the server is set up", async () => {
    const { api } = await start();
    await expect(api.notifications.update({ email: true })).rejects.toThrow(/email server/);
  });

  it("sends a test to every enabled channel and explains the ones that cannot send", async () => {
    const { api, sent } = await start({ keychain: false });
    const results = await api.notifications.test({});
    expect(results.find((r) => r.channel === "desktop")).toMatchObject({ delivered: 1 });
    expect(results.find((r) => r.channel === "email")).toMatchObject({ enabled: false });
    const push = results.find((r) => r.channel === "push");
    expect(push?.delivered).toBe(0);
    expect(push?.problems[0]).toMatch(/secret store/);
    expect(sent.map((s) => s.channel)).toEqual(["desktop"]);
  });

  it("keeps the SMTP password in the secret store, not in settings", async () => {
    const { api, store, d } = await start({ keychain: true });
    await api.notifications.configureEmail({
      server: {
        host: "smtp.example.com",
        port: 465,
        secure: true,
        user: "me",
        from: "o@example.com",
        to: "me@example.com",
      },
      password: "app-password",
    });
    expect(store.get("smtp.password")).toBe("app-password");
    const rows = d.db.$client.prepare("select value from settings").all() as { value: string }[];
    expect(rows.map((r) => r.value).join()).not.toContain("app-password");
    expect((await api.notifications.get()).email.enabled).toBe(true);
  });

  it("creates VAPID keys once; new keys drop old subscriptions", async () => {
    const { api, d, store } = await start({ keychain: true });
    const key = await api.notifications.vapidPublicKey();
    expect(await api.notifications.vapidPublicKey()).toBe(key);
    await api.notifications.subscribe({
      endpoint: "https://fcm.googleapis.com/fcm/send/abc",
      keys: { p256dh: "p", auth: "a" },
    });
    expect(d.db.$client.prepare("select count(*) n from push_subscriptions").get()).toEqual({
      n: 1,
    });
    store.delete("vapid.private");
    expect(await api.notifications.vapidPublicKey()).not.toBe(key);
    expect(d.db.$client.prepare("select count(*) n from push_subscriptions").get()).toEqual({
      n: 0,
    });
  });
});

describe("metrics", () => {
  it("streams samples to metrics subscribers and keeps recent ones", async () => {
    const { d, api } = await start();
    const ws = new WebSocket(`${d.url.replace("http", "ws")}/live?token=${d.cliToken}`);
    const frames: ServerFrame[] = [];
    ws.on("message", (m) => frames.push(JSON.parse(m.toString())));
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify({ type: "subscribe", topics: ["metrics"] }));
    await new Promise((r) => setTimeout(r, 200));
    ws.close();
    const metrics = frames.filter((f) => f.type === "metrics");
    expect(metrics.length).toBeGreaterThan(0);
    const recent = await api.metrics.recent({ since: 0 });
    expect(recent.length).toBeGreaterThan(0);
    expect(recent[0]?.processes[0]?.id).toBe("daemon");
    // Metrics never enter the event log.
    expect(d.bus.since(0, ["metrics"], 10)).toEqual([]);
  });
});

describe("jobs over the API", () => {
  it("pauses, resumes and cancels, refusing illegal moves in plain words", async () => {
    const { d, api } = await start();
    const { seedJob } = await import("./testing/fixtures.ts");
    const id = seedJob(d.db, "blocked");
    await api.jobs.pause({ id });
    expect(d.jobs.require(id)).toMatchObject({ state: "paused", pauseReason: "Paused by me." });
    await api.jobs.cancel({ id });
    expect(d.jobs.require(id).state).toBe("cancelled");
    await expect(api.jobs.resume({ id })).rejects.toThrow(/already ended|cannot/);
    await expect(api.jobs.pause({ id: "nope" })).rejects.toThrow(/No job nope/);
  });
});
