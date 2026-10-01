import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { afterEach, describe, expect, it } from "vitest";
import type { Router } from "../api/router.ts";
import { type Daemon, startDaemon } from "../daemon.ts";
import { sessions } from "../db/schema.ts";
import { resolvePaths } from "../paths.ts";
import { fakeLeg } from "../testing/fake-leg.ts";
import { fakeOs } from "../testing/fake-os.ts";
import { seedJob } from "../testing/fixtures.ts";
import { pidStartTime } from "./supervisor.ts";

let daemon: Daemon | undefined;
let cleanup: (() => void) | undefined;
afterEach(async () => {
  await daemon?.close();
  cleanup?.();
  daemon = undefined;
});

async function start(leg = fakeLeg()) {
  const dir = mkdtempSync(join(tmpdir(), "oraknid-legs-"));
  const fake = fakeOs({ keychain: true });
  cleanup = leg.cleanup;
  daemon = await startDaemon({
    paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
    port: 0,
    dbFile: ":memory:",
    os: fake.os,
    adapters: { "claude-code": leg.adapter, "openai-compatible": leg.adapter },
    healthIntervalMs: 60_000,
  });
  const api = createORPCClient<RouterClient<Router>>(new RPCLink({ url: `${daemon.url}/api` }));
  return { d: daemon, api, leg, dir, store: fake.store };
}

const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("adding Legs", () => {
  it("creates a Claude Code account dir I log into, and tests it straight away", async () => {
    const { api, dir } = await start();
    const leg = await api.legs.create({
      kind: "claude-code",
      name: "Claude — personal",
      config: { binary: "claude" },
    });
    expect(String(leg.config.configDir)).toBe(join(dir, "legs", leg.id, "claude-config"));
    expect(existsSync(String(leg.config.configDir))).toBe(true);
    expect(leg.health).toBe("healthy");
    expect(leg.models.map((m) => m.model)).toEqual(["opus", "haiku"]);
    expect(leg.models[0]?.profile.quotaWeight).toBe(5);
    expect(leg.remote).toBe(true);
  });

  it("says how to log in when the account does not answer", async () => {
    const { api } = await start(
      fakeLeg({ ok: false, detail: "Claude Code did not answer: not logged in" }),
    );
    const leg = await api.legs.create({
      kind: "claude-code",
      name: "work",
      config: { binary: "claude" },
    });
    expect(leg.health).toBe("unavailable");
    expect(leg.healthDetail).toMatch(/not logged in/);
    expect(leg.setupHint).toMatch(
      /^Log this account in: CLAUDE_CONFIG_DIR=".*claude-config" claude/,
    );
  });

  it("keeps an API key in the secret store only, and removes it with the Leg", async () => {
    const { api, d, store } = await start();
    const leg = await api.legs.create({
      kind: "openai-compatible",
      name: "Ollama",
      config: { baseUrl: "http://localhost:11434/v1" },
      secret: "sk-123",
    });
    expect(leg.hasSecret).toBe(true);
    expect(leg.remote).toBe(false);
    expect(store.get(`leg.${leg.id}`)).toBe("sk-123");
    const raw = JSON.stringify(d.db.$client.prepare("select * from legs").all());
    expect(raw).not.toContain("sk-123");
    await api.legs.remove({ id: leg.id });
    expect(store.has(`leg.${leg.id}`)).toBe(false);
  });
});

describe("models and profiles", () => {
  it("keeps my hidden models and overrides across probes, and hides models that vanish", async () => {
    const { api, leg: fake } = await start();
    const leg = await api.legs.create({ kind: "claude-code", name: "c", config: {} });
    const haiku = leg.models.find((m) => m.model === "haiku");
    await api.legs.setModelHidden({ modelId: haiku?.id as string, hidden: true });
    await api.legs.setProfile({
      modelId: haiku?.id as string,
      overrides: { strengths: { tests: 5 }, quotaWeight: 2 },
    });
    fake.state.models = fake.state.models.filter((m) => m.model !== "opus");
    const after = await api.legs.test({ id: leg.id });
    const h = after.models.find((m) => m.model === "haiku");
    expect(h).toMatchObject({ hidden: true, profile: { quotaWeight: 2 } });
    expect(h?.profile.strengths.tests).toBe(5);
    expect(h?.profile.learned.tests).toBe(3);
    expect(after.models.find((m) => m.model === "opus")?.hidden).toBe(true);
  });
});

