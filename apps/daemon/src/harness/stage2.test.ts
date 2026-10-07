import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebPlan } from "@oraknid/contracts";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { tasks } from "../db/schema.ts";
import { forgetJobVerdicts } from "../eye/auto-mode.ts";
import { readTaskMemory } from "../eye/task-memory.ts";
import { type Harness, harness, waitFor } from "../testing/harness-rig.ts";
import { scriptedLeg } from "../testing/scripted-leg.ts";

// What changed when the Gate was extracted (ADR-056 stage 2): only where
// one path diverged from the others, or a stage-1 finding was left open.
// Each test failed before its change.

/** A command the rules refuse on their own (Oraknid's own check): only a grant lets it run. */
const OWN = "oraknid github-repo";

let rig: Harness | undefined;
afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

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

describe("what I let run once survives a restart (stage 1, found)", () => {
  it("runs the command I allowed once after Oraknid restarts, without asking again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oraknid-restart-"));
    const db = join(dir, "o.db");
    const plan: WebPlan = {
      summary: "A parser.",
      tasks: [task("a", "Build the parser", ["test -f parser.js"], ["parser.js"])],
      jobVerify: [],
    };
    // Before the restart: blocked, it says it needs me; I allow it; Oraknid stops before it runs.
    const first = scriptedLeg((t) =>
      t.turn === 1
        ? [
            { run: OWN, instead: () => "ok" },
            { say: `I can't go on: owner action required: ${OWN}` },
          ]
        : [{ hang: true }],
    );
    rig = await harness({
      legs: [{ kind: "claude-code", name: "Claude A", leg: first }],
      plan,
      dataDir: dir,
      dbFile: db,
    });
    const { id } = await rig.repoJob("A parser");
    const needs = await rig.openItem(/^Claude A needs `oraknid github-repo`/, 10_000);
    await rig.api.inbox.answer({ id: needs.id, answer: "Allow" });
    await waitFor("its next turn", () => first.log.length === 2);
    await rig.close();
    forgetJobVerdicts(id);

    // After it: the command runs, once, with nothing asked.
    const ran: string[] = [];
    const again = scriptedLeg(() => [
      {
        run: OWN,
        instead: () => {
          ran.push(OWN);
          return "ok";
        },
      },
      { write: "parser.js", content: "x\n" },
      { say: "DONE" },
    ]);
    rig = await harness({
      legs: [{ kind: "claude-code", name: "Claude A", leg: again }],
      plan,
      dataDir: dir,
      dbFile: db,
      again: true,
    });
    const done = await rig.ended(id);
    expect(done.state, done.blockedReason ?? "").toBe("completed");
    expect(ran).toEqual([OWN]);
    expect((await rig.asked(id)).map((i) => i.title)).toEqual([
      "Claude A needs `oraknid github-repo` for “Build the parser”",
    ]);
  }, 60_000);
});

describe("a job that ends keeps nothing of its tasks (stage 1, found)", () => {
  it("forgets what a task cancelled before it settled kept across restarts", async () => {
    const leg = scriptedLeg(() => [{ run: "curl --version >/dev/null; true" }, { hang: true }]);
    rig = await harness({
      legs: [{ kind: "claude-code", name: "Claude A", leg }],
      plan: {
        summary: "A parser.",
        tasks: [task("a", "Build the parser", ["test -f parser.js"], ["parser.js"])],
        jobVerify: [],
      },
    });
    const { id } = await rig.repoJob("A parser");
    await waitFor("the task untrusted", () => rig?.events(id, "task.untrusted").length === 1);
    // What the task remembers, read from the attempt log (stage 3).
    const db = rig.d.db;
    const taskId = db.select().from(tasks).where(eq(tasks.jobId, id)).get()?.id as string;
    const kept = () => readTaskMemory(db, taskId).untrusted;
    expect(kept()).toMatch(/read from the web/);
    await rig.api.jobs.cancel({ id });
    expect((await rig.ended(id)).state).toBe("cancelled");
    await waitFor("its task's memory gone", () => kept() === null, 5000);
  }, 60_000);
});
