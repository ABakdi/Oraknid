import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebPlan } from "@oraknid/contracts";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { attempts } from "../db/schema.ts";
import { readEnding } from "../eye/ending.ts";
import { type Harness, harness, waitFor } from "../testing/harness-rig.ts";
import { scriptedLeg, type TurnContext } from "../testing/scripted-leg.ts";
import { AttemptLog } from "./log.ts";

// ADR-056 stage 3: the Verifier and the attempt log, end to end. Where one
// of the five check paths diverged from the others, a test here pins the
// one behaviour they share now.

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
});

describe("the job's own checks go through the rules like every other check (stage 3)", () => {
  it("refuses a job-level check on a server that a check never does, and doesn't run it there", async () => {
    const leg = scriptedLeg((t) =>
      taskOf(t) === "Build the parser"
        ? [{ write: "parser.js", content: "x\n" }, { say: "DONE" }]
        : [{ say: "DONE" }],
    );
    let failure = "";
    rig = await harness({
      legs: [{ kind: "claude-code", name: "Claude A", leg }],
      server: true,
      plan: {
        summary: "One part, checked on the server at the end.",
        tasks: [task("a", "Build the parser", ["test -f parser.js"], ["parser.js"])],
        jobVerify: ["ssh oraknid-vps-one 'npm publish'"],
      },
      brain: {
        replan: async (i) => {
          failure = i.failure;
          throw new Error("stop here");
        },
      },
    });
    const { id } = await rig.repoJob("One part", { withServer: true });
    await rig.ended(id, 30_000);
    expect(failure).toMatch(/Oraknid did not run this check: .*a check never does that/);
    expect(rig.ssh?.commands.some((c) => c.includes("npm publish"))).toBe(false);
  }, 60_000);
});

describe("Oraknid's own GitHub checks name the repo the same way everywhere (stage 3)", () => {
  it("says the job's check names a repo the project doesn't have, as the task's check does", async () => {
    const leg = scriptedLeg(() => [{ write: "parser.js", content: "x\n" }, { say: "DONE" }]);
    rig = await harness({
      legs: [{ kind: "claude-code", name: "Claude A", leg }],
      plan: {
        summary: "One part, its repo checked on GitHub at the end.",
        tasks: [task("a", "Build the parser", ["test -f parser.js"], ["parser.js"])],
        jobVerify: ["oraknid github-repo --repo nope"],
      },
    });
    const { id } = await rig.repoJob("One part");
    const done = await rig.ended(id, 30_000);
    expect(done.state).toBe("completed");
    expect(readEnding(rig.d.db, id).done?.problems).toEqual([
      expect.stringMatching(
        /^`oraknid github-repo --repo nope`: This project has no repo named nope: its repos are /,
      ),
    ]);
  }, 60_000);
});

/** The attempts of a job, oldest first. */
const attemptsOf = (h: Harness, jobId: string) =>
  h.d.db
    .select()
    .from(attempts)
    .where(eq(attempts.jobId, jobId))
    .all()
    .sort((a, b) => a.startedAt - b.startedAt);

