import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobView, ProjectWorkSettings, WebPlan } from "@oraknid/contracts";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import type { Router } from "../api/router.ts";
import { type Daemon, startDaemon } from "../daemon.ts";
import { sessions } from "../db/schema.ts";
import { notesFromText, type StandInReviews, standInReviews } from "../harness/reviews.ts";
import { resolvePaths } from "../paths.ts";
import { fakeOs } from "../testing/fake-os.ts";
import { fakeJudge } from "../testing/judge.ts";
import { type Action, scriptedLeg, type TurnContext } from "../testing/scripted-leg.ts";
import type { EyeBrain, EyeTriage } from "./brain.ts";
import { reviewEditOf } from "./evaluations.ts";
import { detectRun } from "./run-app.ts";

// Evaluation steps at work (ADR-064 §1–§3, M16.2) and the Keys job's
// lessons (§7, §8, M16.4), end to end with a scripted brain and Legs and
// the stand-in ReviewPort: no real agent, no real review page.

let daemon: Daemon | undefined;
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
});

const sh = (cwd: string, ...a: string[]) =>
  spawnSync("git", a, { cwd, encoding: "utf8" }).stdout.trim();

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "oraknid-eval-"));
  sh(dir, "init", "-q", "-b", "master");
  sh(dir, "config", "user.email", "me@example.com");
  sh(dir, "config", "user.name", "Me");
  writeFileSync(join(dir, "README.md"), "# keys\n");
  sh(dir, "add", ".");
  sh(dir, "commit", "-qm", "start");
  return dir;
}

