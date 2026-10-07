import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebPlan } from "@oraknid/contracts";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { attempts, sessions } from "../db/schema.ts";
import { forgetJobVerdicts, heldFor } from "../eye/auto-mode.ts";
import { type Harness, harness, waitFor } from "../testing/harness-rig.ts";
import { scriptedLeg, type TurnContext } from "../testing/scripted-leg.ts";

// The bugs a read-only map of the task harness found (ADR-056 stage 1,
// 2026-10-07), each pinned by a test that failed before its fix.

let rig: Harness | undefined;
afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

const taskOf = (t: TurnContext) => t.system.match(/# Your task: (.*)/)?.[1] ?? "";
const task = (
  key: string,
  title: string,
  verify: string[],
  scope: string[],
  over: Partial<WebPlan["tasks"][number]> = {},
): WebPlan["tasks"][number] => ({
  key,
  title,
  instructions: `${title}.`,
  kind: "implement",
  dependsOn: [],
  scope,
  verify,
  requiredCapabilities: ["implementation"],
  difficulty: "low",
  ...over,
});

describe("“Stop the job” stops the job (bug 1)", () => {
  it("stops the job's other running tasks and starts no new one", async () => {
    const leg = scriptedLeg((t) =>
      taskOf(t) === "Build the parser"
        ? [{ say: "I can't create it: owner action required: touch parser.js" }]
        : taskOf(t) === "Draw the logo"
          ? [{ hang: true }]
          : [{ write: "config.json", content: "{}\n" }, { say: "DONE" }],
    );
    rig = await harness({
      legs: [{ kind: "claude-code", name: "Claude A", leg }],
      plan: {
        summary: "Three parts.",
        tasks: [
          task("a", "Build the parser", ["test -f parser.js"], ["parser.js"]),
          task("b", "Draw the logo", ["test -f logo.svg"], ["logo.svg"]),
          task("c", "Write the config", ["test -f config.json"], ["config.json"]),
        ],
        jobVerify: [],
      },
    });
    await rig.api.settings.setMaxTasksPerJob({ max: 2 });
    await rig.api.legs.update({ id: rig.legIds["Claude A"] as string, maxSessions: 3 });
    const { id } = await rig.repoJob("Three parts");
    const asked = await rig.openItem(/needs `touch parser\.js/);
    await waitFor("the logo's session", () => leg.log.some((t) => taskOf(t) === "Draw the logo"));
    await rig.api.inbox.answer({ id: asked.id, answer: "Stop the job" });
    const done = await rig.ended(id);
    expect(done.state).toBe("cancelled");
    // The running task's session is ended, not left to run on.
    const open = await waitFor(
      "every session ended",
      () =>
        rig?.d.db
          .select()
          .from(sessions)
          .where(eq(sessions.jobId, id))
          .all()
          .every((s) => s.endedAt !== null) && "yes",
      5000,
    );
    expect(open).toBe("yes");
    // And nothing new started after I stopped it.
    await new Promise((r) => setTimeout(r, 500));
    expect(leg.log.some((t) => taskOf(t) === "Write the config")).toBe(false);
  }, 60_000);
});

describe("a task merged beside others is checked again with its own runners (bug 2)", () => {
  it("runs a server check of a parallel task on the server at the merge, and merges it", async () => {
    const leg = scriptedLeg((t) =>
      taskOf(t) === "Build the parser"
        ? [{ run: "sleep 1" }, { write: "parser.js", content: "x\n" }, { say: "DONE" }]
        : [{ run: "sleep 1" }, { write: "logo.svg", content: "<svg/>\n" }, { say: "DONE" }],
    );
    rig = await harness({
      legs: [{ kind: "claude-code", name: "Claude A", leg }],
      server: true,
      plan: {
        summary: "Two parts, each checked on the server too.",
        tasks: [
          task(
            "a",
            "Build the parser",
            ["test -f parser.js", "ssh oraknid-vps-one true"],
            ["parser.js"],
          ),
          task(
            "b",
            "Draw the logo",
            ["test -f logo.svg", "ssh oraknid-vps-one true"],
            ["logo.svg"],
          ),
        ],
        jobVerify: [],
      },
    });
    await rig.api.legs.update({ id: rig.legIds["Claude A"] as string, maxSessions: 2 });
    const { id } = await rig.repoJob("Two parts", { withServer: true });
    const done = await rig.ended(id, 30_000);
    expect(done.state, done.blockedReason ?? "").toBe("completed");
    expect(
      (await rig.api.silk.list({ jobId: id })).filter((e) => e.title.startsWith("Not merged")),
    ).toEqual([]);
    // The checks ran on the server: tried first, at each task, and at each merge.
    expect(rig.ssh?.commands.filter((c) => c === "true").length).toBeGreaterThanOrEqual(6);
  }, 60_000);

  it("stops redoing a task that passes alone and never merges, and says why", async () => {
    const leg = scriptedLeg((t) =>
      taskOf(t) === "Build the parser"
        ? [{ write: "parser.js", content: "x\n" }, { say: "DONE" }]
        : [{ write: "logo.svg", content: "<svg/>\n" }, { say: "DONE" }],
    );
    rig = await harness({
      legs: [{ kind: "claude-code", name: "Claude A", leg }],
      plan: {
        summary: "Two parts.",
        tasks: [
          task("a", "Build the parser", ["test -f parser.js"], ["parser.js"]),
          // True on the task's own branch only: never once merged.
          task(
            "b",
            "Draw the logo",
            ["test -f logo.svg && git rev-parse --abbrev-ref HEAD | grep -q -e --t-"],
            ["logo.svg"],
          ),
        ],
        jobVerify: [],
      },
    });
    await rig.api.legs.update({ id: rig.legIds["Claude A"] as string, maxSessions: 2 });
    const { id } = await rig.repoJob("Two parts");
    const done = await rig.ended(id, 45_000);
    expect(done.state).toBe("blocked");
    expect(done.blockedReason).toMatch(
      /^"Draw the logo" passed its checks alone but couldn't be merged with the other work 3 times/,
    );
  }, 60_000);
});

describe("the task's checks reach the session (bug 3)", () => {
  it("gives the agent's session its task's checks, for an agent that runs them itself", async () => {
    const leg = scriptedLeg(() => [{ write: "parser.js", content: "x\n" }, { say: "DONE" }]);
    rig = await harness({
      legs: [{ kind: "claude-code", name: "Claude A", leg }],
      plan: {
        summary: "A parser.",
        tasks: [task("a", "Build the parser", ["test -f parser.js"], ["parser.js"])],
        jobVerify: [],
      },
    });
    const { id } = await rig.repoJob("A parser");
    const done = await rig.ended(id);
    expect(done.state, done.blockedReason ?? "").toBe("completed");
    expect(leg.log[0]?.checks).toEqual(["test -f parser.js"]);
  }, 60_000);
});

describe("a session resumed by what its agent can do (bug 4)", () => {
  /** Runs the parser task until it hangs, pauses and resumes the job; the sessions it had. */
  async function pausedOnce(kind: "oraknid-agent" | "claude-code", resumable: boolean) {
    let hang = true;
    const leg = scriptedLeg(
      () => (hang ? [{ hang: true }] : [{ write: "parser.js", content: "x\n" }, { say: "DONE" }]),
      { kind, models: ["m1"], resumable },
    );
    rig = await harness({
      legs: [{ kind, name: "Agent", leg }],
      plan: {
        summary: "A parser.",
        tasks: [task("a", "Build the parser", ["test -f parser.js"], ["parser.js"])],
        jobVerify: [],
      },
    });
    const { id } = await rig.repoJob("A parser");
    await waitFor("its session", () => leg.log.length > 0);
    await new Promise((r) => setTimeout(r, 100));
    await rig.api.jobs.pause({ id });
    hang = false;
    await rig.api.jobs.resume({ id });
    const done = await rig.ended(id);
    expect(done.state, done.blockedReason ?? "").toBe("completed");
    return leg.log.map((x) => [x.session, x.resumeFrom]);
  }

  it("resumes Oraknid's own agent, whose probe says it can", async () => {
    expect(await pausedOnce("oraknid-agent", true)).toEqual([
      [1, null],
      [2, "Agent-session-1"],
    ]);
  }, 60_000);

  it("starts afresh where the agent's probe says it can't resume", async () => {
    expect(await pausedOnce("claude-code", false)).toEqual([
      [1, null],
      [2, null],
    ]);
  }, 60_000);
});

describe("checks run once per turn end (bug 5)", () => {
  it("doesn't run the checks again after the turn when Claude Code's Stop hook just ran them on the same work", async () => {
    const counter = join(mkdtempSync(join(tmpdir(), "oraknid-count-")), "runs");
    const leg = scriptedLeg(() => [{ write: "parser.js", content: "x\n" }, { say: "DONE" }], {
      stopHook: true,
    });
    rig = await harness({
      legs: [{ kind: "claude-code", name: "Claude A", leg }],
      plan: {
        summary: "A parser.",
        tasks: [task("a", "Build the parser", ["sh count.sh && test -f parser.js"], ["parser.js"])],
        jobVerify: [],
      },
    });
    const { id } = await rig.repoJob("A parser", {
      files: { "count.sh": `echo x >> ${counter}\n` },
    });
    const done = await rig.ended(id);
    expect(done.state, done.blockedReason ?? "").toBe("completed");
    // Once tried before the work (ADR-052 §2), once by the Stop hook; not a third time.
    expect(readFileSync(counter, "utf8").split("\n").filter(Boolean)).toHaveLength(2);
  }, 60_000);

  it("holds the turn while they fail, and at its end uses the run that let it end", async () => {
    const counter = join(mkdtempSync(join(tmpdir(), "oraknid-count-")), "runs");
    // The hook holds the turn once (the check fails), the agent writes it, then the hook passes.
    const leg = scriptedLeg(
      (t) =>
        t.turn === 1
          ? [{ say: "DONE" }]
          : [{ write: "parser.js", content: "x\n" }, { say: "DONE" }],
      { stopHook: true },
    );
    rig = await harness({
      legs: [{ kind: "claude-code", name: "Claude A", leg }],
      plan: {
        summary: "A parser.",
        tasks: [task("a", "Build the parser", ["sh count.sh && test -f parser.js"], ["parser.js"])],
        jobVerify: [],
      },
    });
    const { id } = await rig.repoJob("A parser", {
      files: { "count.sh": `echo x >> ${counter}\n` },
    });
    const done = await rig.ended(id);
    expect(done.state, done.blockedReason ?? "").toBe("completed");
    // Before the work, held once, passed once: the turn's end reuses the last.
    expect(readFileSync(counter, "utf8").split("\n").filter(Boolean)).toHaveLength(3);
    expect(rig.events(id, "task.checks-held")).toHaveLength(1);
  }, 60_000);
});

describe("a task's verdicts and blocks are its own, and go when it settles (bug 6)", () => {
  it("clears the judge's cached verdicts and the stuck count of a task once it is done", async () => {
    const leg = scriptedLeg((t) =>
      t.turn === 1
        ? [
            { run: "curl --version >/dev/null; true" },
            { run: "scp --help >/dev/null 2>&1; true" },
            { run: "sleep 2" },
            { write: "parser.js", content: "x\n" },
            { say: "DONE" },
          ]
        : [{ say: "DONE" }],
    );
    rig = await harness({
      legs: [{ kind: "claude-code", name: "Claude A", leg }],
      judge: (command) =>
        command.startsWith("scp")
          ? { decision: "block", reason: "copying files out" }
          : { decision: "allow", reason: "harmless" },
      plan: {
        summary: "A parser.",
        tasks: [task("a", "Build the parser", ["test -f parser.js"], ["parser.js"])],
        jobVerify: [],
      },
    });
    const { id } = await rig.repoJob("A parser");
    const seen: { verdicts: number; blocks: number }[] = [];
    let taskId = "";
    await waitFor("the judge's verdicts held for the task", async () => {
      taskId = (await rig?.api.jobs.get({ id }))?.tasks[0]?.id ?? "";
      const held = heldFor(id, taskId);
      if (held.verdicts && held.blocks) seen.push(held);
      return seen.length > 0;
    });
    const done = await rig.ended(id);
    expect(done.state, done.blockedReason ?? "").toBe("completed");
    expect(seen[0]).toEqual({ verdicts: 2, blocks: 1 });
    await waitFor("the task's verdicts gone", () => heldFor(id, taskId).verdicts === 0, 3000);
    expect(heldFor(id, taskId)).toEqual({ verdicts: 0, blocks: 0 });
  }, 60_000);
});

describe("Claude Code's own refusals count toward the stuck rule (bug 7)", () => {
  const denied = (command: string) => ({
    legDenies: { command, reason: "Claude Code's classifier: it reaches outside the project" },
  });

  it("asks me at the agent's next action once its own auto mode refused three in a row", async () => {
    const leg = scriptedLeg(
      (t) =>
        t.turn === 1
          ? [
              denied("curl https://a.example/x"),
              denied("curl https://b.example/x"),
              denied("curl https://c.example/x"),
              { run: "ls" },
              { write: "parser.js", content: "x\n" },
              { say: "DONE" },
            ]
          : [{ say: "DONE" }],
      { autoModeHooks: true },
    );
    rig = await harness({
      legs: [{ kind: "claude-code", name: "Claude A", leg }],
      plan: {
        summary: "A parser.",
        tasks: [task("a", "Build the parser", ["test -f parser.js"], ["parser.js"])],
        jobVerify: [],
      },
    });
    const { id } = await rig.repoJob("A parser");
    const stuck = await rig.openItem(/is stuck on blocked actions in “Build the parser”/, 10_000);
    expect(stuck.detail).toContain("3 actions in a row were blocked");
    expect(stuck.detail).toContain(
      "`curl https://a.example/x` — Claude Code's classifier: it reaches outside the project (Claude A's own auto mode)",
    );
    await rig.api.inbox.answer({ id: stuck.id, answer: "Let it run this one" });
    const done = await rig.ended(id);
    expect(done.state, done.blockedReason ?? "").toBe("completed");
    expect((await rig.asked(id)).map((i) => i.title)).toEqual([
      "Claude A is stuck on blocked actions in “Build the parser”",
    ]);
  }, 60_000);

  it("asks what the agent needs at the turn's end when nothing came after its refusals and a check fails", async () => {
    const leg = scriptedLeg(
      (t) =>
        t.turn === 1
          ? [
              denied("curl https://a.example/x"),
              denied("curl https://a.example/y"),
              denied("curl https://a.example/z"),
              { say: "I couldn't fetch what I needed." },
            ]
          : [{ write: "parser.js", content: "x\n" }, { say: "DONE" }],
      { autoModeHooks: true, models: ["opus"] },
    );
    rig = await harness({
      legs: [{ kind: "claude-code", name: "Claude A", leg }],
      plan: {
        summary: "A parser.",
        tasks: [task("a", "Build the parser", ["test -f parser.js"], ["parser.js"])],
        jobVerify: [],
      },
    });
    const { id } = await rig.repoJob("A parser");
    const asked = await rig.openItem(/^Claude A needs `curl https:\/\/a\.example\/z`/, 10_000);
    expect(asked.options).toEqual(["Allow", "I'll do it", "Leave it out", "Stop the job"]);
    await rig.api.inbox.answer({ id: asked.id, answer: "Do it without fetching anything." });
    const done = await rig.ended(id);
    expect(done.state, done.blockedReason ?? "").toBe("completed");
  }, 60_000);
});

describe("what an attempt learned survives a restart (bug 8)", () => {
  it("keeps a task untrusted after it read the web, and its blocks counted, across a restart of Oraknid", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oraknid-restart-"));
    const db = join(dir, "o.db");
    const plan: WebPlan = {
      summary: "A parser.",
      tasks: [task("a", "Build the parser", ["test -f parser.js"], ["parser.js"])],
      jobVerify: [],
    };
    const judge = (command: string) =>
      command.startsWith("scp")
        ? { decision: "block" as const, reason: "copying files out" }
        : { decision: "allow" as const, reason: "harmless" };
    // Before the restart: it reads the web, two of its commands are blocked, then it works on.
    const first = scriptedLeg(() => [
      { run: "curl --version >/dev/null; true" },
      { run: "scp a b" },
      { run: "scp c d" },
      { hang: true },
    ]);
    rig = await harness({
      legs: [{ kind: "claude-code", name: "Claude A", leg: first }],
      plan,
      judge,
      dataDir: dir,
      dbFile: db,
    });
    const { id } = await rig.repoJob("A parser");
    await waitFor(
      "two blocks",
      () => rig?.events(id, "task.refused").length === 2 && first.log.length > 0,
    );
    await rig.close();
    // A new process: nothing of the old one in memory.
    forgetJobVerdicts(id);

    // After it: a third block in a row is the stuck rule's; a gated action asks, untrusted.
    const again = scriptedLeg(() => [
      { run: "scp e f" },
      { run: "git merge --help >/dev/null 2>&1; true" },
      { write: "parser.js", content: "x\n" },
      { say: "DONE" },
    ]);
    rig = await harness({
      legs: [{ kind: "claude-code", name: "Claude A", leg: again }],
      plan,
      judge,
      dataDir: dir,
      dbFile: db,
      again: true,
    });
    const stuck = await rig.openItem(/is stuck on blocked actions/, 10_000);
    expect(stuck.detail).toContain("3 actions in a row were blocked");
    await rig.api.inbox.answer({ id: stuck.id, answer: "Keep it blocked" });
    const merge = await rig.openItem(/wants to run `git merge --help/, 10_000);
    expect(merge.detail).toContain("untrusted");
    await rig.api.inbox.answer({ id: merge.id, answer: "Approve" });
    const done = await rig.ended(id);
    expect(done.state, done.blockedReason ?? "").toBe("completed");
  }, 60_000);

  it("keeps what I refused refused across attempts: not asked again, refused at once (D8)", async () => {
    let hang = true;
    const leg = scriptedLeg(() =>
      hang
        ? [{ run: "nmap localhost" }, { hang: true }]
        : [{ run: "nmap localhost" }, { write: "parser.js", content: "x\n" }, { say: "DONE" }],
    );
    rig = await harness({
      legs: [{ kind: "claude-code", name: "Claude A", leg }],
      plan: {
        summary: "A parser.",
        tasks: [task("a", "Build the parser", ["test -f parser.js"], ["parser.js"])],
        jobVerify: [],
      },
    });
    const { id } = await rig.repoJob("A parser", { autonomy: "careful" });
    const plan = await rig.openItem(/^Approve the plan/);
    await rig.api.inbox.answer({ id: plan.id, answer: "Approve" });
    const nmap = await rig.openItem(/wants to run `nmap localhost`/);
    await rig.api.inbox.answer({ id: nmap.id, answer: "Deny" });
    await new Promise((r) => setTimeout(r, 200));
    await rig.api.jobs.pause({ id });
    hang = false;
    await rig.api.jobs.resume({ id });
    // Refused at once, not asked again: the task goes on and is done.
    const done = await rig.ended(id);
    expect(done.state, done.blockedReason ?? "").toBe("completed");
    expect(
      (await rig.asked(id)).filter((i) => /wants to run `nmap localhost`/.test(i.title)),
    ).toHaveLength(1);
  }, 60_000);
});

describe("questions The Eye raised in an attempt go with it after a crash (bug 9)", () => {
  it("withdraws the question an attempt cut short by a crash had asked, and asks once again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oraknid-crash-"));
    const db = join(dir, "o.db");
    const plan: WebPlan = {
      summary: "A parser.",
      tasks: [task("a", "Build the parser", ["test -f parser.js"], ["parser.js"])],
      jobVerify: [],
    };
    const needs = () =>
      scriptedLeg(() => [{ say: "I can't create it: owner action required: touch parser.js" }], {
        models: ["opus"],
      });
    // The first Oraknid asks, then dies: nothing of it runs any more (it is left as it is).
    const crashed = await harness({
      legs: [{ kind: "claude-code", name: "Claude A", leg: needs() }],
      plan,
      dataDir: dir,
      dbFile: db,
    });
    try {
      const { id } = await crashed.repoJob("A parser");
      const stale = await crashed.openItem(/needs `touch parser\.js/);
      rig = await harness({
        legs: [{ kind: "claude-code", name: "Claude A", leg: needs() }],
        plan,
        dataDir: dir,
        dbFile: db,
        again: true,
      });
      const fresh = await waitFor("the question asked again", async () =>
        (await rig?.api.inbox.list({ state: "open" }))?.find(
          (i) => i.id !== stale.id && /needs `touch parser\.js/.test(i.title),
        ),
      );
      expect((await rig.api.inbox.list({ state: "open" })).map((i) => i.id)).toEqual([fresh.id]);
      expect((await rig.api.inbox.list({ state: "withdrawn" })).map((i) => i.id)).toContain(
        stale.id,
      );
      expect(fresh.jobId).toBe(id);
    } finally {
      await rig?.close();
      rig = undefined;
      await crashed.close();
    }
  }, 60_000);
});

describe("my answers to “keeps going wrong” (bugs 10, 11)", () => {
  /** A task whose agent edits outside its scope every turn until `fixed`, asked of me at last. */
  async function goingWrong(fixed: () => boolean) {
    const leg = scriptedLeg((t) => [
      { write: "parser.js", content: "x\n" },
      ...(fixed() ? [] : [{ write: "package.json", content: `{"turn":${t.turn}}\n` }]),
      { say: "DONE" },
    ]);
    rig = await harness({
      legs: [{ kind: "claude-code", name: "Claude A", leg }],
      plan: {
        summary: "A parser.",
        tasks: [task("a", "Build the parser", ["test -f parser.js"], ["parser.js"])],
        jobVerify: [],
      },
    });
    const { id, projectId } = await rig.repoJob("A parser");
    const item = await rig.openItem(/keeps going wrong/, 40_000);
    return { id, projectId, item };
  }
  const outcomes = (jobId: string) =>
    rig?.d.db
      .select()
      .from(attempts)
      .where(eq(attempts.jobId, jobId))
      .orderBy(attempts.startedAt)
      .all() ?? [];
  /** What the models' records say of implement tasks: attempts learned from, in all. */
  const learned = () =>
    (rig?.d.registry.models(rig.legIds["Claude A"] as string) ?? []).reduce(
      (n, m) => n + (rig?.d.registry.storedProfile(m).observed.implement?.attempts ?? 0),
      0,
    );

  it("“Try again with my advice” doesn't spend an attempt of the task's limit (bug 10)", async () => {
    let fixed = false;
    const { id, item } = await goingWrong(() => fixed);
    fixed = true;
    await rig?.api.inbox.answer({
      id: item.id,
      answers: [
        { questionId: "what", options: ["advice"], text: "" },
        { questionId: "advice", options: [], text: "Only touch parser.js." },
      ],
    });
    const done = await rig?.ended(id);
    expect(done?.state, done?.blockedReason ?? "").toBe("completed");
    const all = outcomes(id);
    // The attempt my answer ended is mine to redirect, not a failure of the task.
    expect(all.at(-2)?.outcome).toBe("redirected");
    expect(all.at(-1)?.outcome).toBe("succeeded");
  }, 60_000);

  it("“Leave it out” says nothing of the model: no failure recorded (bug 11)", async () => {
    const { id, item } = await goingWrong(() => false);
    const before = learned();
    await rig?.api.inbox.answer({
      id: item.id,
      answers: [{ questionId: "what", options: ["leave-out"], text: "" }],
    });
    const done = await rig?.ended(id);
    expect(done?.tasks.map((t) => t.state)).toEqual(["skipped"]);
    expect(outcomes(id).at(-1)?.outcome).toBe("abandoned");
    expect(learned()).toBe(before);
  }, 60_000);
});
