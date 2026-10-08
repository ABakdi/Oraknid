import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebPlan } from "@oraknid/contracts";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { attempts } from "../db/schema.ts";
import { type Harness, harness, waitFor } from "../testing/harness-rig.ts";
import { scriptedLeg } from "../testing/scripted-leg.ts";
import { type ControllerState, TRANSITIONS } from "./controller.ts";
import { AttemptLog } from "./log.ts";

// ADR-056 stage 5, end to end: sessions by the Leg's capabilities with
// their declared fallbacks, the TaskController's transitions in the log,
// and what a restart left uncertain reconciled, never re-run.

let rig: Harness | undefined;
afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

const PLAN: WebPlan = {
  summary: "A parser.",
  tasks: [
    {
      key: "a",
      title: "Build the parser",
      instructions: "Build the parser.",
      kind: "implement",
      dependsOn: [],
      scope: ["parser.js"],
      verify: ["test -f parser.js"],
      requiredCapabilities: ["implementation"],
      difficulty: "low",
    },
  ],
  jobVerify: [],
};

const attemptsOf = (h: Harness, jobId: string) =>
  h.d.db
    .select()
    .from(attempts)
    .where(eq(attempts.jobId, jobId))
    .all()
    .sort((a, b) => a.startedAt - b.startedAt);

const logOf = (h: Harness, jobId: string) => {
  const log = new AttemptLog(h.d.db);
  return attemptsOf(h, jobId).flatMap((a) => log.attempt(a.id, { limit: 1000 }));
};

describe("sessions by the Leg's capabilities, each fallback declared (ADR-056 §2)", () => {
  it("no inline gate: what it ran unasked is audited after the fact and corrected (D7)", async () => {
    const leg = scriptedLeg(
      (t) =>
        t.turn === 1
          ? [
              { runUnasked: "sudo rm -rf /var/www" },
              { write: "parser.js", content: "x\n" },
              { say: "DONE" },
            ]
          : [{ say: "DONE" }],
      { declares: { inlineGate: false } },
    );
    rig = await harness({ legs: [{ kind: "antigravity", name: "Agy", leg }], plan: PLAN });
    const { id } = await rig.repoJob("A parser");
    const done = await rig.ended(id);
    expect(done.state, done.blockedReason ?? "").toBe("completed");
    const audited = logOf(rig, id).filter(
      (e) => e.kind === "GateDecision" && e.data.source === "audit",
    );
    expect(audited).toMatchObject([
      { data: { verdict: "deny", by: "rule", action: "sudo rm -rf /var/www" } },
    ]);
    expect(rig.events(id, "task.drift")).toMatchObject([{ code: "D7", step: "correct" }]);
    expect(leg.log[1]?.message).toMatch(/sudo rm -rf \/var\/www/);
  }, 60_000);

  it("the same Leg with an inline gate: nothing is audited after the fact", async () => {
    const leg = scriptedLeg(() => [
      { runUnasked: "ls" },
      { write: "parser.js", content: "x\n" },
      { say: "DONE" },
    ]);
    rig = await harness({ legs: [{ kind: "antigravity", name: "Agy", leg }], plan: PLAN });
    const { id } = await rig.repoJob("A parser");
    expect((await rig.ended(id)).state).toBe("completed");
    expect(
      logOf(rig, id).filter((e) => e.kind === "GateDecision" && e.data.source === "audit"),
    ).toEqual([]);
  }, 60_000);

  it("no stop hook in its probe: the session gets none, and the checks run after the turn", async () => {
    // It would hold its turn for the checks if it were given the hook.
    const leg = scriptedLeg(() => [{ write: "parser.js", content: "x\n" }, { say: "DONE" }], {
      stopHook: true,
      declares: { stopHook: false },
    });
    rig = await harness({ legs: [{ kind: "claude-code", name: "Claude A", leg }], plan: PLAN });
    const { id } = await rig.repoJob("A parser");
    expect((await rig.ended(id)).state).toBe("completed");
    const log = logOf(rig, id);
    expect(log.filter((e) => e.kind === "StopRequested")).toEqual([]);
    expect(
      log.filter((e) => e.kind === "ChecksRan").map((e) => (e.data as { why: string }).why),
    ).toEqual(["before", "turn"]);
  }, 60_000);

  it("a stop hook in its probe: the checks hold the turn, and stand for its end", async () => {
    const leg = scriptedLeg(() => [{ write: "parser.js", content: "x\n" }, { say: "DONE" }], {
      stopHook: true,
    });
    rig = await harness({ legs: [{ kind: "claude-code", name: "Claude A", leg }], plan: PLAN });
    const { id } = await rig.repoJob("A parser");
    expect((await rig.ended(id)).state).toBe("completed");
    const log = logOf(rig, id);
    expect(log.filter((e) => e.kind === "StopRequested")).toHaveLength(1);
    expect(
      log.filter((e) => e.kind === "ChecksRan").map((e) => (e.data as { why: string }).why),
    ).toEqual(["before", "stop"]);
  }, 60_000);

  it.each([
    [true, "hook"],
    [false, "prompt"],
  ])(
    "a pre-tool hook in its probe (%s): its commands asked through the %s",
    async (hook, source) => {
      const leg = scriptedLeg(
        () => [{ run: "ls" }, { write: "parser.js", content: "x\n" }, { say: "DONE" }],
        { autoModeHooks: true, declares: { preToolHook: hook } },
      );
      rig = await harness({ legs: [{ kind: "claude-code", name: "Claude A", leg }], plan: PLAN });
      const { id } = await rig.repoJob("A parser");
      expect((await rig.ended(id)).state).toBe("completed");
      const ls = logOf(rig, id).filter((e) => e.kind === "GateDecision" && e.data.action === "ls");
      expect(ls.map((e) => (e.data as { source: string }).source)).toEqual([source]);
    },
    60_000,
  );
});

