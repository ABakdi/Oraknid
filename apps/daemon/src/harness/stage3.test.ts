import type { WebPlan } from "@oraknid/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { type Harness, harness } from "../testing/harness-rig.ts";
import { scriptedLeg, type TurnContext } from "../testing/scripted-leg.ts";

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
