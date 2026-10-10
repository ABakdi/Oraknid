import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { LegKind } from "@oraknid/contracts";
import { FAKE_AGY } from "@oraknid/leg-antigravity/fake";
import { createCodexAdapter } from "@oraknid/leg-codex";
import { FAKE_CODEX } from "@oraknid/leg-codex/fake";
import { createOraknidAgentAdapter } from "@oraknid/leg-oraknid-agent";
import type { LegAdapter } from "@oraknid/leg-sdk";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import type { Router } from "../api/router.ts";
import { type Daemon, startDaemon } from "../daemon.ts";
import { attempts, legs, sessions } from "../db/schema.ts";
import { resolvePaths } from "../paths.ts";
import { fakeLeg } from "../testing/fake-leg.ts";
import { fakeOs } from "../testing/fake-os.ts";
import { seedJob } from "../testing/fixtures.ts";
import { sharesMyClaude } from "./registry.ts";
import { pidStartTime } from "./supervisor.ts";

let daemon: Daemon | undefined;
let cleanup: (() => void) | undefined;
afterEach(async () => {
  await daemon?.close();
  cleanup?.();
  daemon = undefined;
});

async function start(leg = fakeLeg(), more: Partial<Record<LegKind, LegAdapter>> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "oraknid-legs-"));
  const fake = fakeOs({ keychain: true });
  cleanup = leg.cleanup;
  daemon = await startDaemon({
    paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
    port: 0,
    dbFile: ":memory:",
    os: fake.os,
    adapters: { "claude-code": leg.adapter, "openai-compatible": leg.adapter, ...more },
    healthIntervalMs: 60_000,
  });
  const api = createORPCClient<RouterClient<Router>>(
    new RPCLink({
      url: `${daemon.url}/api`,
      headers: { authorization: `Bearer ${daemon.cliToken}` },
    }),
  );
  return { d: daemon, api, leg, dir, store: fake.store };
}

const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("a Leg is tested before it is saved (Legs spec → Adding a Leg)", () => {
  it("saves nothing when the test fails, and says what failed", async () => {
    const { api, d, dir } = await start(
      fakeLeg({ ok: false, detail: "Nothing answers at http://localhost:9/v1" }),
    );
    const saved = () => d.db.select().from(legs).all().length;
    await expect(
      api.legs.create({
        kind: "openai-compatible",
        name: "local",
        config: { baseUrl: "http://localhost:9/v1" },
        secret: "sk-local-test-key",
      }),
    ).rejects.toThrow(
      "The test failed, so nothing was saved: Nothing answers at http://localhost:9/v1. Fix it and try again, or save it disabled.",
    );
    expect(saved()).toBe(0);
    // Its trial home is gone with it.
    const left = existsSync(join(dir, "legs"))
      ? (await import("node:fs")).readdirSync(join(dir, "legs"))
      : [];
    expect(left.filter((n) => n.startsWith("trial-"))).toEqual([]);
  });

  it("saves it disabled when I ask, after a failed test", async () => {
    const { api } = await start(fakeLeg({ ok: false, detail: "Nothing answers." }));
    const leg = await api.legs.create({
      kind: "openai-compatible",
      name: "local",
      config: { baseUrl: "http://localhost:9/v1" },
      saveDisabled: true,
    });
    expect(leg.enabled).toBe(false);
    expect(leg.health).toBe("disabled");
  });

  it("saves one that passes, tested", async () => {
    const { api } = await start();
    const leg = await api.legs.create({
      kind: "openai-compatible",
      name: "local",
      config: { baseUrl: "http://localhost:9/v1" },
    });
    expect(leg.health).toBe("healthy");
  });
});

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
    expect(leg.setupHint).toMatch(/^Log this account in: press Log in on its card/);
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
    // Killed by its owner: recorded as killed, not left for recovery to call a crash.
    expect(d.db.select().from(sessions).get()).toMatchObject({ endReason: "killed" });
    expect(d.supervisor.watched()).toEqual([]);
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

  it("closes an attempt a crash left open (seen live after a kill -9)", async () => {
    const { d } = await start();
    const attempt = {
      taskId: "t",
      jobId: "j",
      legId: "l",
      legModelId: "m",
      startedAt: 0,
      escalations: [],
    };
    d.db
      .insert(attempts)
      .values({ ...attempt, id: "01J9Z3K8W2Q4V6X8Y0A1B2C3A1" })
      .run();
    d.db
      .insert(attempts)
      .values({ ...attempt, id: "01J9Z3K8W2Q4V6X8Y0A1B2C3A2", endedAt: 5, outcome: "succeeded" })
      .run();
    d.supervisor.recoverOrphans();
    const rows = d.db.select().from(attempts).all();
    expect(rows.map((r) => r.outcome)).toEqual(["abandoned", "succeeded"]);
    expect(rows.every((r) => r.endedAt !== null)).toBe(true);
  });
});

