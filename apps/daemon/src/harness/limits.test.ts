import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebPlan } from "@oraknid/contracts";
import { preferredOf } from "@oraknid/leg-opencode";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { attempts } from "../db/schema.ts";
import { type Harness, harness, waitFor } from "../testing/harness-rig.ts";
import { scriptedLeg } from "../testing/scripted-leg.ts";
import { unusableOfEnd } from "./facts.ts";
import { AttemptLog } from "./log.ts";

// Limits are where the provider puts them (ADR-068), replayed from the Keys
// job of 2026-10-11: OpenCode's longcat-2.5-preview-free hit its rate limit
// after 17 minutes, and the whole Leg (big-pickle, which I use every day,
// with it) was marked out of quota; the job showed blocked for a 15-minute
// wait. Stand-in agents only; a stand-in home for my OpenCode's history.

let rig: Harness | undefined;
afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

const RATE = "Rate limit exceeded. Please try again later.";
const NOTES = "notes/keys.md";
const PLAN: WebPlan = {
  summary: "Write the notes.",
  tasks: [
    {
      key: "write-the-notes",
      title: "Write the notes",
      instructions: "Write the notes on keys.",
      kind: "implement",
      dependsOn: [],
      scope: ["notes/**"],
      verify: [`test -s ${NOTES}`],
      requiredCapabilities: ["implementation"],
      difficulty: "low",
    },
  ],
  jobVerify: [],
};
const good = () => [{ write: NOTES, content: "# Keys\n" }, { say: "DONE: wrote the notes." }];

/** A stand-in home whose OpenCode history says I use big-pickle. */
async function myOpenCode(): Promise<string> {
  const home = mkdtempSync(join(tmpdir(), "oraknid-owner-home-"));
  const dir = join(home, ".local", "share", "opencode");
  mkdirSync(dir, { recursive: true });
  const { DatabaseSync } = (await import("node:sqlite")) as unknown as {
    DatabaseSync: new (
      p: string,
    ) => {
      exec(s: string): void;
      prepare(s: string): { run(...a: unknown[]): void };
      close(): void;
    };
  };
  const db = new DatabaseSync(join(dir, "opencode.db"));
  db.exec(
    "CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)",
  );
  const put = db.prepare("INSERT INTO message VALUES (?, 's', 0, 0, ?)");
  for (let i = 0; i < 12; i++)
    put.run(
      `m${i}`,
      JSON.stringify({ role: "assistant", providerID: "opencode", modelID: "big-pickle" }),
    );
  db.close();
  return home;
}

const tried = (r: Harness, jobId: string) =>
  r.d.db
    .select()
    .from(attempts)
    .where(eq(attempts.jobId, jobId))
    .orderBy(attempts.startedAt)
    .all()
    .map((a) => [r.d.registry.model(a.legModelId)?.model, a.outcome]);

