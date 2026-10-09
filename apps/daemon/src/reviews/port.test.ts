import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event, JobView, WebPlan } from "@oraknid/contracts";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { afterEach, describe, expect, it } from "vitest";
import type { Router } from "../api/router.ts";
import { type Daemon, startDaemon } from "../daemon.ts";
import type { EyeBrain } from "../eye/brain.ts";
import { resolvePaths } from "../paths.ts";
import { fakeOs } from "../testing/fake-os.ts";
import { fakeJudge } from "../testing/judge.ts";
import { type Action, scriptedLeg, type TurnContext } from "../testing/scripted-leg.ts";

// The evaluation steps' port over the review page (ADR-064, M16.1 × M16.2),
// end to end: the job's program opens a design review on the page, I write
// a note and send it through the API, the job turns it into a new task and
// opens round 2 on the same review; Approve lets the work go on.

let daemon: Daemon | undefined;
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
});

const sh = (cwd: string, ...a: string[]) =>
  spawnSync("git", a, { cwd, encoding: "utf8" }).stdout.trim();

const task = (t: TurnContext) => t.system.match(/# Your task: (.*)/)?.[1] ?? "";

const PLAN: WebPlan = {
  summary: "A design, reviewed, then the knobs.",
  tasks: [
    {
      key: "design",
      title: "Design the instrument's screens",
      instructions: "Write design/index.html.",
      kind: "implement",
      dependsOn: [],
      scope: ["design/**"],
      verify: ["test -f design/index.html"],
      requiredCapabilities: ["ui"],
      difficulty: "low",
    },
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
    {
      key: "knobs",
      title: "Build the knobs",
      instructions: "Write knobs.js.",
      kind: "implement",
      dependsOn: ["look"],
      scope: ["knobs.js"],
      verify: ["test -f knobs.js"],
      requiredCapabilities: ["implementation"],
      difficulty: "low",
    },
  ],
  jobVerify: [],
};

const builds = (t: TurnContext): Action[] => {
  const name = task(t);
  const file = /^Design |notes/i.test(name) ? "design/index.html" : "knobs.js";
  return [
    { write: file, content: `<!doctype html><button id="play">${name}</button>\n` },
    { say: "DONE" },
  ];
};

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined>, ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`no ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("an evaluation step on the review page", () => {
  it("opens the design for review, takes my note through the API, makes it work, round 2, then Approve", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oraknid-review-port-"));
    const leg = scriptedLeg(builds);
    const brain = {
      plan: async () => PLAN,
      replan: async () => PLAN,
      summarize: async () => ({ title: "s", body: "s" }),
      evaluate: async () => ({ accepted: true, reason: "ok", missing: [] }),
      repairCheck: async ({ command }: { command: string }) => ({
        broken: false,
        command,
        reason: "",
      }),
      triage: async () => ({ intent: "instruction", reply: "Noted.", silk: null, tasks: [] }),
      judgeAction: fakeJudge(() => ({ decision: "allow", reason: "fine" })),
      interviewRound: async () => ({ done: true, playback: "Clear.", questions: [], open: [] }),
    } as unknown as EyeBrain;
    const d = await startDaemon({
      paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
      port: 0,
      dbFile: ":memory:",
      os: fakeOs({ keychain: true }).os,
      adapters: { "claude-code": leg.adapter },
      brain,
      metricsIntervalMs: 50,
      guardIntervalMs: 3_600_000,
      stallCheckMs: 100,
      reviewPassCheckMs: 100,
      // No `reviews`: the daemon's own, the review page.
    });
    daemon = d;
    const events: Event[] = [];
    d.bus.subscribe((e) => events.push(e));
    const api = createORPCClient<RouterClient<Router>>(
      new RPCLink({ url: `${d.url}/api`, headers: { authorization: `Bearer ${d.cliToken}` } }),
    );
    await api.legs.create({ kind: "claude-code", name: "Claude A", config: {} });
    const workspace = mkdtempSync(join(tmpdir(), "oraknid-review-port-repo-"));
    sh(workspace, "init", "-q", "-b", "master");
    sh(workspace, "config", "user.email", "me@example.com");
    sh(workspace, "config", "user.name", "Me");
    writeFileSync(join(workspace, "README.md"), "# keys\n");
    sh(workspace, "add", ".");
    sh(workspace, "commit", "-qm", "start");
    const project = await api.projects.create({ name: "keys", workspacePath: workspace });
    const settings = await api.projects.workSettings({ id: project.id });
    await api.projects.setWorkSettings({
      id: project.id,
      settings: { ...settings, evaluations: { mode: "some", kinds: ["design"] } },
    });
    const { id } = await api.jobs.create({
      projectId: project.id,
      goal: "An instrument with knobs I can hear",
      verify: [],
      autonomy: "auto",
      inputs: [],
      allowedLegIds: [],
      unsandboxed: false,
    });
    await api.jobs.start({ id });

    // The program opened the design on the page: a review, its inbox item, a tab asked for.
    const review = await waitFor(
      "a review",
      async () => (await api.reviews.list({ jobId: id }))[0],
    );
    expect(review).toMatchObject({ kind: "design", round: 1, state: "open" });
    expect(review.target).toMatch(/\/design$/);
    expect(review.frameUrl).toMatch(/^http:\/\/rv-[0-9a-f]{32}\.localhost:\d+\/$/);
    expect(events.find((e) => e.type === "review.opened")).toMatchObject({ jobId: id });
    const waiting = await waitFor("the job waiting", async () => {
      const j = await api.jobs.get({ id });
      return j.state === "waiting" ? j : null;
    });
    expect(waiting.tasks.find((t) => t.title === "Build the knobs")?.state).not.toBe("done");

    // My note on the page, sent.
    await api.reviews.notes.add({
      reviewId: review.id,
      kind: "change",
      text: "The play button is too small on the phone",
      device: { name: "Phone", width: 390, height: 844, orientation: "portrait" },
      element: {
        selector: "#play",
        text: "Play",
        tag: "button",
        box: { x: 0, y: 0, width: 40, height: 20 },
      },
    });
    await api.reviews.sendNotes({ id: review.id });
    expect(events.find((e) => e.type === "review.notes-sent")).toMatchObject({
      jobId: id,
      topic: `job:${id}`,
      payload: { reviewId: review.id },
    });

    // The job goes on: a task of my notes, then round 2 on the same review.
    const round2 = await waitFor("round 2", async () => {
      const r = await api.reviews.get({ id: review.id });
      return r.round === 2 && r.state === "open" ? r : null;
    });
    expect(round2.notes.map((n) => [n.round, n.text])).toEqual([
      [1, "The play button is too small on the phone"],
    ]);
    const mid: JobView = await api.jobs.get({ id });
    const notesTask = mid.tasks.find((t) => t.title === "Apply my notes on the design (round 1)");
    expect(notesTask?.state).toBe("done");
    const prompt = leg.log.find((t) => task(t) === notesTask?.title)?.system ?? "";
    expect(prompt).toContain("The play button is too small on the phone");
    expect(prompt).toContain("Phone 390×844");
    expect(prompt).toContain("#play");

    await api.reviews.approve({ id: review.id });
    const done = await waitFor("the end", async () => {
      const j = await api.jobs.get({ id });
      return ["completed", "blocked"].includes(j.state) ? j : null;
    });
    expect(done.state, done.blockedReason ?? "").toBe("completed");
    expect(done.tasks.find((t) => t.title === "Build the knobs")?.state).toBe("done");
    expect((await api.reviews.get({ id: review.id })).state).toBe("approved");
  }, 60_000);
});
