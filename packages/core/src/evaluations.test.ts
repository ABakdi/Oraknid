import type { PlannedTask, WebPlan } from "@oraknid/contracts";
import { describe, expect, it } from "vitest";
import { evaluationRules, hasUi, isDesignTask, shapeEvaluations } from "./evaluations.ts";
import { readyTasks, shapeWeb, validateWeb } from "./web.ts";

// Evaluation steps in the plan (ADR-064 §1, M16.2).

const t = (over: Partial<PlannedTask>): PlannedTask => ({
  key: "t1",
  title: "x",
  instructions: "x",
  kind: "implement",
  dependsOn: [],
  scope: ["src/**"],
  verify: ["pnpm test"],
  requiredCapabilities: ["implementation"],
  difficulty: "medium",
  ...over,
});
const plan = (tasks: PlannedTask[]): WebPlan => ({ summary: "s", tasks, jobVerify: [] });

/** The Keys job, as a planner without reviews would plan it. */
const keys = () =>
  plan([
    t({ key: "setup", title: "Scaffold the Vite app", scope: ["package.json", "src/**"] }),
    t({
      key: "design",
      title: "Design the instrument's screens",
      scope: ["design/**"],
      verify: ["test -f design/index.html"],
      requiredCapabilities: ["ui"],
      dependsOn: ["setup"],
    }),
    t({
      key: "audio",
      title: "Build the audio engine",
      scope: ["src/audio/**"],
      dependsOn: ["setup"],
    }),
    t({
      key: "knobs",
      title: "Build the sound designer's knobs",
      scope: ["src/ui/designer/**"],
      requiredCapabilities: ["ui", "implementation"],
      dependsOn: ["design", "audio"],
    }),
    t({
      key: "keys",
      title: "Build the keyboard",
      scope: ["src/ui/keys/**"],
      requiredCapabilities: ["ui", "implementation"],
      dependsOn: ["design"],
    }),
  ]);

const ALL = { mode: "all" as const, kinds: [] };

describe("evaluation nodes in The Web", () => {
  it("validates an evaluation step: what it shows, after the work it shows, no scope or verify needed", () => {
    expect(
      validateWeb(
        plan([
          t({}),
          t({
            key: "r",
            kind: "evaluation",
            scope: [],
            verify: [],
            dependsOn: ["t1"],
            evaluation: { kind: "design", why: "I see it first." },
          }),
        ]),
      ),
    ).toEqual([]);
    const problems = validateWeb(
      plan([
        t({ key: "r", kind: "evaluation", scope: [], verify: [] }),
        t({ key: "x", evaluation: { kind: "app", why: "y" } }),
      ]),
    );
    expect(problems).toEqual([
      expect.stringMatching(/"r" is an evaluation step: say what it shows/),
      expect.stringMatching(/Evaluation step "r" depends on nothing/),
      expect.stringMatching(/"x" has an "evaluation" but is not of kind "evaluation"/),
    ]);
  });

  it("dependants wait for a review node; independent work goes on beside it", () => {
    const shaped = shapeWeb(keys(), new Set(), { setting: ALL, add: true }).plan;
    const rows = shaped.tasks.map((x) => ({
      id: x.key,
      dependsOn: x.dependsOn,
      state: ["setup", "design"].includes(x.key) ? "done" : "pending",
    }));
    // The design is done, its review isn't: the features built on it wait; the audio engine runs.
    expect(readyTasks(rows).map((r) => r.id)).toEqual(["audio", "review-design"]);
    const approved = rows.map((r) => (r.id === "review-design" ? { ...r, state: "done" } : r));
    expect(readyTasks(approved).map((r) => r.id)).toEqual(["audio", "keys"]);
  });
});