const task = (t: TurnContext) => t.system.match(/# Your task: (.*)/)?.[1] ?? "";

type Planned = WebPlan["tasks"][number];
const work = (key: string, title: string, file: string, over: Partial<Planned> = {}): Planned => ({
  key,
  title,
  instructions: `Write ${file}.`,
  kind: "implement",
  dependsOn: [],
  scope: [file],
  verify: [`test -f ${file}`],
  requiredCapabilities: ["implementation"],
  difficulty: "low",
  ...over,
});

/** The Keys job's shape: a design, its review, a feature built on it, and an audio engine beside. */
const KEYS: WebPlan = {
  summary: "An instrument: its design first, reviewed, then the knobs; the audio engine beside.",
  tasks: [
    work("design", "Design the instrument's screens", "design/index.html", {
      scope: ["design/**"],
      requiredCapabilities: ["ui"],
    }),
    {
      key: "look",
      title: "Review the design",
      instructions: "The owner looks at the design.",
      kind: "evaluation",
      dependsOn: ["design"],
      scope: [],
      verify: [],
      requiredCapabilities: ["review"],
      difficulty: "low",
      evaluation: { kind: "design", why: "The layout decides everything after it." },
    },
    work("audio", "Build the audio engine", "audio.js"),
    work("knobs", "Build the knobs", "knobs.js", {
      dependsOn: ["design"],
      requiredCapabilities: ["ui", "implementation"],
    }),
  ],
  jobVerify: [],
};

/** Writes each task's file; the notes task rewrites the design. */
const builds = (t: TurnContext): Action[] => {
  const name = task(t);
  const file = /^Design |notes/i.test(name)
    ? "design/index.html"
    : name === "Build the audio engine"
      ? "audio.js"
      : name === "Build the knobs"
        ? "knobs.js"
        : name === "Build the keyboard"
          ? "keys.js"
          : name === "Build the sound designer"
            ? "designer.js"
            : "a.txt";
  return [{ write: file, content: `${name}\n` }, { say: "DONE" }];
};

async function world(o: {
  plan: WebPlan;
  script?: (t: TurnContext) => Action[];
  settings?: Partial<ProjectWorkSettings>;
  triage?: (message: string) => EyeTriage;
  draft?: boolean;
  /** Another Leg beside Claude A (an OpenCode one), and Claude A paused before the start. */
  other?: ReturnType<typeof scriptedLeg>;
  pauseClaude?: boolean;
}) {
  const dir = mkdtempSync(join(tmpdir(), "oraknid-evald-"));
  const leg = scriptedLeg(o.script ?? builds);
  const reviews = standInReviews();
  const brain = {
    plan: async () => o.plan,
    replan: async () => o.plan,
    summarize: async () => ({ title: "s", body: "s" }),
    evaluate: async () => ({ accepted: true, reason: "ok", missing: [] }),
    repairCheck: async ({ command }: { command: string }) => ({
      broken: false,
      command,
      reason: "",
    }),
    triage: async ({ message }: { message: string }) =>
      o.triage?.(message) ?? { intent: "instruction", reply: "Noted.", silk: null, tasks: [] },
    judgeAction: fakeJudge(() => ({ decision: "allow", reason: "fine" })),
    interviewRound: async () => ({ done: true, playback: "Clear.", questions: [], open: [] }),
  } as unknown as EyeBrain;
  daemon = await startDaemon({
    paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
    port: 0,
    dbFile: ":memory:",
    os: fakeOs({ keychain: true }).os,
    adapters: { "claude-code": leg.adapter, ...(o.other ? { opencode: o.other.adapter } : {}) },
    brain,
    metricsIntervalMs: 50,
    guardIntervalMs: 3_600_000,
    stallCheckMs: 100,
    reviews: reviews.port,
    appWaitMs: 20_000,
    reviewPassCheckMs: 100,
  });
  const api = createORPCClient<RouterClient<Router>>(
    new RPCLink({
      url: `${daemon.url}/api`,
      headers: { authorization: `Bearer ${daemon.cliToken}` },
    }),
  );
  const claude = await api.legs.create({ kind: "claude-code", name: "Claude A", config: {} });
  if (o.other) {
    const oc = await api.legs.create({ kind: "opencode", name: "OpenCode", config: {} });
    await daemon.health.check(oc.id);
  }
  if (o.pauseClaude) await api.legs.pause({ id: claude.id });
  const workspace = repo();
  const project = await api.projects.create({ name: "keys", workspacePath: workspace });
  if (o.settings) {
    const now = await api.projects.workSettings({ id: project.id });
    await api.projects.setWorkSettings({ id: project.id, settings: { ...now, ...o.settings } });
  }
  const { id } = await api.jobs.create({
    projectId: project.id,
    goal: "An instrument with knobs I can hear",
    verify: [],
    autonomy: "auto",
    inputs: [],
    allowedLegIds: [],
    unsandboxed: false,
  });
  if (!o.draft) await api.jobs.start({ id });
  return {
    d: daemon,
    api,
    id,
    leg,
    reviews,
    workspace,
    projectId: project.id,
    claudeId: claude.id,
  };
}

type Api = Awaited<ReturnType<typeof world>>["api"];

async function until(api: Api, id: string, states: string[], ms = 15_000): Promise<JobView> {
  const end = Date.now() + ms;
  for (;;) {
    const j = await api.jobs.get({ id });
    if (states.includes(j.state)) return j;
    if (Date.now() > end)
      throw new Error(
        `job stayed ${j.state} (${j.blockedReason ?? ""}): ${j.tasks.map((t) => `${t.title} ${t.state} ${t.waitingReason ?? ""}`).join("; ")}`,
      );
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function waitFor<T>(
  what: string,
  fn: () => T | null | undefined | Promise<T | null | undefined>,
  ms = 15_000,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`no ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const opened = (reviews: StandInReviews, round: number) =>
  waitFor(`review round ${round}`, () => reviews.opened.find((r) => r.round === round));

const sessionsOf = (d: Daemon, id: string, title: string, jobTitles: JobView) => {
  const t = jobTitles.tasks.find((x) => x.title === title);
  return t
    ? d.db
        .select()
        .from(sessions)
        .where(and(eq(sessions.jobId, id), eq(sessions.taskId, t.id)))
        .all().length
    : 0;
};

describe("a design review in the plan (M16.2)", () => {
  it("opens the design, waits for me, turns my notes into work, opens round 2, and on approval the features go on", async () => {
    const { d, api, id, reviews, leg } = await world({
      plan: KEYS,
      settings: { evaluations: { mode: "some", kinds: ["design"] } },
    });
    const first = await opened(reviews, 1);
    expect(first).toMatchObject({ jobId: id, kind: "design", round: 1 });
    expect(first.target).toEqual({ kind: "folder", path: expect.stringMatching(/\/design$/) });

    // The audio engine needs no design: it runs; the knobs wait for my approval.
    const waiting = await until(api, id, ["waiting"]);
    expect(waiting.blockedReason).toBe(`Waiting for your review of the design — Open ${first.url}`);
    const step = waiting.tasks.find((t) => t.kind === "evaluation");
    expect(step?.evaluation).toMatchObject({
      kind: "design",
      round: 1,
      waiting: true,
      url: first.url,
    });
    expect(waiting.tasks.find((t) => t.title === "Build the audio engine")?.state).toBe("done");
    expect(waiting.tasks.find((t) => t.title === "Build the knobs")?.dependsOn).toEqual([step?.id]);
    expect(sessionsOf(d, id, "Build the knobs", waiting)).toBe(0);

    // My notes: one to keep, one to change.
    reviews.sendNotes(first.reviewId, [
      { kind: "keep", text: "the dark panel", element: "div.panel" },
      { kind: "change", text: "bigger knobs", device: "phone" },
    ]);
    const second = await opened(reviews, 2);
    const mid = await api.jobs.get({ id });
    const notes = mid.tasks.find((t) => t.title === "Apply my notes on the design (round 1)");
    expect(notes?.state).toBe("done");
    expect(mid.tasks.find((t) => t.id === step?.id)?.dependsOn).toContain(notes?.id);
    expect(leg.log.find((t) => task(t) === notes?.title)?.system).toContain("bigger knobs");
    // The keep-note is a decision every later task is given.
    const silk = await api.silk.list({ jobId: id });
    expect(silk.find((e) => e.title === "Keep: the dark panel")).toMatchObject({
      kind: "decision",
    });
    expect(sessionsOf(d, id, "Build the knobs", mid)).toBe(0);

    reviews.approve(second.reviewId);
    const done = await until(api, id, ["completed", "blocked"]);
    expect(done.state, done.blockedReason ?? "").toBe("completed");
    expect(done.tasks.find((t) => t.id === step?.id)?.evaluation).toMatchObject({
      round: 2,
      outcome: "approved",
      waiting: false,
    });
    expect(leg.log.find((t) => task(t) === "Build the knobs")?.system).toContain("the dark panel");
  }, 60_000);

  it("adds no review when the project says none, and the features follow the design itself", async () => {
    const { api, id, reviews } = await world({
      plan: KEYS,
      settings: { evaluations: { mode: "none", kinds: [] } },
    });
    const done = await until(api, id, ["completed", "blocked", "waiting"]);
    expect(done.state, done.blockedReason ?? "").toBe("completed");
    expect(done.tasks.some((t) => t.kind === "evaluation")).toBe(false);
    const design = done.tasks.find((t) => t.title === "Design the instrument's screens");
    expect(done.tasks.find((t) => t.title === "Build the knobs")?.dependsOn).toEqual([design?.id]);
    expect(reviews.opened).toEqual([]);
  }, 60_000);

  it("a review passes by itself after the project's time, when it says so", async () => {
    const { api, id, reviews } = await world({
      plan: KEYS,
      settings: { evaluations: { mode: "some", kinds: ["design"] }, autoPassMinutes: 0.01 },
    });
    await opened(reviews, 1);
    const done = await until(api, id, ["completed", "blocked"]);
    expect(done.state, done.blockedReason ?? "").toBe("completed");
    expect(done.tasks.find((t) => t.kind === "evaluation")?.evaluation?.outcome).toBe(
      "auto-passed",
    );
  }, 60_000);
});

describe("an app review runs the app (M16.2)", () => {
  const SERVER = `require("node:http").createServer((q, s) => s.end("hello from the app")).listen(Number(process.env.PORT), "127.0.0.1");\n`;
  const APP: WebPlan = {
    summary: "A tiny app, then its review.",
    tasks: [
      work("app", "Build the app server", "server.js", { scope: ["server.js", "package.json"] }),
      {
        key: "try",
        title: "Review the running app",
        instructions: "I try it.",
        kind: "evaluation",
        dependsOn: ["app"],
        scope: [],
        verify: [],
        requiredCapabilities: ["review"],
        difficulty: "low",
        evaluation: { kind: "app", why: "I try it before it's done." },
      },
    ],
    jobVerify: [],
  };

  it("starts the dev server on a free port, opens the review on it, and stops it after", async () => {
    const { api, id, reviews } = await world({
      plan: APP,
      script: () => [
        {
          write: "package.json",
          content: JSON.stringify({ scripts: { dev: "node server.js" } }),
        },
        { write: "server.js", content: SERVER },
        { say: "DONE" },
      ],
    });
    const review = await opened(reviews, 1);
    expect(review.kind).toBe("app");
    if (review.target.kind !== "port") throw new Error("not on a port");
    const port = review.target.port;
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("hello from the app");
    reviews.approve(review.reviewId);
    const done = await until(api, id, ["completed", "blocked"]);
    expect(done.state, done.blockedReason ?? "").toBe("completed");
    await waitFor("the app stopped", async () =>
      fetch(`http://127.0.0.1:${port}/`).then(
        () => null,
        () => true,
      ),
    );
  }, 60_000);

  it("finds how the app runs: the plan's command, the dev script, the README, an index.html", () => {
    const dir = mkdtempSync(join(tmpdir(), "oraknid-run-"));
    expect(detectRun(dir)).toBeNull();
    expect(detectRun(dir, "make serve PORT=$PORT")?.from).toBe("the plan");
    writeFileSync(join(dir, "index.html"), "<h1>hi</h1>");
    expect(detectRun(dir)?.command).toMatch(/http\.server \$PORT/);
    writeFileSync(join(dir, "README.md"), "Run it:\n\n```\nnpm run serve\n```\n");
    expect(detectRun(dir)).toEqual({ command: "npm run serve", from: "README.md" });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
    writeFileSync(join(dir, "pnpm-lock.yaml"), "");
    expect(detectRun(dir)?.command).toBe(
      "pnpm run dev -- --port $PORT --strictPort --host 127.0.0.1",
    );
  });
});

