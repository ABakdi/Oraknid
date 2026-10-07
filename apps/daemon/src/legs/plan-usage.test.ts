import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexAdapter } from "@oraknid/leg-codex";
import { FAKE_CODEX } from "@oraknid/leg-codex/fake";
import type { LegAdapter, PlanUsageReport } from "@oraknid/leg-sdk";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import type { Router } from "../api/router.ts";
import { type Daemon, startDaemon } from "../daemon.ts";
import { sessions } from "../db/schema.ts";
import { resolvePaths } from "../paths.ts";
import { fakeLeg } from "../testing/fake-leg.ts";
import { fakeOs } from "../testing/fake-os.ts";
import { modelKey, PROMPT_EVERY_MS, READ_EVERY_MS, windowLabel } from "./plan-usage.ts";

// ADR-039: a Leg's plan usage in front of me.

let daemon: Daemon | undefined;
let cleanup: (() => void) | undefined;
afterEach(async () => {
  await daemon?.close();
  cleanup?.();
  daemon = undefined;
});

const T0 = Date.parse("2026-10-03T08:00:00.000Z");
const H = 3600_000;

async function start(o: { reading?: () => PlanUsageReport | null } = {}) {
  const leg = fakeLeg({
    models: [
      { model: "opus", displayName: "Opus", effortLevels: [], contextWindow: null },
      { model: "sonnet", displayName: "Sonnet", effortLevels: [], contextWindow: null },
      { model: "haiku", displayName: "Haiku", effortLevels: [], contextWindow: null },
    ],
  });
  cleanup = leg.cleanup;
  const reads = { n: 0 };
  const adapter: LegAdapter = o.reading
    ? {
        ...leg.adapter,
        planUsage: async () => {
          reads.n++;
          // A reading takes a moment, so two callers can meet on it.
          await new Promise((r) => setTimeout(r, 20));
          return o.reading?.() ?? null;
        },
      }
    : leg.adapter;
  const clock = { now: T0 };
  const dir = mkdtempSync(join(tmpdir(), "oraknid-plan-"));
  daemon = await startDaemon({
    paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
    port: 0,
    dbFile: ":memory:",
    os: fakeOs({ keychain: true }).os,
    adapters: { "claude-code": adapter, "openai-compatible": leg.adapter },
    healthIntervalMs: 60_000,
    now: () => clock.now,
  });
  const api = createORPCClient<RouterClient<Router>>(
    new RPCLink({
      url: `${daemon.url}/api`,
      headers: { authorization: `Bearer ${daemon.cliToken}` },
    }),
  );
  const created = await api.legs.create({ kind: "claude-code", name: "Max", config: {} });
  return { d: daemon, api, leg, legId: created.id, reads, clock };
}

const reading = (five: number, week: number, resetsAt = T0 + 3 * H): PlanUsageReport => ({
  available: true,
  windows: [
    { window: "five_hour", scope: "account", label: null, utilization: five, resetsAt },
    {
      window: "seven_day",
      scope: "account",
      label: null,
      utilization: week,
      resetsAt: T0 + 4 * 24 * H,
    },
    {
      window: "seven_day_opus",
      scope: "model",
      label: null,
      utilization: 0.1,
      resetsAt: T0 + 4 * 24 * H,
    },
  ],
});

