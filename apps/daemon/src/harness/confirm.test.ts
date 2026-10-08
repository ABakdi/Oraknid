import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { WebPlan } from "@oraknid/contracts";
import { and, asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { attemptEvents } from "../db/schema.ts";
import type { DriftAnswer } from "../eye/brain.ts";
import { conversation } from "../eye/talk.ts";
import { type Harness, harness } from "../testing/harness-rig.ts";
import { scriptedLeg } from "../testing/scripted-leg.ts";

// Monitors suspect, a model confirms (ADR-056), end to end with stand-in
// agents and a scripted drift judge: the keys scaffold, a real edit out of
// scope, the agent asked when the judge is unsure, a judge too slow, a
// by-product learned for the project, and D7/D8 never waiting on a judge.

let rig: Harness | undefined;
afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

const plan = (over: Partial<WebPlan["tasks"][number]> = {}): WebPlan => ({
  summary: "A password keeper.",
  tasks: [
    {
      key: "a",
      title: "Scaffold the app",
      instructions: "Scaffold a Vite + TypeScript app: install, build, and a main module.",
      kind: "implement",
      dependsOn: [],
      scope: ["src/**"],
      verify: ["test -f src/main.ts"],
      requiredCapabilities: ["implementation"],
      difficulty: "low",
      ...over,
    },
  ],
  jobVerify: [],
});

/** A scripted drift judge: what it is asked, and its answer by the prompt and the stage. */
function judge(answer: (prompt: string, stage: 1 | 2) => DriftAnswer | Promise<DriftAnswer>) {
  const calls: { stage: 1 | 2; prompt: string }[] = [];
  return {
    calls,
    judgeDrift: async ({ stage, prompt }: { stage: 1 | 2; prompt: string }) => {
      calls.push({ stage, prompt });
      return answer(prompt, stage);
    },
  };
}

const expected = (byProducts: string[] = []): DriftAnswer => ({
  verdict: "expected",
  reason: "the scaffold needs it",
  byProducts,
});

/** What the job told me: its inbox items, and The Eye's words in its conversation. */
async function toldMe(h: Harness, jobId: string) {
  return {
    asked: await h.asked(jobId),
    said: conversation(h.d.db, jobId)
      .filter((m) => m.author === "eye")
      .map((m) => m.text)
      .filter((t) => /drift|scope|outside|suspic/i.test(t)),
  };
}

/** The job's attempt log, of one kind of event: where suspicions are recorded, and only there. */
const logged = (h: Harness, jobId: string, kind: "Judged" | "SuspicionAsked") =>
  h.d.db
    .select()
    .from(attemptEvents)
    .where(and(eq(attemptEvents.jobId, jobId), eq(attemptEvents.kind, kind)))
    .orderBy(asc(attemptEvents.id))
    .all()
    .map((e) => e.data);

describe("the keys scaffold (2026-10-08): installs and builds are never drift", () => {
  it("pnpm install and build, files the scaffold needs at the top: done, no ladder, nothing said", async () => {
    const j = judge(() => expected());
    const leg = scriptedLeg(() => [
      { run: "pnpm install", instead: () => "Packages: +120" },
      { write: "node_modules/vite/package.json", content: "{}\n" },
      { write: "node_modules/.pnpm/lock.yaml", content: "x\n" },
      { write: "pnpm-lock.yaml", content: "lockfileVersion: 9\n" },
      { write: "src/main.ts", content: "console.log('keys');\n" },
      { write: "index.html", content: "<script src=/src/main.ts></script>\n" },
      { write: "vite.config.ts", content: "export default {};\n" },
      { run: "pnpm build", instead: () => "dist/index.html built" },
      { write: "dist/index.html", content: "<html></html>\n" },
      { write: "dist/assets/index-abc.js", content: "x\n" },
      { write: "tsconfig.tsbuildinfo", content: "{}\n" },
      { say: "DONE" },
    ]);
    rig = await harness({
      legs: [{ kind: "claude-code", name: "Codex", leg }],
      plan: plan(),
      brain: { judgeDrift: j.judgeDrift },
    });
    const { id } = await rig.repoJob("A password keeper");
    const done = await rig.ended(id);
    expect(done.state, done.blockedReason ?? "").toBe("completed");
    expect(rig.events(id, "task.drift")).toEqual([]);
    expect(leg.log).toHaveLength(1);
    // Only what the conventions don't know went to the judge: never dist/, node_modules/ or the lockfile.
    expect(j.calls).toHaveLength(1);
    const paths = /\nPaths:\n([\s\S]*?)\n\n/.exec(j.calls[0]?.prompt ?? "")?.[1];
    expect(paths).toBe("- index.html\n- vite.config.ts");
    expect(logged(rig, id, "Judged")).toMatchObject([
      { code: "D1", verdict: "expected", stage: 1 },
    ]);
    expect(await toldMe(rig, id)).toEqual({ asked: [], said: [] });
  }, 60_000);
});

describe("a real edit out of scope", () => {
  it("README.md changed by a task scoped to src/: the judge says drift, it is corrected and put back", async () => {
    const j = judge(() => ({
      verdict: "drift",
      reason: "the README isn't this task's",
      byProducts: [],
    }));
    const leg = scriptedLeg((t) =>
      t.turn === 1
        ? [
            { write: "src/main.ts", content: "x\n" },
            { write: "README.md", content: "# rewritten\n" },
            { say: "DONE" },
          ]
        : [{ say: "DONE" }],
    );
    rig = await harness({
      legs: [{ kind: "claude-code", name: "Codex", leg }],
      plan: plan(),
      brain: { judgeDrift: j.judgeDrift },
    });
    const { id, workspace } = await rig.repoJob("A password keeper");
    const done = await rig.ended(id);
    expect(done.state, done.blockedReason ?? "").toBe("completed");
    expect(rig.events(id, "task.drift")).toMatchObject([{ code: "D1", step: "correct" }]);
    expect(leg.log[1]?.message).toMatch(/README\.md[\s\S]*Only change files in: src\/\*\*/);
    expect(j.calls.map((c) => c.stage)).toEqual([1, 2]);
    expect(readFileSync(join(workspace, "README.md"), "utf8")).toBe("# demo\n");
  }, 60_000);
});

describe("the judge unsure: the agent is asked once", () => {
  it("its answer goes to the judge, whose verdict stands", async () => {
    const j = judge((prompt) =>
      /# Oraknid asked the agent about it/.test(prompt)
        ? expected()
        : { verdict: "unsure", reason: "can't tell", byProducts: [] },
    );
    const leg = scriptedLeg((t) =>
      t.turn === 1
        ? [
            { write: "src/main.ts", content: "x\n" },
            { write: "config/app.json", content: "{}\n" },
            { say: "DONE" },
          ]
        : [{ say: "Yes: the app reads config/app.json at start; the task needs it. DONE" }],
    );
    rig = await harness({
      legs: [{ kind: "claude-code", name: "Codex", leg }],
      plan: plan(),
      brain: { judgeDrift: j.judgeDrift },
    });
    const { id } = await rig.repoJob("A password keeper");
    const done = await rig.ended(id);
    expect(done.state, done.blockedReason ?? "").toBe("completed");
    expect(leg.log).toHaveLength(2);
    expect(leg.log[1]?.message).toMatch(
      /you changed config\/app\.json, outside the task's listed scope \(src\/\*\*, src\/main\.ts\)\. Is that part of doing the task/,
    );
    // Unsure at both stages, then asked; the answer judged at stage 1.
    expect(j.calls.map((c) => c.stage)).toEqual([1, 2, 1]);
    expect(j.calls[2]?.prompt).toMatch(/Answer: "Yes: the app reads config\/app\.json/);
    expect(logged(rig, id, "SuspicionAsked")).toHaveLength(1);
    expect(rig.events(id, "task.drift")).toEqual([]);
    expect(await toldMe(rig, id)).toEqual({ asked: [], said: [] });
  }, 60_000);
});

describe("a judge that doesn't answer", () => {
  it("falls back to the gentlest step: corrected each time, never reset, reassigned or killed", async () => {
    const j = judge(() => new Promise<DriftAnswer>(() => {}));
    const leg = scriptedLeg((t) =>
      t.turn <= 3
        ? [
            { write: "src/main.ts", content: `${t.turn}\n` },
            { write: "README.md", content: `# take ${t.turn}\n` },
            { say: "DONE" },
          ]
        : [{ say: "DONE" }],
    );
    rig = await harness({
      legs: [{ kind: "claude-code", name: "Codex", leg }],
      plan: plan(),
      brain: { judgeDrift: j.judgeDrift },
      driftJudgeMs: 200,
    });
    const { id } = await rig.repoJob("A password keeper");
    const done = await rig.ended(id);
    expect(done.state, done.blockedReason ?? "").toBe("completed");
    expect(rig.events(id, "task.drift").map((e) => e.step)).toEqual([
      "correct",
      "correct",
      "correct",
    ]);
    expect(new Set(leg.log.map((t) => t.session))).toEqual(new Set([1]));
    expect(logged(rig, id, "Judged")[0]).toMatchObject({ verdict: "unjudged" });
  }, 60_000);
});

describe("learned for the project", () => {
  it("a by-product the judge names is fast path for the project's next job: no judge", async () => {
    const j = judge(() => expected(["gen/**"]));
    const leg = scriptedLeg(() => [
      { run: "npx openapi-typescript api.yaml -o gen/api.ts", instead: () => "written" },
      { write: "gen/api.ts", content: "export type A = 1;\n" },
      { write: "src/main.ts", content: "x\n" },
      { say: "DONE" },
    ]);
    rig = await harness({
      legs: [{ kind: "claude-code", name: "Codex", leg }],
      plan: plan(),
      brain: { judgeDrift: j.judgeDrift },
    });
    const first = await rig.repoJob("A password keeper");
    expect((await rig.ended(first.id)).state).toBe("completed");
    expect(j.calls).toHaveLength(1);
    expect(logged(rig, first.id, "Judged")).toMatchObject([{ learned: ["gen/**"] }]);

    const { id } = await rig.api.jobs.create({
      projectId: first.projectId,
      goal: "The same again",
      verify: [],
      autonomy: "auto",
      inputs: [],
      allowedLegIds: [],
      unsandboxed: false,
    });
    await rig.api.jobs.start({ id });
    expect((await rig.ended(id)).state).toBe("completed");
    expect(j.calls).toHaveLength(1);
    expect(logged(rig, id, "Judged")).toEqual([]);
  }, 60_000);
});

describe("hard rules never wait on a judge", () => {
  it("a forbidden command (D7) is corrected at once, the judge never asked", async () => {
    const j = judge(() => expected());
    const leg = scriptedLeg((t) =>
      t.turn === 1
        ? [{ run: "sudo ls" }, { write: "src/main.ts", content: "x\n" }, { say: "DONE" }]
        : [{ say: "DONE" }],
    );
    rig = await harness({
      legs: [{ kind: "claude-code", name: "Codex", leg }],
      plan: plan(),
      brain: { judgeDrift: j.judgeDrift },
    });
    const { id } = await rig.repoJob("A password keeper");
    expect((await rig.ended(id)).state).toBe("completed");
    expect(rig.events(id, "task.drift")).toMatchObject([{ code: "D7", step: "correct" }]);
    expect(j.calls).toEqual([]);
  }, 60_000);

  it("a refused gate tried again (D8) is killed at once, the judge never asked", async () => {
    const j = judge(() => expected());
    let tries = 0;
    const leg = scriptedLeg(() =>
      tries++ === 0
        ? [
            { run: "nmap localhost" },
            { run: "nmap localhost" },
            { write: "src/main.ts", content: "x\n" },
            { say: "DONE" },
          ]
        : [{ write: "src/main.ts", content: "y\n" }, { say: "DONE" }],
    );
    rig = await harness({
      legs: [{ kind: "claude-code", name: "Codex", leg }],
      plan: plan(),
      brain: { judgeDrift: j.judgeDrift },
    });
    const { id } = await rig.repoJob("A password keeper", { autonomy: "careful" });
    const approve = await rig.openItem(/^Approve the plan/);
    await rig.api.inbox.answer({ id: approve.id, answer: "Approve" });
    const nmap = await rig.openItem(/wants to run `nmap localhost`/);
    await rig.api.inbox.answer({ id: nmap.id, answer: "Deny" });
    expect((await rig.ended(id)).state).toBe("completed");
    expect(rig.events(id, "task.drift")).toMatchObject([{ code: "D8", step: "kill" }]);
    expect(j.calls).toEqual([]);
  }, 60_000);
});
