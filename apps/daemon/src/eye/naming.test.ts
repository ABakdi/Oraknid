import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobView, WebPlan } from "@oraknid/contracts";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import { afterEach, describe, expect, it } from "vitest";
import type { Router } from "../api/router.ts";
import { type Daemon, startDaemon } from "../daemon.ts";
import { eyeMessages, jobs, tasks } from "../db/schema.ts";
import { resolvePaths } from "../paths.ts";
import { fakeOs } from "../testing/fake-os.ts";
import { scriptedLeg } from "../testing/scripted-leg.ts";
import { BrainFailed, type EyeBrain, type JobNameInput, jobNameProblems } from "./brain.ts";

// Jobs-and-Projects → A job's name and description (M13.17).

let daemon: Daemon | undefined;
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
});

const sh = (cwd: string, ...a: string[]) =>
  spawnSync("git", a, { cwd, encoding: "utf8" }).stdout.trim();

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "oraknid-nm-"));
  sh(dir, "init", "-q", "-b", "master");
  sh(dir, "config", "user.email", "me@example.com");
  sh(dir, "config", "user.name", "Me");
  writeFileSync(join(dir, "README.md"), "# demo\n");
  sh(dir, "add", ".");
  sh(dir, "commit", "-qm", "start");
  return dir;
}

const ONE: WebPlan = {
  summary: "One file.",
  tasks: [
    {
      key: "t1",
      title: "Write a.txt",
      instructions: "Create a.txt.",
      kind: "implement",
      dependsOn: [],
      scope: ["a.txt"],
      verify: ["test -s a.txt"],
      requiredCapabilities: ["implementation"],
      difficulty: "low",
    },
  ],
  jobVerify: [],
};

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), "oraknid-nmd-"));
  const leg = scriptedLeg(() => [{ write: "a.txt", content: "a\n" }, { say: "DONE" }]);
  const calls: JobNameInput[] = [];
  const state = { model: true };
  const brain = {
    plan: async () => ONE,
    replan: async () => ONE,
    summarize: async () => ({ title: "s", body: "s" }),
    evaluate: async () => ({ accepted: true, reason: "ok", missing: [] }),
    repairCheck: async ({ command }: { command: string }) => ({
      broken: false,
      command,
      reason: "",
    }),
    triage: async () => ({ intent: "question", reply: "Fine.", silk: null, tasks: [] }),
    judgeAction: async () => ({ decision: "allow" as const, category: null, reason: "fine" }),
    interviewRound: async () => ({ done: true, playback: "Clear.", questions: [], open: [] }),
    summarizeJob: async () => ({ summary: "It wrote a.txt." }),
    nameJob: async (i: JobNameInput) => {
      calls.push(i);
      if (!state.model)
        throw new BrainFailed("No Leg can think for The Eye right now: there are no Legs.");
      return i.outcome
        ? {
            title: "Write the a file",
            description: "Wrote a.txt on its branch. Nothing is left to you.",
          }
        : { title: "Write the a file", description: "Creates a.txt for the demo." };
    },
  } as unknown as EyeBrain;
  daemon = await startDaemon({
    paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
    port: 0,
    dbFile: ":memory:",
    os: fakeOs({ keychain: true }).os,
    adapters: { "claude-code": leg.adapter },
    brain,
    metricsIntervalMs: 50,
    stallCheckMs: 100,
    naming: { backfillDelayMs: -1, gapMs: 0, retryMs: 60_000 },
  });
  const api = createORPCClient<RouterClient<Router>>(
    new RPCLink({
      url: `${daemon.url}/api`,
      headers: { authorization: `Bearer ${daemon.cliToken}` },
    }),
  );
  await api.legs.create({ kind: "claude-code", name: "Claude A", config: {} });
  const project = await api.projects.create({ name: "piano", workspacePath: repo() });
  return { d: daemon, api, projectId: project.id, calls, state };
}

type Api = Awaited<ReturnType<typeof harness>>["api"];

