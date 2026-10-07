import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobView, QuotaWindow, WebPlan } from "@oraknid/contracts";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import type { Router } from "../api/router.ts";
import { type Daemon, startDaemon } from "../daemon.ts";
import { attempts, legModels, legs } from "../db/schema.ts";
import { resolvePaths } from "../paths.ts";
import { fakeOs } from "../testing/fake-os.ts";
import { type Action, scriptedLeg, type TurnContext } from "../testing/scripted-leg.ts";
import type { EyeBrain } from "./brain.ts";

// M13.22, the research task of 2026-10-04 replayed with stand-in Legs: a free
// model's provider answers 500; the deliverable its check names is written; the
// OpenCode Leg asks for its own tmp.

let daemon: Daemon | undefined;
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
});

const DOC = "docs/audio-libraries-recommendation.md";

const RESEARCH: WebPlan = {
  summary: "Pick the audio library.",
  tasks: [
    {
      key: "r",
      title: "Research audio helper libraries for low-latency Web Audio synthesis",
      instructions: "Compare Tone.js, Timbre.js and raw Web Audio for low latency.",
      kind: "research",
      dependsOn: [],
      // As the plan of 2026-10-04 had it: words, not the file its check names.
      scope: ["research", "documentation"],
      verify: [`test -s ${DOC}`],
      requiredCapabilities: ["summarize", "classify"],
      difficulty: "medium",
    },
  ],
  jobVerify: [],
};

const brain = {
  plan: async () => RESEARCH,
  replan: async () => RESEARCH,
  summarize: async () => ({ title: "s", body: "s" }),
  repairCheck: async ({ command }) => ({ broken: false, command, reason: "kept" }),
  pickSkill: async ({ skills }) => ({ skillId: skills[0]?.id ?? "", reason: "first" }),
  helperTurn: async () => ({ reply: "ok", actions: [] }),
  serverState: async () => ({ document: "# A server" }),
  evaluate: async () => ({ accepted: true, reason: "ok", missing: [] }),
  triage: async () => {
    throw new Error("unused");
  },
  judgeAction: async () => ({ decision: "block" as const, category: null, reason: "a test asks" }),
  interviewRound: async () => ({ done: true, playback: "", questions: [], open: [] }),
} satisfies EyeBrain;

const sh = (cwd: string, ...a: string[]) => spawnSync("git", a, { cwd, encoding: "utf8" });