describe("a Leg's plan usage (ADR-039)", () => {
  it("stores the backend's own reading, the account's windows on the Leg and a model's on its model", async () => {
    const { api, d, legId } = await start({ reading: () => reading(0.42, 0.81) });
    const usage = await api.legs.refreshPlanUsage();
    const mine = usage.find((u) => u.legId === legId);
    // Fullest first, each with how old it is and where it came from.
    expect(mine?.windows.map((w) => [w.name, w.label, w.scope, w.utilization])).toEqual([
      ["seven_day", "Week", "account", 0.81],
      ["five_hour", "5 hours", "account", 0.42],
      ["seven_day_opus", "Week, Opus", "model", 0.1],
    ]);
    expect(mine?.windows.every((w) => w.observedAt === T0 && w.source === "usage")).toBe(true);
    expect(mine?.checkedAt).toBe(T0);
    expect(mine?.note).toBeNull();
    // Routing reads the same windows: the Leg's, and Opus's on the Opus model only.
    const view = d.registry.view(d.registry.require(legId));
    expect(view.quota.map((w) => w.name).sort()).toEqual(["five_hour", "seven_day"]);
    expect(view.models.find((m) => m.model === "opus")?.quota.map((w) => w.name)).toEqual([
      "seven_day_opus",
    ]);
    expect(view.models.find((m) => m.model === "sonnet")?.quota).toEqual([]);
  });

  it("counts Oraknid's own tokens in each window, by model, only since the window began", async () => {
    const { api, d, legId, clock } = await start({ reading: () => reading(0.3, 0.6) });
    const models = d.registry.models(legId);
    const id = (m: string) => models.find((x) => x.model === m)?.id ?? "";
    const session = (model: string, at: number, tokens: number) =>
      d.db
        .insert(sessions)
        .values({
          id: `s-${model}-${at}`,
          legId,
          legModelId: id(model),
          logFile: "/dev/null",
          startedAt: at,
          inputTokens: tokens,
          outputTokens: 0,
        })
        .run();
    // The five-hour window began at T0 + 3h - 5h = T0 - 2h.
    session("opus", T0 - H, 1000);
    session("sonnet", T0 - H, 3000);
    session("sonnet", T0 - 3 * H, 500); // before the five-hour window, inside the week
    clock.now = T0 + 1000;
    const mine = (await api.legs.refreshPlanUsage()).find((u) => u.legId === legId);
    const tokens = (name: string) =>
      mine?.windows.find((w) => w.name === name)?.tokens.map((t) => [t.model, t.tokens]);
    expect(tokens("five_hour")).toEqual([
      ["sonnet", 3000],
      ["opus", 1000],
    ]);
    expect(tokens("seven_day")).toEqual([
      ["sonnet", 3500],
      ["opus", 1000],
    ]);
    // A model's window counts that model alone.
    expect(tokens("seven_day_opus")).toEqual([["opus", 1000]]);
  });

  it("reads at most every five minutes while asked, and two callers share one reading", async () => {
    const { api, reads, clock } = await start({ reading: () => reading(0.3, 0.6) });
    await Promise.all([api.legs.refreshPlanUsage(), api.legs.refreshPlanUsage()]);
    expect(reads.n).toBe(1);
    clock.now = T0 + READ_EVERY_MS - 1;
    await api.legs.refreshPlanUsage();
    expect(reads.n).toBe(1);
    clock.now = T0 + READ_EVERY_MS;
    await api.legs.refreshPlanUsage();
    expect(reads.n).toBe(2);
    // Only looking reads: planUsage alone never does.
    clock.now = T0 + 3 * READ_EVERY_MS;
    await api.legs.planUsage();
    expect(reads.n).toBe(2);
  });

  it("keeps a reading that didn't change as a new time, and a change, a fill and a reset as history", async () => {
    let r = reading(0.5, 0.6);
    const { api, d, legId, clock } = await start({ reading: () => r });
    await api.legs.refreshPlanUsage();
    const quotaEvents = () =>
      d.planUsage.history(legId, 0).points.filter((p) => p.window === "five_hour").length;
    expect(quotaEvents()).toBe(1);
    // The same figures five minutes later: only the time moves.
    clock.now = T0 + READ_EVERY_MS;
    await api.legs.refreshPlanUsage();
    expect(quotaEvents()).toBe(1);
    const five = (await api.legs.planUsage())
      .find((u) => u.legId === legId)
      ?.windows.find((w) => w.name === "five_hour");
    expect(five?.observedAt).toBe(T0 + READ_EVERY_MS);
    // It fills…
    clock.now = T0 + 2 * READ_EVERY_MS;
    r = reading(1, 0.7);
    await api.legs.refreshPlanUsage();
    // …and after its reset time, a new window starts nearly empty.
    clock.now = T0 + 4 * H;
    r = reading(0.02, 0.7, T0 + 8 * H);
    await api.legs.refreshPlanUsage();
    const h = await api.legs.planHistory({ id: legId });
    expect(
      h.points.filter((p) => p.window === "five_hour").map((p) => [p.at, p.utilization]),
    ).toEqual([
      [T0, 0.5],
      [T0 + 2 * READ_EVERY_MS, 1],
      [T0 + 4 * H, 0.02],
    ]);
    expect(h.marks).toEqual([
      { window: "five_hour", kind: "filled", at: T0 + 2 * READ_EVERY_MS },
      { window: "five_hour", kind: "reset", at: T0 + 3 * H },
    ]);
  });

  it("falls back to a tiny prompt at most every fifteen minutes when the backend can't read", async () => {
    const { api, d, legId, leg, clock } = await start({ reading: () => null });
    leg.state.quota = {
      window: "five_hour",
      scope: "account",
      status: "allowed",
      utilization: 0.25,
      resetsAt: T0 + 2 * H,
    };
    const prompts = () =>
      d.db.select().from(sessions).where(eq(sessions.attemptId, "plan-usage")).all();
    let mine = (await api.legs.refreshPlanUsage()).find((u) => u.legId === legId);
    expect(prompts()).toHaveLength(1);
    // The cheapest model, sandboxed, and its tokens counted like any session's.
    expect(prompts()[0]?.legModelId).toBe(
      d.registry.models(legId).find((m) => m.model === "haiku")?.id,
    );
    expect(prompts()[0]?.inputTokens).toBe(200);
    expect(mine?.windows.map((w) => [w.name, w.utilization, w.source])).toEqual([
      ["five_hour", 0.25, "session"],
    ]);
    // Within fifteen minutes: no second prompt, even past the five-minute reading time.
    clock.now = T0 + PROMPT_EVERY_MS - 1;
    await api.legs.refreshPlanUsage();
    expect(prompts()).toHaveLength(1);
    clock.now = T0 + PROMPT_EVERY_MS;
    mine = (await api.legs.refreshPlanUsage()).find((u) => u.legId === legId);
    expect(prompts()).toHaveLength(2);
    expect(mine?.windows[0]?.observedAt).toBe(T0 + PROMPT_EVERY_MS);
  });

  it("sends no prompt while a session has reported in the last fifteen minutes", async () => {
    const { api, d, legId, clock } = await start({ reading: () => null });
    const opus = d.registry.models(legId).find((m) => m.model === "opus")?.id ?? "";
    d.registry.applyQuota(legId, opus, {
      window: "five_hour",
      scope: "account",
      status: "allowed",
      utilization: 0.4,
      resetsAt: T0 + H,
    });
    clock.now = T0 + PROMPT_EVERY_MS - 1;
    await api.legs.refreshPlanUsage();
    expect(d.db.select().from(sessions).where(eq(sessions.attemptId, "plan-usage")).all()).toEqual(
      [],
    );
  });

  it("says what another kind of Leg has instead", async () => {
    const { api } = await start();
    await api.legs.create({
      kind: "openai-compatible",
      name: "Ollama",
      config: { baseUrl: "http://127.0.0.1:11434/v1" },
    });
    const usage = await api.legs.planUsage();
    expect(usage.find((u) => u.name === "Ollama")).toMatchObject({
      windows: [],
      note: "A local model: no limits.",
    });
    expect(usage.find((u) => u.name === "Max")?.note).toBe(
      "Not read yet: it shows after the first reading or session.",
    );
  });

  it("names windows in words", () => {
    expect(windowLabel("five_hour")).toBe("5 hours");
    expect(windowLabel("seven_day_sonnet")).toBe("Week, Sonnet");
    expect(windowLabel("seven_day_fable", "Fable")).toBe("Week, Fable");
    expect(modelKey("seven_day")).toBeNull();
    expect(modelKey("seven_day_oauth_apps")).toBeNull();
    expect(modelKey("seven_day_opus")).toBe("opus");
  });
});

