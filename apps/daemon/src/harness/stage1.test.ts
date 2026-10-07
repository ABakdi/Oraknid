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