describe("the chat edits the plan's reviews (M16.2)", () => {
  it("reads “skip reviews” and “add a review after X” in my words", () => {
    expect(reviewEditOf("skip reviews this time")).toEqual({ skip: true, add: [] });
    expect(reviewEditOf("No reviews please")).toEqual({ skip: true, add: [] });
    expect(reviewEditOf("add a review after the sound designer")).toEqual({
      skip: false,
      add: [{ after: "sound designer", kind: "checkpoint", why: null }],
    });
    expect(reviewEditOf("add a design review after the mock-ups.")?.add[0]?.kind).toBe("design");
    expect(reviewEditOf("make the knobs bigger")).toBeNull();
    expect(notesFromText("keep: the panel\nchange — bigger knobs\nit crackles")).toEqual([
      { kind: "keep", text: "the panel" },
      { kind: "change", text: "bigger knobs" },
      { kind: "general", text: "it crackles" },
    ]);
  });

  it("“skip reviews” while the job waits on one: skipped, and the work goes on", async () => {
    const { api, id, reviews } = await world({
      plan: KEYS,
      settings: { evaluations: { mode: "some", kinds: ["design"] } },
      triage: () => ({
        intent: "instruction",
        reply: "Skipping them.",
        silk: null,
        tasks: [],
        reviews: { skip: true, add: [] },
      }),
    });
    await opened(reviews, 1);
    await until(api, id, ["waiting"]);
    await api.jobs.talk({ id, text: "skip reviews this time" });
    const done = await until(api, id, ["completed", "blocked"]);
    expect(done.state, done.blockedReason ?? "").toBe("completed");
    const step = done.tasks.find((t) => t.kind === "evaluation");
    expect(step?.state).toBe("skipped");
    expect(step?.evaluation?.outcome).toBe("skipped");
    expect(done.tasks.find((t) => t.title === "Build the knobs")?.state).toBe("done");
  }, 60_000);

  it("“add a review after the keyboard”: the tasks after it wait for my approval", async () => {
    const CHAIN: WebPlan = {
      summary: "The keyboard, then the sound designer.",
      tasks: [
        work("keys", "Build the keyboard", "keys.js"),
        work("designer", "Build the sound designer", "designer.js", { dependsOn: ["keys"] }),
      ],
      jobVerify: [],
    };
    const { d, api, id, reviews } = await world({
      plan: CHAIN,
      settings: { evaluations: { mode: "none", kinds: [] } },
      script: (t) =>
        task(t) === "Build the keyboard" && t.turn === 1
          ? [{ run: "sleep 2" }, ...builds(t)]
          : builds(t),
    });
    await waitFor("the keyboard running", async () =>
      (await api.jobs.get({ id })).tasks.find((t) => t.state === "running"),
    );
    await api.jobs.talk({ id, text: "add a review after the keyboard" });
    const review = await opened(reviews, 1);
    const job = await api.jobs.get({ id });
    const step = job.tasks.find((t) => t.kind === "evaluation");
    expect(step?.title).toBe("Review the work so far after “Build the keyboard”");
    expect(job.tasks.find((t) => t.title === "Build the sound designer")?.dependsOn).toContain(
      step?.id,
    );
    expect(sessionsOf(d, id, "Build the sound designer", job)).toBe(0);
    reviews.approve(review.reviewId);
    const done = await until(api, id, ["completed", "blocked"]);
    expect(done.state, done.blockedReason ?? "").toBe("completed");
    const said = await api.jobs.conversation({ id });
    expect(said.some((m) => m.text.includes("I added “Review the work so far”"))).toBe(true);
  }, 60_000);
});

