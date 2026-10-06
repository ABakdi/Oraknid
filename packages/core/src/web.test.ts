import type { PlannedTask, WebPlan } from "@oraknid/contracts";
import { describe, expect, it } from "vitest";
import {
  graphProblems,
  inScope,
  orderMatters,
  planMeasures,
  readyTasks,
  sameTask,
  scopeConflict,
  scopesOverlap,
  shapeWeb,
  validateWeb,
} from "./web.ts";

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

  it("tells a tight overlap from a loose one, so broad scopes don't run everything in a row (ADR-050)", () => {
    const kind = (a: string[], b: string[]) => scopeConflict(a, b).kind;
    expect(kind(["src/auth/**"], ["src/billing/**"])).toBe("none");
    // The same file, or one folder deep enough to be one piece of work: they wait for each other.
    expect(scopeConflict(["package.json"], ["package.json"])).toEqual({
      kind: "tight",
      where: "package.json",
    });
    expect(scopeConflict(["src/auth/**"], ["src/auth/login.ts"])).toEqual({
      kind: "tight",
      where: "src/auth",
    });
    // Broad scopes meet only loosely: side by side in their own worktrees, merged after.
    expect(kind(["src/**"], ["src/auth/login.ts"])).toBe("loose");
    expect(kind(["src/**"], ["src/**"])).toBe("loose");
    expect(kind(["**/*.ts"], ["docs/**"])).toBe("loose");
    expect(kind(["src"], ["src/a.ts"])).toBe("loose");
    expect(kind([], ["a"])).toBe("loose");
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

// After the piano job (2026-10-04): fifteen tasks, the same ones twice, and no dependency at all.
describe("The Web as a graph", () => {
  const piano = plan([
    t({ key: "r1", title: "Research Web Audio libraries", kind: "research", verify: [] }),
    t({ key: "i1", title: "Initialize React project with Vite" }),
    t({ key: "k1", title: "Implement piano keyboard component (Phase 1)" }),
    t({ key: "i2", title: "Initialize React TypeScript project" }),
    t({ key: "v1", title: "Implement volume control (Phase 1)" }),
    t({ key: "p1", title: "Implement phase control (Phase 1)" }),
    t({ key: "k2", title: "Implement keyboard component with classic piano key mapping" }),
    t({ key: "e1", title: "Integrate Phase 1 components and test end-to-end", kind: "test" }),
  ]);

  it("knows the same work in other words, and different work with the same verb", () => {
    expect(
      sameTask(
        t({ title: "Initialize React project with Vite" }),
        t({ title: "Initialize React TypeScript project" }),
      ),
    ).toBe(true);
    expect(
      sameTask(
        t({ title: "Implement volume control (Phase 1)" }),
        t({ title: "Implement phase control (Phase 1)" }),
      ),
    ).toBe(false);
    expect(sameTask(t({ title: "Add a metronome" }), t({ title: "Add a metronome" }))).toBe(true);
    // The same words, another kind of work: a test of a thing isn't the thing.
    expect(sameTask(t({ title: "Keyboard" }), t({ title: "Keyboard", kind: "test" }))).toBe(false);
  });

  it("sends back the same work twice and a plan with no order where order matters", () => {
    const problems = graphProblems(piano);
    expect(problems).toContain(
      '"i1" and "i2" are the same work ("Initialize React project with Vite"): plan it once.',
    );
    expect(problems).toContain(
      '"k1" and "k2" are the same work ("Implement piano keyboard component (Phase 1)"): plan it once.',
    );
    expect(problems.at(-1)).toMatch(
      /^None of the 8 tasks depends on another, yet their order matters/,
    );
    // Two independent changes have no order to give.
    expect(
      orderMatters(
        plan([t({ key: "a", title: "Fix the header" }), t({ key: "b", title: "Fix the footer" })]),
      ),
    ).toBe(false);
  });

  it("merges duplicates and, as a last resort, orders setup and research, the work, then integration", () => {
    const { plan: shaped, notes } = shapeWeb(piano);
    const deps = Object.fromEntries(shaped.tasks.map((x) => [x.key, x.dependsOn]));
    expect(Object.keys(deps)).toEqual(["r1", "i1", "k1", "v1", "p1", "e1"]);
    expect(deps).toEqual({
      r1: [],
      i1: [],
      k1: ["r1", "i1"],
      v1: ["r1", "i1"],
      p1: ["r1", "i1"],
      e1: ["k1", "v1", "p1"],
    });
    expect(validateWeb(shaped)).toEqual([]);
    expect(notes).toContain(
      '"Initialize React TypeScript project" is the same work as "Initialize React project with Vite": planned once.',
    );
    expect(notes.at(-1)).toMatch(/Oraknid ordered it itself/);
  });

  it("orders phases, keeps the planner's own graph, and drops what can't be", () => {
    const phased = shapeWeb(
      plan([
        t({ key: "a", title: "Keyboard", phase: 1 }),
        t({ key: "b", title: "Oscilloscope", phase: 1 }),
        t({ key: "c", title: "Synthesis", phase: 2 }),
        t({ key: "d", title: "Synthesis presets", phase: 2, dependsOn: ["c"] }),
        t({ key: "e", title: "Recording", phase: 3, dependsOn: ["ghost"] }),
      ]),
    );
    expect(phased.plan.tasks.map((x) => [x.key, x.dependsOn])).toEqual([
      ["a", []],
      ["b", []],
      ["c", ["a", "b"]],
      ["d", ["c"]],
      ["e", ["d"]],
    ]);
    expect(phased.notes).toContain(
      '"Recording" depended on "ghost", which isn\'t in the plan; dropped.',
    );
    // A circle loses the link that closes it; a known task of The Web may be depended on.
    const circle = shapeWeb(
      plan([
        t({ key: "a", title: "One", dependsOn: ["b", "01EXISTING"] }),
        t({ key: "b", title: "Two", dependsOn: ["a"] }),
      ]),
      new Set(["01EXISTING"]),
    );
    expect(circle.plan.tasks.map((x) => [x.key, x.dependsOn])).toEqual([
      ["a", ["b", "01EXISTING"]],
      ["b", []],
    ]);
  });
});