async function until(
  api: Api,
  id: string,
  ok: (j: JobView) => boolean,
  ms = 8000,
): Promise<JobView> {
  const end = Date.now() + ms;
  for (;;) {
    const j = await api.jobs.get({ id });
    if (ok(j)) return j;
    if (Date.now() > end) throw new Error(`job stayed ${j.state}, "${j.title}"`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const GOAL = "now you shoudl take a look and make sure everything is in a.txt\nand more words";

describe("a job's name and description (Jobs-and-Projects)", () => {
  it("names a job made from my message, then describes what it did once it ends", async () => {
    const { api, projectId, calls, d } = await harness();
    const named: unknown[] = [];
    d.bus.subscribe((e) => {
      if (e.type === "job.named") named.push(e.payload);
    });
    const { jobId } = await api.projects.talk({ id: projectId, text: GOAL });
    const done = await until(api, jobId, (j) => j.state === "completed");
    const j = await until(api, jobId, (x) => x.describedAs === "outcome");
    expect(j.title).toBe("Write the a file");
    expect(j.namedBy).toBe("eye");
    expect(j.description).toBe("Wrote a.txt on its branch. Nothing is left to you.");
    expect(done.goal).toBe(GOAL);
    // First what it's for, from the goal and the project; then what it did, from The Eye's report.
    expect(calls[0]).toMatchObject({ jobId, goal: GOAL, project: "piano" });
    expect(calls[0]?.outcome).toBeUndefined();
    const end = calls.find((c) => c.outcome);
    expect(end?.outcome).toContain("It wrote a.txt.");
    expect(end?.outcome).toContain("Branch:");
    expect(end?.quickOnly).toBeUndefined();
    expect(named).toContainEqual(
      expect.objectContaining({ id: jobId, describedAs: "purpose", namedBy: "eye" }),
    );
    // The report says what each Leg spent on the job (ADR-066 §6).
    const report = d.db
      .select()
      .from(eyeMessages)
      .where(eq(eyeMessages.jobId, jobId))
      .all()
      .map(
        (m) =>
          (m.action as { report?: { kind: string; facts: { label: string; value: string }[] } })
            ?.report,
      )
      .find((r) => r?.kind === "job-done");
    expect(report?.facts.find((f) => f.label === "Tokens · Claude A")?.value).toMatch(
      /^[\d.]+k? in · [\d.]+k? from cache · [\d.]+k? out$/,
    );
  }, 30_000);

  it("keeps a name I typed, and describes it", async () => {
    const { api, projectId, d } = await harness();
    const { id } = await api.jobs.create({ projectId, goal: GOAL, title: "My own name" });
    await d.naming.idle();
    const j = await api.jobs.get({ id });
    expect(j).toMatchObject({
      title: "My own name",
      namedBy: "me",
      description: "Creates a.txt for the demo.",
      describedAs: "purpose",
    });
  });

  it("renames a job; what I wrote is kept, even when it ends", async () => {
    const { api, projectId, d } = await harness();
    const { id } = await api.jobs.create({ projectId, goal: GOAL });
    await d.naming.idle();
    await api.jobs.rename({ id, title: "  Mine  ", description: "My words." });
    let j = await api.jobs.get({ id });
    expect(j).toMatchObject({
      title: "Mine",
      namedBy: "me",
      description: "My words.",
      describedAs: "mine",
    });
    await api.jobs.start({ id });
    await until(api, id, (x) => x.state === "completed");
    await new Promise((r) => setTimeout(r, 100));
    await d.naming.idle();
    j = await api.jobs.get({ id });
    expect(j).toMatchObject({ title: "Mine", description: "My words." });
    // A name alone, or a description alone.
    await api.jobs.rename({ id, description: "" });
    expect(await api.jobs.get({ id })).toMatchObject({ title: "Mine", description: null });
    await expect(api.jobs.rename({ id, title: "" })).rejects.toThrow();
  }, 30_000);

  it("without a model keeps the first line, and names it once one is there", async () => {
    const { api, projectId, d, state } = await harness();
    state.model = false;
    const { id } = await api.jobs.create({ projectId, goal: GOAL });
    await d.naming.idle();
    let j = await api.jobs.get({ id });
    expect(j.title).toBe("now you shoudl take a look and make sure everything is in…");
    expect(j).toMatchObject({ namedBy: null, description: null });
    state.model = true;
    // A Leg healthy again, or The Eye's models chosen: tried again.
    d.bus.publish({ type: "settings.updated", topic: "overview", jobId: null, payload: {} });
    await d.naming.idle();
    j = await api.jobs.get({ id });
    expect(j).toMatchObject({ title: "Write the a file", namedBy: "eye" });
  });

  it("names a draft whose goal I changed once, as it starts, never as I type (ADR-066 §2)", async () => {
    const { api, projectId, d, calls } = await harness();
    const { id } = await api.jobs.create({ projectId, goal: "first idea" });
    await d.naming.idle();
    // Typing: saved again and again, each a goal change; nobody is asked while it is a draft.
    for (const goal of ["second", "second idea", "second idea\nmore"]) {
      await api.jobs.updateDraft({ id, goal });
      await new Promise((r) => setTimeout(r, 30));
    }
    await d.naming.idle();
    expect((await api.jobs.get({ id })).title).toBe("second idea");
    expect(calls.map((c) => c.goal)).toEqual(["first idea"]);
    await api.jobs.start({ id });
    await until(api, id, (x) => x.state === "completed");
    await until(api, id, (x) => x.describedAs === "outcome");
    await d.naming.idle();
    // Named for the goal it started with, then described once when it ended: three calls in all.
    expect(calls.map((c) => [c.goal, !!c.outcome])).toEqual([
      ["first idea", false],
      ["second idea\nmore", false],
      ["second idea\nmore", true],
    ]);
  }, 30_000);

  it("names a job once in its whole life: made, started, blocked, resumed, done (ADR-066 §2)", async () => {
    const { api, projectId, d, calls } = await harness();
    const { jobId } = await api.projects.talk({ id: projectId, text: GOAL });
    await until(api, jobId, (j) => j.state === "completed");
    await until(api, jobId, (x) => x.describedAs === "outcome");
    await d.naming.idle();
    // A block on the way (a quota, a question) is no ending: nothing more is asked for it.
    d.bus.publish({
      type: "job.state",
      topic: `job:${jobId}`,
      jobId,
      payload: { from: "running", to: "blocked", reason: "Groq is out of quota until 14:05." },
    });
    await new Promise((r) => setTimeout(r, 100));
    await d.naming.idle();
    // The backfill at a restart leaves a named job alone.
    d.naming.backfill();
    await d.naming.idle();
    expect(calls.filter((c) => !c.outcome)).toHaveLength(1);
    expect(calls.filter((c) => c.outcome)).toHaveLength(1);
  }, 30_000);

  it("names older jobs at start: slowly, on the quick model, what they did when ended", async () => {
    const { api, projectId, d, calls } = await harness();
    const { id: old } = await api.jobs.create({ projectId, goal: GOAL });
    const { id: typed } = await api.jobs.create({ projectId, goal: "x", title: "Typed long ago" });
    const { id: ended } = await api.jobs.create({ projectId, goal: "finish the thing" });
    await d.naming.idle();
    calls.length = 0;
    // As they were before names: their first line, nobody's, no description.
    for (const id of [old, typed, ended])
      d.db
        .update(jobs)
        .set({ namedBy: null, description: null, describedAs: null, state: "paused" })
        .where(eq(jobs.id, id))
        .run();
    d.db
      .update(jobs)
      .set({ title: "now you shoudl take a look and make sure everything is in…", state: "paused" })
      .where(eq(jobs.id, old))
      .run();
    d.db
      .update(jobs)
      .set({ title: "finish the thing", state: "completed" })
      .where(eq(jobs.id, ended))
      .run();
    d.db
      .insert(tasks)
      .values({
        id: ulid(),
        jobId: ended,
        title: "Finish it",
        instructions: "",
        kind: "implement",
        scope: [],
        verify: [],
        requiredCapabilities: [],
        difficulty: "low",
        state: "done",
        position: 0,
        webVersion: 1,
      } as never)
      .run();
    d.db
      .insert(eyeMessages)
      .values({
        id: ulid(),
        jobId: ended,
        projectId,
        author: "eye",
        text: "The job is done. It finished the thing.",
        action: {
          intent: "report",
          did: [],
          silkIds: [],
          taskIds: [],
          jobId: null,
          report: { kind: "job-done", taskId: null, facts: [], todo: [] },
        },
        createdAt: 1,
      } as never)
      .run();
    d.naming.backfill();
    await d.naming.idle();
    expect(calls.every((c) => c.quickOnly)).toBe(true);
    expect(calls.map((c) => c.jobId).sort()).toEqual([old, ended].sort());
    expect(calls.find((c) => c.jobId === ended)?.outcome).toContain("It finished the thing.");
    expect(await api.jobs.get({ id: old })).toMatchObject({
      title: "Write the a file",
      describedAs: "purpose",
    });
    expect(await api.jobs.get({ id: typed })).toMatchObject({
      title: "Typed long ago",
      namedBy: "me",
      description: null,
    });
    expect(await api.jobs.get({ id: ended })).toMatchObject({
      title: "Write the a file",
      describedAs: "outcome",
    });
    // A job the backfill tried isn't tried again at the next restart, even if it stayed unnamed.
    d.db.update(jobs).set({ namedBy: null }).where(eq(jobs.id, old)).run();
    const before = calls.length;
    d.naming.backfill();
    await d.naming.idle();
    expect(calls.slice(before).some((c) => c.jobId === old)).toBe(false);
  });
});

describe("a name and description's checks", () => {
  it("wants plain words: one or two sentences, no markdown, a title without a full stop", () => {
    expect(
      jobNameProblems({ title: "Ship Phase 2 to GitHub", description: "Pushes it. Then a PR." }),
    ).toEqual([]);
    expect(jobNameProblems({ title: "**Ship**.", description: "One. Two. Three." })).toHaveLength(
      3,
    );
    expect(
      jobNameProblems({ title: "Fix login", description: "Fixes `auth.ts`.\n- and more" }),
    ).toHaveLength(1);
  });
});