async function until(api: RouterClient<Router>, id: string, states: string[], ms = 30_000) {
  const end = Date.now() + ms;
  for (;;) {
    const j: JobView = await api.jobs.get({ id });
    if (states.includes(j.state) || Date.now() > end) return j;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * A daemon with a stand-in OpenCode Leg of free models (`free`) and a Claude
 * Leg whose week is at 70%, the research job started. `records`: research
 * tasks each free model already got done, so it goes first.
 */
async function world(free: ReturnType<typeof scriptedLeg>, records: Record<string, number>) {
  /** Claude: does the research, its document where the check looks. */
  const claude = scriptedLeg(() => [
    { write: DOC, content: "# Audio libraries\n\n## Libraries Evaluated\n\n| [Tone.js] |\n" },
    { say: "DONE: wrote the recommendation." },
  ]);
  const dir = mkdtempSync(join(tmpdir(), "oraknid-simple-"));
  daemon = await startDaemon({
    paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
    port: 0,
    dbFile: ":memory:",
    os: fakeOs({ keychain: true }).os,
    adapters: { "claude-code": claude.adapter, opencode: free.adapter },
    brain,
    stallCheckMs: 100,
  });
  const d = daemon;
  const api = createORPCClient<RouterClient<Router>>(
    new RPCLink({ url: `${d.url}/api`, headers: { authorization: `Bearer ${d.cliToken}` } }),
  );
  const oc = await api.legs.create({ kind: "opencode", name: "Opencode", config: {} });
  const cl = await api.legs.create({ kind: "claude-code", name: "Claude", config: {} });
  await d.health.check(oc.id);
  await d.health.check(cl.id);
  // Claude Max this week at 70%; free models with a record good enough to go first.
  const week: QuotaWindow[] = [
    {
      name: "seven_day",
      utilization: 0.7,
      resetsAt: Date.now() + 86_400_000,
      estimated: false,
      observedAt: Date.now(),
      source: "usage",
    },
  ];
  d.db.update(legs).set({ quota: week }).where(eq(legs.id, cl.id)).run();
  const model = (name: string) => {
    const m = d.db
      .select()
      .from(legModels)
      .where(and(eq(legModels.legId, oc.id), eq(legModels.model, name)))
      .get();
    if (!m) throw new Error(`no ${name}`);
    return m;
  };
  for (const [name, n] of Object.entries(records))
    d.registry.saveProfile(model(name).id, {
      overrides: {},
      observed: { research: { attempts: n, successes: n, tokens: 0, ms: 0, escalations: 0 } },
    });

  const ws = mkdtempSync(join(tmpdir(), "oraknid-simple-ws-"));
  sh(ws, "init", "-q", "-b", "master");
  sh(ws, "config", "user.email", "me@example.com");
  sh(ws, "config", "user.name", "Me");
  writeFileSync(join(ws, "README.md"), "# piano\n");
  sh(ws, "add", ".");
  sh(ws, "commit", "-qm", "start");
  const project = await api.projects.create({ name: "piano", workspacePath: ws });
  const { id } = await api.jobs.create({
    projectId: project.id,
    goal: "Pick the audio library",
    verify: [],
    autonomy: "auto",
    inputs: [],
    allowedLegIds: [],
    unsandboxed: false,
  });
  await api.jobs.start({ id });
  const job = await until(api, id, ["completed", "blocked", "failed"]);
  const tried = d.db
    .select()
    .from(attempts)
    .where(eq(attempts.jobId, id))
    .orderBy(attempts.startedAt)
    .all();
  const events = (await api.jobs.export({ id })).events;
  const name = (legModelId: string) => d.registry.model(legModelId)?.model ?? legModelId;
  return { d, api, id, ws, oc, cl, job, tried, events, model, name };
}

describe("agents that get simple work done (M13.22)", () => {
  it("rests a free model whose provider failed, gives the task to a proven one without counting it, and keeps the deliverable", async () => {
    /** The free Leg: OpenCode's own tmp asked for, then the provider's 500. */
    const free = scriptedLeg(
      (t: TurnContext): Action[] => {
        const jobHome = t.home ?? "/nowhere";
        // A job's home is <legs>/<leg>/jobs/<job>/home: the Leg's own is <legs>/<leg>/home.
        const legHome = join(jobHome, "..", "..", "..", "home");
        return [
          { ask: { tool: "ExternalDirectory", path: join(legHome, "tmp", "opencode", "*") } },
          { ask: { tool: "Write", path: join(legHome, "tmp", "opencode", "bench", "x.js") } },
          { ask: { tool: "Write", path: join(jobHome, "tmp", "opencode", "notes.md") } },
          { fail: "Internal server error" },
        ];
      },
      { kind: "opencode", models: ["big-pickle", "jev-1.13-free"] },
    );
    const w = await world(free, { "big-pickle": 6 });
    expect(w.job.state, w.job.blockedReason ?? "").toBe("completed");
    const pickle = w.model("big-pickle");

    // First on the free model, whose provider failed; then on Claude, a proven model.
    expect(w.tried.map((a) => [w.name(a.legModelId), a.outcome])).toEqual([
      ["big-pickle", "unavailable"],
      ["sonnet", "succeeded"],
    ]);
    // Not one attempt counted against the task, and the model's record untouched.
    expect(w.tried.filter((a) => a.outcome === "failed" || a.outcome === "reassigned")).toEqual([]);
    const row = w.d.registry.model(pickle.id);
    expect(row && w.d.registry.storedProfile(row).observed.research).toEqual({
      attempts: 6,
      successes: 6,
      tokens: 0,
      ms: 0,
      escalations: 0,
    });

    const failed = w.events.find((e) => e.type === "task.provider-failed");
    expect(failed?.payload).toMatchObject({ scope: "model", reason: "Internal server error" });
    // The model rests, said in the second attempt's routing; the next try isn't jev-1.13-free.
    expect(w.d.registry.cooldownOf(w.oc.id, pickle.id)?.reason).toBe("Internal server error");
    const second = routings(w.events)[1];
    expect([second?.leg, second?.model]).toEqual(["Claude", "sonnet"]);
    expect(second?.excluded.map((e) => e.why).join(" ")).toMatch(
      /Opencode · big-pickle: resting until .* after a provider failure \(Internal server error\)/,
    );

    // The deliverable its check names is no drift, and OpenCode's own tmp was its to write.
    expect(w.events.filter((e) => e.type === "task.drift" || e.type === "task.refused")).toEqual(
      [],
    );
    expect(free.asks.map((a) => a.allow)).toEqual([true, true, true]);
    const r = await w.api.jobs.result({ id: w.id });
    expect(sh(w.ws, "show", `${r.branch}:${DOC}`).stdout).toContain("Libraries Evaluated");
  }, 60_000);

  it("after two provider failures in a row on one Leg, goes to another Leg, though it has a proven model left", async () => {
    const errors: Record<string, string> = {
      "big-pickle": "Internal server error",
      "jev-1.13-free":
        "Error from provider (Console): Upstream request failed: Model is unavailable.",
    };
    const free = scriptedLeg((t) => [{ fail: errors[t.model] ?? "Internal server error" }], {
      kind: "opencode",
      models: ["big-pickle", "jev-1.13-free", "mimo-v2.6-flash-free"],
    });
    const w = await world(free, {
      "big-pickle": 6,
      "jev-1.13-free": 6,
      "mimo-v2.6-flash-free": 6,
    });
    expect(w.job.state, w.job.blockedReason ?? "").toBe("completed");
    expect(w.tried.map((a) => [w.name(a.legModelId), a.outcome])).toEqual([
      ["big-pickle", "unavailable"],
      ["jev-1.13-free", "unavailable"],
      ["sonnet", "succeeded"],
    ]);
    // A model gone at the provider rests longer than a 500.
    const pickle = w.d.registry.cooldownOf(w.oc.id, w.model("big-pickle").id);
    const jev = w.d.registry.cooldownOf(w.oc.id, w.model("jev-1.13-free").id);
    expect((jev?.until ?? 0) - (pickle?.until ?? 0)).toBeGreaterThan(20 * 60_000);
  }, 60_000);

  it("still counts an error that is the task's own against it", async () => {
    const free = scriptedLeg(() => [{ fail: "The model refused: the task makes no sense" }], {
      kind: "opencode",
      models: ["big-pickle"],
    });
    const w = await world(free, { "big-pickle": 6 });
    expect(w.tried[0]?.outcome).toBe("failed");
    expect(w.events.some((e) => e.type === "task.provider-failed")).toBe(false);
  }, 60_000);
});

/** Each attempt's routing record, in order. */
function routings(events: { type: string; payload: unknown }[]) {
  return events
    .filter((e) => e.type === "task.state" && (e.payload as { to?: string }).to === "running")
    .map(
      (e) =>
        (
          e.payload as {
            routing: { leg: string; model: string; excluded: { why: string }[] };
          }
        ).routing,
    );
}