describe("a limit limits the model that hit it (ADR-068 §1, §2, §5, §6)", () => {
  it("one OpenCode model's rate limit leaves the Leg healthy; big-pickle, which I use, takes the work", async () => {
    const free = scriptedLeg(
      (t) => (t.model === "longcat-2.5-preview-free" ? [{ fail: RATE }] : good()),
      {
        kind: "opencode",
        models: ["longcat-2.5-preview-free", "big-pickle"],
        preferred: (home) => preferredOf(home),
      },
    );
    rig = await harness({
      legs: [{ kind: "opencode", name: "OpenCode", leg: free }],
      plan: PLAN,
      ownerHome: await myOpenCode(),
    });
    const legId = rig.legIds.OpenCode as string;
    const r = rig;
    // My OpenCode's history says I use big-pickle: learned from the Leg's check.
    await waitFor("my models", () => r.d.registry.preferredOf(legId).includes("big-pickle"));
    const models = rig.d.registry.models(legId);
    const id = (m: string) => models.find((x) => x.model === m)?.id as string;
    // longcat goes first here (big-pickle rated for harder work), so the limit is what moves it.
    rig.d.registry.setOverrides(id("big-pickle"), { maxDifficulty: "high" });
    rig.d.registry.setOverrides(id("longcat-2.5-preview-free"), { maxDifficulty: "low" });
    const { id: jobId } = await rig.repoJob("Write the notes");
    const done = await rig.ended(jobId);
    expect(done.state, done.blockedReason ?? "").toBe("completed");
    expect(tried(rig, jobId)).toEqual([
      ["longcat-2.5-preview-free", "unavailable"],
      ["big-pickle", "succeeded"],
    ]);
    // The Leg stays healthy; only longcat is limited, until about 15 minutes from now.
    const leg = rig.d.registry.require(legId);
    expect(leg.health).toBe("healthy");
    expect(leg.limitedUntil).toBeNull();
    const limit = rig.d.registry.limitOf(id("longcat-2.5-preview-free"));
    expect(limit?.reason).toBe(RATE);
    expect(rig.d.registry.limitOf(id("big-pickle"))).toBeNull();
    // A model refused for its pace is paced from now on.
    expect(rig.d.registry.paceOf(id("longcat-2.5-preview-free"))?.rpm).toBe(20);
    // Its routing says what happened, in plain words.
    const running = rig
      .events(jobId, "task.state")
      .filter((p) => p.to === "running")
      .map((p) => p.routing as { model: string; reasons: string[]; excluded: { why: string }[] });
    expect(running[1]?.model).toBe("big-pickle");
    expect(running[1]?.reasons[0]).toMatch(
      /^OpenCode's longcat-2\.5-preview-free is rate-limited until \d\d:\d\d; big-pickle takes the work\.$/,
    );
    expect(running[1]?.reasons).toContain("you use this one");
    expect(running[1]?.excluded.map((e) => e.why).join(" ")).toMatch(
      /OpenCode · longcat-2\.5-preview-free: rate-limited until/,
    );
    // The provider's words are on record: the agent's end and the outcome's reason.
    const first = rig.d.db
      .select()
      .from(attempts)
      .where(eq(attempts.jobId, jobId))
      .orderBy(attempts.startedAt)
      .get();
    const log = new AttemptLog(rig.d.db).attempt(first?.id as string, {
      kinds: ["AgentText", "Outcome"],
    });
    expect(log.find((e) => e.kind === "AgentText")?.data).toMatchObject({
      reason: "error",
      error: RATE,
    });
    expect(String(log.find((e) => e.kind === "Outcome")?.data.reason)).toMatch(
      /OpenCode's longcat-2\.5-preview-free is rate-limited until \d\d:\d\d; another model takes the work/,
    );
    // The Legs page shows which one I use, and the model's limit.
    const view = (await rig.api.legs.get({ id: legId })).models;
    expect(view.find((m) => m.model === "big-pickle")?.preferred).toBe(true);
    expect(view.find((m) => m.model === "longcat-2.5-preview-free")?.limit?.reason).toBe(RATE);
  }, 60_000);

  it("a second model of the same Leg limited meanwhile limits the Leg, and that scope is remembered", async () => {
    const free = scriptedLeg(() => good(), {
      kind: "opencode",
      models: ["longcat-2.5-preview-free", "nemotron-3-super-free", "big-pickle"],
    });
    rig = await harness({ legs: [{ kind: "opencode", name: "OpenCode", leg: free }], plan: PLAN });
    const reg = rig.d.registry;
    const legId = rig.legIds.OpenCode as string;
    const r = rig;
    await waitFor("its models", () => r.d.registry.models(legId).length === 3);
    const id = (m: string) => reg.models(legId).find((x) => x.model === m)?.id as string;
    const until = Date.now() + 15 * 60_000;
    expect(reg.limitHit(legId, id("longcat-2.5-preview-free"), until, RATE).scope).toBe("model");
    expect(reg.require(legId).health).toBe("healthy");
    expect(reg.limitScope(legId)).toBeNull();
    // The second, a different model, within the first's window: the account's limit.
    expect(reg.limitHit(legId, id("nemotron-3-super-free"), until, RATE).scope).toBe("leg");
    expect(reg.require(legId)).toMatchObject({ health: "rate-limited", limitedUntil: until });
    expect(reg.limitScope(legId)).toBe("account");
    // Remembered: next time, one model's limit is the Leg's at once.
    reg.setHealth(legId, "healthy", null, null);
    expect(reg.limitHit(legId, id("big-pickle"), until, RATE).scope).toBe("leg");
  }, 30_000);

  it("a Leg whose other model works while one is limited learns its limits are per model", async () => {
    const free = scriptedLeg(() => good(), {
      kind: "opencode",
      models: ["longcat-2.5-preview-free", "nemotron-3-super-free", "big-pickle"],
    });
    rig = await harness({ legs: [{ kind: "opencode", name: "OpenCode", leg: free }], plan: PLAN });
    const reg = rig.d.registry;
    const legId = rig.legIds.OpenCode as string;
    const r = rig;
    await waitFor("its models", () => r.d.registry.models(legId).length === 3);
    const id = (m: string) => reg.models(legId).find((x) => x.model === m)?.id as string;
    const until = Date.now() + 15 * 60_000;
    reg.limitHit(legId, id("longcat-2.5-preview-free"), until, RATE);
    reg.providerWorked(legId, id("big-pickle"));
    expect(reg.limitScope(legId)).toBe("model");
    // Then a second model limited stays that model's.
    expect(reg.limitHit(legId, id("nemotron-3-super-free"), until, RATE).scope).toBe("model");
    expect(reg.require(legId).health).toBe("healthy");
  }, 30_000);

  it("“Individual quota reached … upgrade” limits the whole Leg at once", async () => {
    const free = scriptedLeg(() => good(), {
      kind: "opencode",
      models: ["longcat-2.5-preview-free", "big-pickle"],
    });
    rig = await harness({ legs: [{ kind: "opencode", name: "OpenCode", leg: free }], plan: PLAN });
    const reg = rig.d.registry;
    const legId = rig.legIds.OpenCode as string;
    const r = rig;
    await waitFor("its models", () => r.d.registry.models(legId).length === 2);
    const model = reg.models(legId)[0]?.id as string;
    const said =
      "Individual quota reached. Please upgrade your subscription to increase your limits.";
    expect(reg.limitHit(legId, model, Date.now() + 3600_000, said).scope).toBe("leg");
    expect(reg.require(legId).health).toBe("rate-limited");
    expect(reg.limitScope(legId)).toBe("account");
  }, 30_000);
});