describe("the job ends in my project (ADR-064 §8, M16.4)", () => {
  const ONE: WebPlan = {
    summary: "One file.",
    tasks: [work("t1", "Write a.txt", "a.txt")],
    jobVerify: [],
  };

  it("merges a completed job into the work branch by default", async () => {
    const { api, id, workspace, d } = await world({ plan: ONE });
    const done = await until(api, id, ["completed", "blocked"]);
    expect(done.state, done.blockedReason ?? "").toBe("completed");
    const r = await api.jobs.result({ id });
    expect(r).toMatchObject({ merged: true });
    expect(sh(workspace, "show", `${r.into}:a.txt`)).toBe("Write a.txt");
    const merged = d.bus.since(0, [`job:${id}`], 2000).find((e) => e.type === "job.merged");
    expect(merged?.actor).toBe("eye");
  }, 60_000);

  it("asks first when the project says so, and merges on my answer", async () => {
    const { api, id, workspace } = await world({ plan: ONE, settings: { merge: "ask" } });
    const done = await until(api, id, ["completed", "blocked"]);
    expect(done.state, done.blockedReason ?? "").toBe("completed");
    const r = await api.jobs.result({ id });
    expect(r.merged).toBe(false);
    const q = await waitFor("the merge question", async () =>
      (await api.inbox.list({ state: "open" })).find((i) => i.title.startsWith("Merge “")),
    );
    expect(q.options).toEqual([`Merge into ${r.into}`, "Keep it on its branch"]);
    await api.inbox.answer({ id: q.id, answer: `Merge into ${r.into}` });
    await waitFor("the merge", async () => (await api.jobs.result({ id })).merged);
    expect(sh(workspace, "show", `${r.into}:a.txt`)).toBe("Write a.txt");
  }, 60_000);
});

