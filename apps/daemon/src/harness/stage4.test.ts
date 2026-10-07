import type { WebPlan } from "@oraknid/contracts";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { attempts } from "../db/schema.ts";
import { type Harness, harness } from "../testing/harness-rig.ts";
import { scriptedLeg } from "../testing/scripted-leg.ts";

// ADR-056 stage 4: the turn's end decided once (core's decideOutcome) and
// applied (harness/apply.ts), end to end. Where the decision changed, a
// test here pins it.

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

const outcomes = (h: Harness, jobId: string) =>
  h.d.db
    .select()
    .from(attempts)
    .where(eq(attempts.jobId, jobId))
    .all()
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((a) => a.outcome);

describe("security and scope aren't done when the checks pass (stage 1's gap)", () => {
  it("a forbidden command with passing checks is corrected in its session, then done (D7)", async () => {
    const leg = scriptedLeg((t) =>
      t.turn === 1
        ? [{ run: "sudo ls" }, { write: "parser.js", content: "x\n" }, { say: "DONE" }]
        : [{ say: "DONE" }],
    );
    rig = await harness({ legs: [{ kind: "claude-code", name: "Claude A", leg }], plan: PLAN });
    const { id } = await rig.repoJob("A parser");
    const done = await rig.ended(id);
    expect(done.state, done.blockedReason ?? "").toBe("completed");
    expect(rig.events(id, "task.drift")).toMatchObject([{ code: "D7", step: "correct" }]);
    expect(leg.log.map((t) => [t.model, t.session, t.turn])).toEqual([
      ["haiku", 1, 1],
      ["haiku", 1, 2],
    ]);
    expect(leg.log[1]?.message).toMatch(/sudo ls[\s\S]*never allowed/);
    expect(outcomes(rig, id)).toEqual(["succeeded"]);
  }, 60_000);

  it("a refused gate tried again with passing checks is killed and rolled back; the next model does it (D8)", async () => {
    let tries = 0;
    const leg = scriptedLeg(() =>
      tries++ === 0
        ? [
            { run: "nmap localhost" },
            { run: "nmap localhost" },
            { write: "parser.js", content: "x\n" },
            { say: "DONE" },
          ]
        : [{ write: "parser.js", content: "y\n" }, { say: "DONE" }],
    );
    rig = await harness({ legs: [{ kind: "claude-code", name: "Claude A", leg }], plan: PLAN });
    const { id } = await rig.repoJob("A parser", { autonomy: "careful" });
    const plan = await rig.openItem(/^Approve the plan/);
    await rig.api.inbox.answer({ id: plan.id, answer: "Approve" });
    const nmap = await rig.openItem(/wants to run `nmap localhost`/);
    await rig.api.inbox.answer({ id: nmap.id, answer: "Deny" });
    const done = await rig.ended(id);
    expect(done.state, done.blockedReason ?? "").toBe("completed");
    // Asked once; tried again, refused at once; checks passing don't make it done.
    expect(
      (await rig.asked(id)).filter((i) => /wants to run `nmap localhost`/.test(i.title)),
    ).toHaveLength(1);
    expect(rig.events(id, "task.drift")).toMatchObject([{ code: "D8", step: "kill" }]);
    expect(outcomes(rig, id)).toEqual(["reassigned", "succeeded"]);
    expect(leg.log.map((t) => t.model)).toEqual(["haiku", "sonnet"]);
  }, 60_000);
});