describe("the TaskController: each transition a step in the log (ADR-056 §8)", () => {
  it("prepares, runs, verifies, decides and ends Done, every move legal, every key its own", async () => {
    // One model: the top of the ladder, so the failure goes back in its session.
    const leg = scriptedLeg(
      (t) =>
        t.turn === 1
          ? [{ say: "Working on it." }]
          : [{ write: "parser.js", content: "x\n" }, { say: "DONE" }],
      { models: ["opus"] },
    );
    rig = await harness({ legs: [{ kind: "claude-code", name: "Claude A", leg }], plan: PLAN });
    const { id } = await rig.repoJob("A parser");
    expect((await rig.ended(id)).state).toBe("completed");
    const moves = logOf(rig, id).flatMap((e) =>
      e.kind === "Transition" ? [e.data as { from: string; to: string; key: string }] : [],
    );
    expect(moves.map((m) => m.to)).toEqual([
      "Running",
      "Deciding",
      "Verifying",
      "Deciding",
      "Running",
      "Deciding",
      "Verifying",
      "Deciding",
      "Done",
    ]);
    expect(moves[0]?.from).toBe("Preparing");
    for (const m of moves)
      expect(TRANSITIONS[m.from as ControllerState], `${m.from} → ${m.to}`).toContain(m.to);
    expect(new Set(moves.map((m) => m.key)).size).toBe(moves.length);
    // The end comes after the last move: the outcome, then the attempt's end.
    expect(
      logOf(rig, id)
        .slice(-3)
        .map((e) => e.kind),
    ).toEqual(["Transition", "Outcome", "AttemptEnded"]);
  }, 60_000);

  it("a failure on a lower rung hands off to the next attempt: HandingOff ends it", async () => {
    let n = 0;
    const leg = scriptedLeg(() =>
      n++ === 0
        ? [{ say: "Working on it." }]
        : [{ write: "parser.js", content: "x\n" }, { say: "DONE" }],
    );
    rig = await harness({ legs: [{ kind: "claude-code", name: "Claude A", leg }], plan: PLAN });
    const { id } = await rig.repoJob("A parser");
    expect((await rig.ended(id)).state).toBe("completed");
    const log = new AttemptLog(rig.d.db);
    const ends = attemptsOf(rig, id).map((a) => {
      const moves = log.attempt(a.id, { kinds: ["Transition"] });
      return [moves.at(-1)?.data.to, a.outcome];
    });
    expect(ends).toEqual([
      ["HandingOff", "failed"],
      ["Done", "succeeded"],
    ]);
  }, 60_000);

  it("Running ⇄ AwaitingOwner while the agent's action waits for my answer", async () => {
    const leg = scriptedLeg(() => [
      { run: "nmap localhost" },
      { write: "parser.js", content: "x\n" },
      { say: "DONE" },
    ]);
    rig = await harness({ legs: [{ kind: "claude-code", name: "Claude A", leg }], plan: PLAN });
    const { id } = await rig.repoJob("A parser", { autonomy: "careful" });
    const plan = await rig.openItem(/^Approve the plan/);
    await rig.api.inbox.answer({ id: plan.id, answer: "Approve" });
    const nmap = await rig.openItem(/wants to run `nmap localhost`/);
    await rig.api.inbox.answer({ id: nmap.id, answer: "Approve" });
    expect((await rig.ended(id)).state).toBe("completed");
    const to = logOf(rig, id).flatMap((e) =>
      e.kind === "Transition" ? [(e.data as { to: string }).to] : [],
    );
    expect(to.slice(0, 3)).toEqual(["Running", "AwaitingOwner", "Running"]);
    expect(to.at(-1)).toBe("Done");
  }, 60_000);
});