describe("a short limit is a wait, not a block (ADR-068 §3)", () => {
  it("with nothing else to run, the job waits for the model's 15 minutes, says until when, and goes on by itself", async () => {
    let clock = Date.now();
    let limited = true;
    const free = scriptedLeg(
      () => {
        if (!limited) return good();
        limited = false;
        return [{ fail: RATE }];
      },
      { kind: "opencode", models: ["big-pickle"] },
    );
    rig = await harness({
      legs: [{ kind: "opencode", name: "OpenCode", leg: free }],
      plan: PLAN,
      now: () => clock,
      routePollMs: 50,
    });
    const r = rig;
    const { id: jobId } = await rig.repoJob("Write the notes");
    // Waiting, saying for what and until when; the job is not blocked.
    const said = await waitFor("the wait", () =>
      r.events(jobId, "task.waiting-for-leg").find((p) => /rate limit/.test(String(p.reason))),
    );
    expect(String(said.reason)).toMatch(
      /^Waiting for OpenCode · big-pickle until \d\d:\d\d \(rate limit\), or another model sooner; it goes on by itself\.$/,
    );
    await new Promise((res) => setTimeout(res, 300));
    const waiting = await rig.api.jobs.get({ id: jobId });
    expect(waiting.state).toBe("running");
    expect(waiting.tasks[0]?.waitingReason).toBe(said.reason);
    expect(tried(rig, jobId)).toEqual([["big-pickle", "unavailable"]]);
    // Its 15 minutes pass: it goes on by itself, on the same model.
    clock += 16 * 60_000;
    const done = await rig.ended(jobId);
    expect(done.state, done.blockedReason ?? "").toBe("completed");
    expect(tried(rig, jobId)).toEqual([
      ["big-pickle", "unavailable"],
      ["big-pickle", "succeeded"],
    ]);
    expect(rig.events(jobId, "job.state").some((p) => p.to === "blocked")).toBe(false);
  }, 60_000);
});

describe("an error with no words, or a provider's 413, is never lost as the task's (ADR-068 §5)", () => {
  it("a 413 body in the error reads as too large; an empty error as its provider's", () => {
    const groq =
      'The model server answered 413: {"error":{"message":"Request too large for model `openai/gpt-oss-20b` in organization `org_1` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 15210, please reduce your message size and try again.","type":"tokens","code":"rate_limit_exceeded"}}';
    expect(unusableOfEnd(groq, "openai/gpt-oss-20b", Date.now())).toMatchObject({
      kind: "too-large",
      limit: 8000,
      requested: 15210,
    });
    expect(unusableOfEnd("", "openai/gpt-oss-20b", Date.now())).toMatchObject({
      kind: "provider",
      failure: { scope: "model" },
    });
    expect(unusableOfEnd(null, "m", Date.now())?.kind).toBe("provider");
  });
});