describe("a Leg's own config folder (Audit 1 → S1-02)", () => {
  it("refuses my own ~/.claude, and moves a Leg that has it to a folder of its own", async () => {
    const { d, api } = await start();
    await expect(
      api.legs.create({ kind: "claude-code", name: "Mine", config: { configDir: "~/.claude" } }),
    ).rejects.toThrow(/can't use your own ~\/.claude/);
    expect(sharesMyClaude(join(homedir(), ".claude", "x"))).toBe(true);
    expect(sharesMyClaude(homedir())).toBe(true);
    expect(sharesMyClaude(join(homedir(), ".local/share/oraknid/legs/a/claude-config"))).toBe(
      false,
    );
    // A Leg made before the rule, straight in the database.
    const { id } = await api.legs.create({ kind: "claude-code", name: "Old", config: {} });
    const row = d.db.select().from(legs).where(eq(legs.id, id)).get();
    d.db
      .update(legs)
      .set({
        config: {
          ...(row?.config as Record<string, unknown>),
          configDir: join(homedir(), ".claude"),
        },
      })
      .where(eq(legs.id, id))
      .run();
    expect(d.registry.ownConfigFolders()).toEqual([id]);
    const moved = d.db.select().from(legs).where(eq(legs.id, id)).get();
    expect((moved?.config as { configDir?: string } | undefined)?.configDir).toMatch(
      /legs\/.+\/claude-config$/,
    );
    expect(moved?.healthDetail).toMatch(/log it in once/);
    expect(d.registry.ownConfigFolders()).toEqual([]);
  });
});

describe("logging a Claude Code Leg in from the web (2026-10-02)", () => {
  it("shows the official sign-in link, passes back my code, and says when it worked", async () => {
    const { api } = await start();
    const bin = join(mkdtempSync(join(tmpdir(), "oraknid-fake-claude-")), "claude");
    // Stands in for the official binary: a link with escapes around it, then a code on stdin.
    writeFileSync(
      bin,
      `#!/bin/sh
if [ "$1 $2" = "auth status" ]; then
  if [ -f "$CLAUDE_CONFIG_DIR/.credentials.json" ]; then echo '{"loggedIn":true,"email":"me@example.com"}'; else echo '{"loggedIn":false}'; fi
  exit 0
fi
printf 'If the browser did not open, visit: \\033]8;;https://claude.com/cai/oauth/authorize?code=true&state=s1\\007https://claude.com/cai/oauth/authorize?code=true&state=s1\\033]8;;\\007\\n'
printf 'Paste code here if prompted > '
read code
if [ "$code" = "good-code" ]; then echo '{}' > "$CLAUDE_CONFIG_DIR/.credentials.json"; echo "Login successful."; exit 0; fi
echo "Invalid code."; exit 1
`,
      { mode: 0o755 },
    );
    const leg = await api.legs.create({
      kind: "claude-code",
      name: "Claude B",
      config: { binary: bin },
    });
    const first = await api.legs.loginStart({ id: leg.id });
    expect(first.url).toBe("https://claude.com/cai/oauth/authorize?code=true&state=s1");
    expect(await api.legs.loginFinish({ id: leg.id, code: "wrong" })).toEqual({
      ok: false,
      detail: "Invalid code.",
    });
    await api.legs.loginStart({ id: leg.id });
    expect(await api.legs.loginFinish({ id: leg.id, code: " good-code " })).toEqual({
      ok: true,
      detail: "Logged in as me@example.com.",
    });
    await expect(api.legs.loginFinish({ id: leg.id, code: "again" })).rejects.toThrow(/expired/);
  });
});

describe("signing an Antigravity Leg in from the web (ADR-020)", () => {
  it("runs agy under a terminal, shows its link, and the sign-in lands in the Leg's own home", async () => {
    const { api } = await start();
    const bin = join(mkdtempSync(join(tmpdir(), "oraknid-fake-agy-")), "agy");
    // A fresh Leg home starts signed out.
    writeFileSync(
      bin,
      `#!/bin/sh
[ -f "$HOME/.fake-agy-mode" ] || echo signed-out > "$HOME/.fake-agy-mode"
exec node ${FAKE_AGY} "$@"
`,
      { mode: 0o755 },
    );
    const leg = await api.legs.create({
      kind: "antigravity",
      name: "Gemini",
      config: { binary: bin },
    });
    const first = await api.legs.loginStart({ id: leg.id });
    expect(first.url).toBe("https://accounts.google.com/o/oauth2/auth?client=agy&state=x1");
    const wrong = await api.legs.loginFinish({ id: leg.id, code: "wrong" });
    expect(wrong.ok).toBe(false);
    expect(wrong.detail).toMatch(/Invalid code/);
    await api.legs.loginStart({ id: leg.id });
    expect(await api.legs.loginFinish({ id: leg.id, code: "good-code" })).toEqual({
      ok: true,
      detail: "Signed in.",
    });
  }, 30_000);
});

describe("a Codex Leg (ADR-057)", () => {
  it("gets a CODEX_HOME of its own, signs in from its card with a code, and a job gets its own", async () => {
    const { d, api, dir } = await start(fakeLeg(), { codex: createCodexAdapter() });
    await expect(
      api.legs.create({ kind: "codex", name: "Mine", config: { codexHome: "~/.codex" } }),
    ).rejects.toThrow(/can't use your own ~\/.codex/);
    const leg = await api.legs.create({
      kind: "codex",
      name: "GPT",
      config: { binary: FAKE_CODEX },
    });
    const codexHome = (leg.config as { codexHome: string }).codexHome;
    expect(codexHome).toMatch(/legs\/.+\/codex-home$/);
    expect(leg).toMatchObject({ health: "unavailable", hasSecret: false });
    expect(leg.healthDetail).toBe("Not signed in: press Log in on its card.");
    expect(leg.setupHint).toMatch(/enter the code/);
    const started = await api.legs.loginStart({ id: leg.id });
    expect(started).toMatchObject({ userCode: "ABCD-12345" });
    writeFileSync(join(codexHome, ".fake-approved"), "");
    expect(await api.legs.loginFinish({ id: leg.id, code: "entered" })).toEqual({
      ok: true,
      detail: "Logged in using ChatGPT.",
    });
    const tested = await api.legs.get({ id: leg.id });
    expect(tested.health).toBe("healthy");
    expect(tested.models.map((m) => m.model)).toEqual(["gpt-6-sol", "gpt-6-luna"]);
    expect(tested.models[0]?.effortLevels).toEqual(["low", "medium", "high", "xhigh"]);
    // A job's sessions get a CODEX_HOME of their own, with the Leg's login linked in.
    const { sandboxPlan } = await import("./plan.ts");
    const legsDir = resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }).legs;
    const plan = sandboxPlan(
      d.registry.require(leg.id),
      fakeOs().os.sandbox as never,
      legsDir,
      [],
      "J1",
    );
    expect(plan.configDir).toMatch(/jobs\/J1\/codex-home$/);
    expect(readFileSync(join(plan.configDir as string, "auth.json"), "utf8")).toContain("chatgpt");
    expect(existsSync(join(plan.configDir as string, "sessions"))).toBe(false);
    expect(plan.writable).toContain(join(codexHome, "auth.json"));
  }, 30_000);

  it("keeps an OpenAI API key in the keychain and offers the API's models", async () => {
    const { api, store } = await start(fakeLeg(), { codex: createCodexAdapter() });
    const leg = await api.legs.create({
      kind: "codex",
      name: "GPT key",
      config: { binary: FAKE_CODEX },
      secret: "sk-test-123",
    });
    expect(leg).toMatchObject({ hasSecret: true, health: "healthy", setupHint: null });
    expect(leg.config).toMatchObject({ auth: "api-key" });
    expect(JSON.stringify(leg.config)).not.toContain("sk-test-123");
    expect([...store.values()]).toContain("sk-test-123");
    expect(leg.models.map((m) => m.model)).toEqual(["gpt-6-sol"]);
    await expect(api.legs.loginStart({ id: leg.id })).rejects.toThrow(/API key/);
  });
});

