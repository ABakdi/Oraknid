import type { WebPlan } from "@oraknid/contracts";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { sessions } from "../db/schema.ts";
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
      (t) => (hang ? [{ hang: true }] : [{ write: "parser.js", content: "x\n" }, { say: "DONE" }]),
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
