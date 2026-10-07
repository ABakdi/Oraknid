import type { WebPlan } from "@oraknid/contracts";
import { like } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { settings } from "../db/schema.ts";
import { type Harness, harness, waitFor } from "../testing/harness-rig.ts";
import { scriptedLeg } from "../testing/scripted-leg.ts";

// What changed when the Gate was extracted (ADR-056 stage 2): only where
// one path diverged from the others, or a stage-1 finding was left open.
// Each test failed before its change.

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
    const kept = () =>
      rig?.d.db.select().from(settings).where(like(settings.key, "task.memory.%")).all() ?? [];
    expect(kept()).toHaveLength(1);
    await rig.api.jobs.cancel({ id });
    expect((await rig.ended(id)).state).toBe("cancelled");
    await waitFor("its task's memory gone", () => kept().length === 0, 5000);
  }, 60_000);
});