describe("a hosted API's key in the test before saving (2026-10-10, xAI answered 401)", () => {
  it("tests with the key I typed, and saves the Leg when the server takes it", async () => {
    const server = createServer((req, res) => {
      if (req.url !== "/v1/models") return res.writeHead(404).end();
      if (req.headers.authorization !== "Bearer xai-k-123")
        return res.writeHead(401).end('{"error":"no key"}');
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: [{ id: "grok-4", context_length: 256000, supported_parameters: ["tools"] }],
        }),
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      // The real adapter, its keys read as the daemon reads them (daemon.ts).
      const agent = createOraknidAgentAdapter({
        credentialOf: async (leg) => {
          const reg = (daemon as Daemon).registry;
          const row = reg.get(leg.id);
          return row ? reg.credential(row) : reg.trialCredential(leg.id);
        },
      });
      const { api } = await start(fakeLeg(), { "oraknid-agent": agent });
      const wrong = api.legs.create({
        kind: "oraknid-agent",
        name: "Grok",
        config: { baseUrl: `http://127.0.0.1:${port}/v1/responses` },
        secret: "wrong",
      } as never);
      await expect(wrong).rejects.toThrow(/refused the API key/);
      const leg = await api.legs.create({
        kind: "oraknid-agent",
        name: "Grok",
        config: { baseUrl: `http://127.0.0.1:${port}/v1/responses` },
        secret: "xai-k-123",
      } as never);
      expect(leg.enabled).toBe(true);
    } finally {
      server.close();
    }
  });
});
