import type { PlannedTask, WebPlan } from "@oraknid/contracts";
import { describe, expect, it } from "vitest";
import { inScope, planMeasures, readyTasks, scopesOverlap, validateWeb } from "./web.ts";

const t = (over: Partial<PlannedTask>): PlannedTask => ({
  key: "t1",
  title: "x",
  instructions: "x",
  kind: "implement",
  dependsOn: [],
  scope: ["src/**"],
  verify: ["pnpm test"],
  requiredCapabilities: ["implementation"],
  difficulty: "low",
  ...over,
});
const plan = (tasks: PlannedTask[]): WebPlan => ({ summary: "s", tasks, jobVerify: [] });

describe("validateWeb", () => {
  it("accepts a sound plan", () => {
    expect(validateWeb(plan([t({}), t({ key: "t2", dependsOn: ["t1"] })]))).toEqual([]);
  });

  it("names every problem in words", () => {
    const problems = validateWeb(
      plan([
        t({ key: "a", dependsOn: ["b"] }),
        t({ key: "b", dependsOn: ["a"] }),
        t({ key: "c", verify: [], dependsOn: ["zz"] }),
        t({ key: "d", scope: [] }),
        t({ key: "e", scope: ["../secrets"] }),
        t({ key: "a" }),
      ]),
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        'Task key "a" is used twice.',
        'Task "c" depends on "zz", which is not in the plan.',
        'Task "c" (implement) has no verify command; every task that changes things must.',
        'Task "d" (implement) has no scope: say which paths it may change.',
        'Task "e" has a scope outside the workspace; scopes are relative paths.',
      ]),
    );
    expect(
      problems.some((p) => p.startsWith("The tasks depend on each other in a circle: a → b → a")),
    ).toBe(true);
  });

  it("lets research and planning tasks go without a verify command", () => {
    expect(validateWeb(plan([t({ kind: "research", verify: [], scope: [] })]))).toEqual([]);
  });
});

describe("readyTasks", () => {
  it("returns tasks whose dependencies are done or skipped", () => {
    const tasks = [
      { id: "1", state: "done", dependsOn: [] },
      { id: "2", state: "pending", dependsOn: ["1"] },
      { id: "3", state: "pending", dependsOn: ["2"] },
      { id: "4", state: "pending", dependsOn: ["5"] },
      { id: "5", state: "skipped", dependsOn: [] },
    ];
    expect(readyTasks(tasks).map((x) => x.id)).toEqual(["2", "4"]);
  });
});

describe("inScope", () => {
  it.each([
    ["src/auth/login.ts", ["src/auth/**"], true],
    ["src/auth/deep/x.ts", ["src/auth/**"], true],
    ["src/billing/x.ts", ["src/auth/**"], false],
    ["README.md", ["*.md"], true],
    ["docs/a.md", ["*.md"], false],
    ["docs/a.md", ["**/*.md"], true],
    ["src/auth/login.ts", ["src/auth"], true],
    ["./src/a.ts", ["src/*.ts"], true],
    ["src/a.tsx", ["src/?.ts"], false],
  ])("%s in %j → %s", (path, globs, expected) => {
    expect(inScope(path, globs)).toBe(expected);
  });
});

describe("scopes that may overlap (ADR-016)", () => {
  it("lets disjoint trees run side by side, and nothing else", () => {
    expect(scopesOverlap(["src/auth/**"], ["src/billing/**"])).toBe(false);
    expect(scopesOverlap(["src/**"], ["src/auth/login.ts"])).toBe(true);
    expect(scopesOverlap(["hello.sh"], ["test.sh"])).toBe(false);
    expect(scopesOverlap(["**/*.ts"], ["docs/**"])).toBe(true);
    expect(scopesOverlap([], ["a"])).toBe(true);
    expect(scopesOverlap(["src/a*.ts"], ["src/b.ts"])).toBe(true);
    expect(scopesOverlap(["./docs/x.md"], ["docs/x.md"])).toBe(true);
  });
});

describe("planMeasures", () => {
  it("counts tasks, checks, kinds and the longest chain", () => {
    const t = (key: string, dependsOn: string[], verify: string[], kind = "implement") => ({
      key,
      title: key,
      instructions: "x",
      kind: kind as "implement",
      dependsOn,
      scope: [],
      verify,
      requiredCapabilities: [],
      difficulty: "low" as const,
    });
    const m = planMeasures({
      summary: "s",
      tasks: [t("a", [], ["x", "y"]), t("b", ["a"], ["z"], "test"), t("c", ["b"], [], "research")],
      jobVerify: [],
    });
    expect(m).toEqual({
      tasks: 3,
      withChecks: 2 / 3,
      checksPerTask: 1,
      depth: 3,
      kinds: { implement: 1, test: 1, research: 1 },
    });
  });
});
