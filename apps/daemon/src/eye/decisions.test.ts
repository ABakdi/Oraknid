import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/open.ts";
import { EventBus } from "../events/bus.ts";
import { EyeDecisions } from "./decisions.ts";

const plan = (titles: string[]) => ({
  summary: "s",
  tasks: titles.map((title, i) => ({
    key: `t${i}`,
    title,
    instructions: "x",
    kind: "implement" as const,
    dependsOn: i ? [`t${i - 1}`] : [],
    scope: [],
    verify: i ? ["true"] : [],
    requiredCapabilities: [],
    difficulty: "low" as const,
  })),
  jobVerify: [],
});

describe("The Eye's decision models (ADR-022)", () => {
  it("keeps my choice of models, and puts a plan beside its shadow's with their measures", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oraknid-decisions-"));
    const db = await openDatabase({ file: ":memory:", backupsDir: join(dir, "b") });
    const d = new EyeDecisions(db, new EventBus(db, Date.now));
    expect(d.models()).toEqual({
      leg: null,
      planning: null,
      judging: null,
      quick: null,
      shadow: null,
    });
    d.setModels({ leg: "L", planning: "P", judging: null, quick: "Q", shadow: "S" });
    expect(d.pins()).toEqual({ planning: "P", judging: null, quick: "Q", shadow: "S" });
    expect(d.models().leg).toBe("L");

    const base = { jobId: "J", pairId: "p1", call: "plan" as const, ms: 10, firstTry: true };
    d.record({ ...base, role: "primary", model: "A", plan: plan(["one", "two"]), error: null });
    d.record({
      ...base,
      role: "shadow",
      model: "B",
      plan: null,
      error: "unavailable",
      firstTry: false,
    });
    const [c] = d.comparisons("J");
    expect(c?.plans.map((p) => [p.role, p.model, p.error])).toEqual([
      ["primary", "A", null],
      ["shadow", "B", "unavailable"],
    ]);
    expect(c?.plans[0]?.measures).toMatchObject({ tasks: 2, withChecks: 0.5, depth: 2 });
    expect(c?.plans[0]?.titles).toEqual(["one", "two"]);
    expect(d.outcome("J")).toEqual({
      tasksDone: 0,
      tasksTotal: 0,
      attempts: 0,
      checksRepaired: 0,
      replans: 0,
    });
  });
});