describe("sessions", () => {
  async function session(fake = fakeLeg()) {
    const ctx = await start(fake);
    const leg = await ctx.api.legs.create({ kind: "claude-code", name: "c", config: {} });
    const jobId = seedJob(ctx.d.db, "running");
    const model = leg.models[0]?.id as string;
    const s = await ctx.d.supervisor.start({
      legId: leg.id,
      legModelId: model,
      effort: "high",
      jobId,
      taskId: null,
      cwd: ctx.dir,
      systemPrompt: "pack",
      prompt: "go",
      onPermission: async () => ({ allow: true }),
    });
    const seen: string[] = [];
    const reading = (async () => {
      for await (const e of s.events) seen.push(e.type);
    })();
    return { ...ctx, legView: leg, jobId, model, s, seen, reading };
  }

  it("logs the raw stream, records usage, and publishes condensed events", async () => {
    const { d, s, seen, jobId } = await session();
    await until(() => seen.includes("turn.ended"));
    const row = d.db.select().from(sessions).get();
    expect(row).toMatchObject({
      inputTokens: 200,
      outputTokens: 50,
      contextTokens: 250,
      nativeSessionId: "native-1",
    });
    expect(row?.pid).toBeGreaterThan(0);
    expect(row?.pidStartTime).toBe(pidStartTime(row?.pid as number));
    const lines = readFileSync(row?.logFile as string, "utf8")
      .trim()
      .split("\n");
    expect(lines.map((l) => JSON.parse(l).type)).toContain("text.delta");
    await until(() => d.bus.since(0, [`job:${jobId}`], 100).some((e) => e.type === "session.text"));
    const types = d.bus.since(0, [`job:${jobId}`], 100).map((e) => e.type);
    expect(types).toContain("session.turn.ended");
    // Text deltas never reach the event log one by one.
    expect(types).not.toContain("session.text.delta");
    const text = d.bus.since(0, [`job:${jobId}`], 100).find((e) => e.type === "session.text");
    expect((text?.payload as { text: string } | undefined)?.text).toBe("working");
    // Its process is measured.
    expect(d.supervisor.watched().map((w) => w.id)).toEqual([s.id]);
    await s.session.kill();
  });

  it("marks the Leg rate-limited until its window resets, and refuses new sessions meanwhile", async () => {
    const fake = fakeLeg();
    const resetsAt = Date.now() + 3600_000;
    fake.state.quota = {
      window: "five_hour",
      scope: "account",
      status: "rejected",
      utilization: 1,
      resetsAt,
    };
    const { d, api, legView, model, seen, s, dir } = await session(fake);
    await until(() => seen.includes("turn.ended"));
    const leg = await api.legs.get({ id: legView.id });
    expect(leg).toMatchObject({ health: "rate-limited", limitedUntil: resetsAt });
    expect(leg.quota[0]).toMatchObject({ name: "five_hour", utilization: 1, estimated: false });
    // A health check before the reset does not clear it.
    expect((await api.legs.test({ id: leg.id })).health).toBe("rate-limited");
    await expect(
      d.supervisor.start({
        legId: leg.id,
        legModelId: model,
        effort: null,
        jobId: null,
        taskId: null,
        cwd: dir,
        systemPrompt: "",
        prompt: "",
        onPermission: async () => ({ allow: true }),
      }),
    ).rejects.toThrow(/rate-limited: Usage limit reached \(five_hour\)/);
    await s.session.kill();
  });

  it("estimates a window's share from my limit when the provider reports none", async () => {
    const fake = fakeLeg();
    const ctx = await start(fake);
    const leg = await ctx.api.legs.create({ kind: "claude-code", name: "c", config: {} });
    const opus = leg.models[0]?.id as string;
    await ctx.api.legs.setProfile({
      modelId: opus,
      overrides: { windowLimits: { five_hour: 1000 } },
    });
    fake.state.quota = {
      window: "five_hour",
      scope: "account",
      status: "allowed",
      utilization: null,
      resetsAt: Date.now() + 3600_000,
    };
    const s = await ctx.d.supervisor.start({
      legId: leg.id,
      legModelId: opus,
      effort: null,
      jobId: null,
      taskId: null,
      cwd: ctx.dir,
      systemPrompt: "",
      prompt: "",
      onPermission: async () => ({ allow: true }),
    });
    for await (const e of s.events) if (e.type === "turn.ended") break;
    // The quota event comes before this session's usage is recorded: a second report counts it.
    ctx.d.registry.applyQuota(leg.id, opus, fake.state.quota);
    const after = await ctx.api.legs.get({ id: leg.id });
    expect(after.quota[0]).toMatchObject({ utilization: 0.25, estimated: true });
    await s.session.kill();
  });

  it("refuses to start on a paused Leg", async () => {
    const { api, d, dir } = await start();
    const leg = await api.legs.create({ kind: "claude-code", name: "c", config: {} });
    await api.legs.pause({ id: leg.id });
    await expect(
      d.supervisor.start({
        legId: leg.id,
        legModelId: leg.models[0]?.id as string,
        effort: null,
        jobId: null,
        taskId: null,
        cwd: dir,
        systemPrompt: "",
        prompt: "",
        onPermission: async () => ({ allow: true }),
      }),
    ).rejects.toThrow("c is paused.");
  });
});

describe("recovery of orphaned Leg processes", () => {
  it("kills a session's process left by a crash, but never a reused pid", async () => {
    const { d } = await start();
    const orphan = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    const innocent = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    const row = (id: string, pid: number, startTime: number | null) => ({
      id,
      legId: "l",
      legModelId: "m",
      logFile: "/dev/null",
      startedAt: 0,
      pid,
      pidStartTime: startTime,
    });
    d.db
      .insert(sessions)
      .values(
        row("01J9Z3K8W2Q4V6X8Y0A1B2C3S1", orphan.pid as number, pidStartTime(orphan.pid as number)),
      )
      .run();
    // Same pid as a live process, but a start time from some earlier process.
    d.db
      .insert(sessions)
      .values(row("01J9Z3K8W2Q4V6X8Y0A1B2C3S2", innocent.pid as number, 1))
      .run();

    expect(d.supervisor.recoverOrphans()).toBe(2);
    await until(() => orphan.exitCode !== null || orphan.signalCode !== null);
    expect(orphan.signalCode).toBe("SIGKILL");
    expect(innocent.exitCode === null && innocent.signalCode === null).toBe(true);
    innocent.kill("SIGKILL");
    const rows = d.db.select().from(sessions).all();
    expect(rows.every((r) => r.endReason === "crashed" && r.endedAt !== null)).toBe(true);
  });
});