describe("the ladder never stalls (ADR-064 §7, M16.4)", () => {
  it("with Claude paused, the strongest available model takes the task; after its failure I'm asked once", async () => {
    const hi = { ...work("t1", "Write a.txt", "a.txt"), verify: ["grep -qx hi a.txt"] };
    const other = scriptedLeg(
      (t) =>
        t.session === 1 && t.turn === 1
          ? [{ write: "a.txt", content: "hello\n" }, { say: "DONE" }]
          : [{ write: "a.txt", content: "hi\n" }, { say: "DONE" }],
      { kind: "opencode", models: ["big-pickle"] },
    );
    const { d, api, id, claudeId } = await world({
      plan: { summary: "One file.", tasks: [hi], jobVerify: [] },
      other,
      pauseClaude: true,
    });
    const done = await until(api, id, ["completed", "blocked"], 30_000);
    expect(done.state, done.blockedReason ?? "").toBe("completed");
    // Every turn on the model available, never "No Leg can take" while it can.
    expect(other.log.length).toBeGreaterThanOrEqual(2);
    const asked = (await api.inbox.list({})).filter((i) => i.title.includes("would help here"));
    expect(asked.map((i) => [i.title, i.options])).toEqual([
      [
        "Claude A would help here: unpause it, or go on with OpenCode?",
        ["Unpause Claude A", "Go on with OpenCode"],
      ],
    ]);
    expect(d.registry.require(claudeId).paused).toBe(true);
  }, 60_000);

  it("unpauses the Leg when I answer so, and the task climbs to it", async () => {
    const hi = { ...work("t1", "Write a.txt", "a.txt"), verify: ["grep -qx hi a.txt"] };
    // The available model never gets it right; Claude does, once it may.
    const other = scriptedLeg(() => [{ write: "a.txt", content: "hello\n" }, { say: "DONE" }], {
      kind: "opencode",
      models: ["big-pickle"],
    });
    const { d, api, id, claudeId, leg } = await world({
      plan: { summary: "One file.", tasks: [hi], jobVerify: [] },
      script: () => [{ write: "a.txt", content: "hi\n" }, { say: "DONE" }],
      other,
      pauseClaude: true,
    });
    const q = await waitFor("the question", async () =>
      (await api.inbox.list({ state: "open" })).find((i) => i.title.includes("would help here")),
    );
    // Asked without the work waiting on it: the job runs meanwhile.
    expect((await api.jobs.get({ id })).state).toBe("running");
    await api.inbox.answer({ id: q.id, answer: "Unpause Claude A" });
    await waitFor("Claude A unpaused", () => !d.registry.require(claudeId).paused || null);
    const done = await until(api, id, ["completed", "blocked"], 30_000);
    expect(done.state, done.blockedReason ?? "").toBe("completed");
    expect(leg.log.length).toBeGreaterThan(0);
  }, 60_000);
});