describe("the attempt log (ADR-056 §1)", () => {
  it("records what an attempt did, what the Gate decided, the checks and how it ended", async () => {
    const leg = scriptedLeg(() => [
      { run: "sudo ls" },
      { write: "parser.js", content: "x\n" },
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
    const { id } = await rig.repoJob("A parser");
    expect((await rig.ended(id)).state).toBe("completed");
    const [attempt] = attemptsOf(rig, id);
    const log = new AttemptLog(rig.d.db).attempt(attempt?.id as string);
    const kinds = log.map((e) => e.kind);
    expect(kinds[0]).toBe("ChecksRan");
    expect(kinds).toContain("SessionOpened");
    expect(kinds.slice(-2)).toEqual(["Outcome", "AttemptEnded"]);
    const sudo = log.find((e) => e.kind === "ActionRequested" && e.data.input === "sudo ls");
    expect(sudo).toBeDefined();
    expect(
      log.find(
        (e) =>
          e.kind === "GateDecision" && e.data.action === "sudo ls" && e.data.verdict === "deny",
      )?.data,
    ).toMatchObject({ source: "prompt", by: "rule", verdict: "deny" });
    expect(
      log.find(
        (e) =>
          e.kind === "ActionResult" &&
          sudo?.kind === "ActionRequested" &&
          e.data.actionId === sudo.data.id,
      )?.data,
    ).toMatchObject({ ok: false });
    expect(log.filter((e) => e.kind === "ChecksRan").map((e) => e.data)).toMatchObject([
      { why: "before", passed: false },
      { why: "turn", passed: true },
    ]);
    expect(log.find((e) => e.kind === "AgentText")?.data).toMatchObject({ text: "DONE" });
    expect(log.at(-2)?.data).toMatchObject({ kind: "succeeded" });
  }, 60_000);

  it("builds the handoff from the log: what was tried, what the Gate refused, the last check report", async () => {
    const leg = scriptedLeg((t) =>
      t.turn === 1 ? [{ run: "sudo ls" }, { say: "DONE" }] : [{ hang: true }],
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
    await waitFor("its second turn", () => leg.log.length === 2);
    await rig.api.jobs.cancel({ id });
    await rig.ended(id);
    const handoff = (await rig.api.silk.list({ jobId: id })).find((e) => e.kind === "handoff");
    expect(handoff?.body).toContain("## What was tried (its last actions)\n- Bash `sudo ls`");
    expect(handoff?.body).toMatch(/## What Oraknid's Gate refused\n- `sudo ls` — .+ \(rule\)/);
    expect(handoff?.body).toContain(
      "## The last check report\n- `test -f parser.js`: fails (exit 1)",
    );
    const [attempt] = attemptsOf(rig, id);
    expect(
      new AttemptLog(rig.d.db).attempt(attempt?.id as string, { kinds: ["HandoffWritten"] }),
    ).toMatchObject([{ data: { silkId: handoff?.id } }]);
  }, 60_000);

  it("marks an action left without a result by a crash uncertain, and says so; never runs it again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oraknid-uncertain-"));
    const db = join(dir, "o.db");
    const plan: WebPlan = {
      summary: "A parser.",
      tasks: [task("a", "Build the parser", ["test -f parser.js"], ["parser.js"])],
      jobVerify: [],
    };
    const marker = join(dir, "ran");
    // The first Oraknid starts a long command, then dies before its result.
    const crashed = await harness({
      legs: [
        {
          kind: "claude-code",
          name: "Claude A",
          leg: scriptedLeg(() => [{ run: `sleep 20; touch ${marker}` }]),
        },
      ],
      plan,
      dataDir: dir,
      dbFile: db,
    });
    try {
      const { id } = await crashed.repoJob("A parser");
      const first = await waitFor("the command asked for", () => {
        const a = attemptsOf(crashed, id)[0];
        return a &&
          new AttemptLog(crashed.d.db)
            .attempt(a.id, { kinds: ["ActionRequested"] })
            .some((e) => e.kind === "ActionRequested" && e.data.input.startsWith("sleep 20"))
          ? a
          : undefined;
      });
      const again = scriptedLeg(() => [{ write: "parser.js", content: "x\n" }, { say: "DONE" }]);
      rig = await harness({
        legs: [{ kind: "claude-code", name: "Claude A", leg: again }],
        plan,
        dataDir: dir,
        dbFile: db,
        again: true,
      });
      expect((await rig.ended(id)).state).toBe("completed");
      expect(
        new AttemptLog(rig.d.db).attempt(first.id, { kinds: ["ActionUncertain"] }),
      ).toMatchObject([
        { kind: "ActionUncertain", data: { tool: "Bash", input: `sleep 20; touch ${marker}` } },
      ]);
      expect(rig.events(id, "task.actions-uncertain")).toHaveLength(1);
      const said = (await rig.api.silk.list({ jobId: id })).filter((e) =>
        e.body.includes("## Uncertain after a restart"),
      );
      expect(said).toHaveLength(1);
      expect(said[0]?.body).toContain(`sleep 20; touch ${marker}`);
      // Nothing ran it again: the new session was never given it.
      expect(again.log.map((t) => t.message).join("\n")).not.toContain("sleep 20");
    } finally {
      await rig?.close();
      rig = undefined;
      await crashed.close();
    }
  }, 60_000);
});