describe("the planner's shape adds reviews for work I'll see (shapeEvaluations)", () => {
  it("adds a design review after the design, before the features built on it, and a final app review", () => {
    const { plan: p, notes } = shapeEvaluations(keys(), ALL, { add: true });
    const byKey = new Map(p.tasks.map((x) => [x.key, x]));
    expect(byKey.get("review-design")).toMatchObject({
      kind: "evaluation",
      dependsOn: ["design"],
      evaluation: { kind: "design", why: expect.stringMatching(/before any feature code/) },
      scope: [],
      verify: [],
    });
    expect(byKey.get("knobs")?.dependsOn.sort()).toEqual(["audio", "review-design"]);
    expect(byKey.get("keys")?.dependsOn).toEqual(["review-design"]);
    // The audio engine needs no design: it never waits for the review.
    expect(byKey.get("audio")?.dependsOn).toEqual(["setup"]);
    expect(byKey.get("review-app")).toMatchObject({
      kind: "evaluation",
      evaluation: { kind: "app" },
    });
    expect(byKey.get("review-app")?.dependsOn.sort()).toEqual(["keys", "knobs"]);
    expect(notes).toHaveLength(2);
    expect(validateWeb(p)).toEqual([]);
  });

  it("adds none to a pure backend", () => {
    const backend = plan([
      t({ key: "db", title: "Add the migrations" }),
      t({ key: "api", title: "Write the REST endpoints", dependsOn: ["db"] }),
    ]);
    expect(hasUi(backend)).toBe(false);
    const { plan: p, notes } = shapeEvaluations(backend, ALL, { add: true });
    expect(p.tasks.map((x) => x.key)).toEqual(["db", "api"]);
    expect(notes).toEqual([]);
  });

  it("keeps the planner's own reviews, with no second of the same kind", () => {
    const own = keys();
    own.tasks.push(
      t({
        key: "look",
        title: "Owner looks at the design",
        kind: "evaluation",
        scope: [],
        verify: [],
        dependsOn: ["design"],
        evaluation: { kind: "design", why: "The layout decides everything." },
      }),
    );
    const { plan: p } = shapeEvaluations(own, ALL, { add: true });
    expect(p.tasks.filter((x) => x.evaluation?.kind === "design").map((x) => x.key)).toEqual([
      "look",
    ]);
    expect(p.tasks.find((x) => x.key === "keys")?.dependsOn).toEqual(["look"]);
  });

  it("honours none and some: a review left out hands its dependants to what it reviewed", () => {
    const shaped = shapeEvaluations(keys(), ALL, { add: true }).plan;
    const none = shapeEvaluations(shaped, { mode: "none", kinds: [] }, { add: true }).plan;
    expect(none.tasks.some((x) => x.kind === "evaluation")).toBe(false);
    expect(none.tasks.find((x) => x.key === "keys")?.dependsOn).toEqual(["design"]);
    const some = shapeEvaluations(keys(), { mode: "some", kinds: ["app"] }, { add: true }).plan;
    expect(
      some.tasks.filter((x) => x.kind === "evaluation").map((x) => x.evaluation?.kind),
    ).toEqual(["app"]);
  });

  it("adds nothing on a replan (add false), and never merges a review into a chain of crumbs", () => {
    const shaped = shapeWeb(keys(), new Set(), { setting: ALL, add: false }).plan;
    expect(shaped.tasks.some((x) => x.kind === "evaluation")).toBe(false);
    const chain = plan([
      t({ key: "a", title: "Write a", scope: ["notes/a.md"], difficulty: "low" }),
      t({
        key: "r",
        kind: "evaluation",
        scope: [],
        verify: [],
        dependsOn: ["a"],
        difficulty: "low",
        evaluation: { kind: "checkpoint", why: "w" },
      }),
      t({ key: "b", title: "Write b", scope: ["notes/b.md"], difficulty: "low", dependsOn: ["r"] }),
    ]);
    expect(shapeWeb(chain).plan.tasks.map((x) => x.key)).toEqual(["a", "r", "b"]);
  });

  it("knows a design task, and says the rules the setting allows", () => {
    expect(
      isDesignTask(t({ title: "Build the sound designer", requiredCapabilities: ["ui"] })),
    ).toBe(false);
    expect(
      isDesignTask(t({ title: "Mock-ups of the screens", requiredCapabilities: ["ui"] })),
    ).toBe(true);
    expect(isDesignTask(t({ title: "Anything", scope: ["design/**"] }))).toBe(true);
    expect(evaluationRules({ mode: "none", kinds: [] })).toMatch(/none for this job/);
    expect(evaluationRules({ mode: "some", kinds: ["app"] })).toMatch(/Allowed here: app\./);
  });
});