describe("what a restart left uncertain, reconciled (ADR-056 §1)", () => {
  it("asks the agent once to look at a command whose effect the tree can't show, records what it said, never runs it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oraknid-reconcile-"));
    const db = join(dir, "o.db");
    const crashed = await harness({
      legs: [
        {
          kind: "claude-code",
          name: "Claude A",
          leg: scriptedLeg(() => [{ run: "sleep 20; echo deployed" }]),
        },
      ],
      plan: PLAN,
      dataDir: dir,
      dbFile: db,
    });
    try {
      const { id } = await crashed.repoJob("A parser");
      await waitFor("the command asked for", () => {
        const a = attemptsOf(crashed, id)[0];
        return a &&
          new AttemptLog(crashed.d.db)
            .attempt(a.id, { kinds: ["ActionRequested"] })
            .some((e) => e.kind === "ActionRequested" && e.data.input.startsWith("sleep 20"))
          ? a
          : undefined;
      });
      const again = scriptedLeg((t) =>
        t.turn === 1
          ? [{ write: "parser.js", content: "x\n" }, { say: "DONE" }]
          : [{ say: "I looked: nothing was deployed. DONE" }],
      );
      rig = await harness({
        legs: [{ kind: "claude-code", name: "Claude A", leg: again }],
        plan: PLAN,
        dataDir: dir,
        dbFile: db,
        again: true,
      });
      expect((await rig.ended(id)).state).toBe("completed");
      const second = attemptsOf(rig, id).at(-1);
      const found = new AttemptLog(rig.d.db).attempt(second?.id as string, {
        kinds: ["Reconciled"],
      });
      expect(found.map((e) => e.data.finding)).toEqual(["ask-agent", "agent-said"]);
      expect(found[1]?.data.detail).toMatch(/nothing was deployed/);
      // Asked once, to look; never given it to do.
      const naming = again.log.map((t) => t.message).filter((m) => m.includes("sleep 20"));
      expect(naming).toHaveLength(1);
      expect(naming[0]).toMatch(/without running it again/);
      expect(rig.events(id, "task.reconciling")).toHaveLength(1);
      expect(rig.events(id, "task.actions-reconciled")).toHaveLength(1);
    } finally {
      await rig?.close();
      rig = undefined;
      await crashed.close();
    }
  }, 60_000);
});