describe("a Codex Leg's plan (ADR-057)", () => {
  it("reads its five hours and its week from Codex's app server, no prompt spent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oraknid-plan-codex-"));
    daemon = await startDaemon({
      paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
      port: 0,
      dbFile: ":memory:",
      os: fakeOs({ keychain: true }).os,
      adapters: { codex: createCodexAdapter() },
      healthIntervalMs: 60_000,
    });
    const api = createORPCClient<RouterClient<Router>>(
      new RPCLink({
        url: `${daemon.url}/api`,
        headers: { authorization: `Bearer ${daemon.cliToken}` },
      }),
    );
    const leg = await api.legs.create({
      kind: "codex",
      name: "GPT",
      config: { binary: FAKE_CODEX },
    });
    writeFileSync(join((leg.config as { codexHome: string }).codexHome, "auth.json"), "{}");
    await api.legs.test({ id: leg.id });
    const mine = (await api.legs.refreshPlanUsage()).find((u) => u.legId === leg.id);
    expect(mine?.windows.map((w) => [w.name, w.label, w.utilization, w.source])).toEqual([
      ["five_hour", "5 hours", 0.42, "usage"],
      ["seven_day", "Week", 0.07, "usage"],
    ]);
    expect(daemon.db.select().from(sessions).all()).toEqual([]);
  }, 30_000);
});
