import { describe, expect, it } from "vitest";
import { detect } from "../drift.ts";
import { budget, drift, type Observed, type Step, stall, stuck } from "./monitors.ts";

// The monitors (ADR-056 §5): signals from what an attempt did, never an act.

const seen = (over: Partial<Observed> = {}): Observed => ({
  scope: ["src/"],
  changedPaths: [],
  commands: [],
  verifyFailures: [],
  falseClaim: null,
  lastActivityAt: 0,
  tokensSinceProgress: 0,
  taskBudgetTokens: null,
  forbidden: [],
  gateBypass: [],
  local: false,
  ...over,
});

describe("drift (D1–D4, D7, D8)", () => {
  it.each([
    ["nothing", {}, []],
    ["an edit outside the scope", { changedPaths: ["src/a.ts", "package.json"] }, ["D1"]],
    ["Oraknid's own files", { changedPaths: [".oraknid/notes.md", "notes/handoff.md"] }, []],
    [
      "the same command and result three times",
      { commands: Array(3).fill({ command: "npm test", outputHash: "x" }) },
      ["D2"],
    ],
    [
      "the same command, different results",
      {
        commands: ["a", "b", "c"].map((h) => ({ command: "npm test", outputHash: h })),
      },
      [],
    ],
    ["the same failure three times", { verifyFailures: ["s", "s", "s"] }, ["D3"]],
    ["a claim of done that failed", { falseClaim: "said it was done" }, ["D4"]],
    ["a forbidden action", { forbidden: ["tried `sudo ls`"] }, ["D7"]],
    ["a refused gate tried again", { gateBypass: ["tried `nmap` again"] }, ["D8"]],
  ] as [string, Partial<Observed>, string[]][])("%s", (_, over, codes) => {
    expect(drift(seen(over)).map((s) => s.code)).toEqual(codes);
  });
});

describe("stall (D5) and budget (D6, turns)", () => {
  it("a stall after five minutes, ten for a local model", () => {
    expect(stall(seen(), 5 * 60_000)).toEqual([]);
    expect(stall(seen(), 5 * 60_000 + 1).map((s) => s.code)).toEqual(["D5"]);
    expect(stall(seen({ local: true }), 6 * 60_000)).toEqual([]);
  });

  it("tokens past the task's share, or 150k without a budget", () => {
    expect(budget(seen({ tokensSinceProgress: 150_001 })).map((s) => s.code)).toEqual(["D6"]);
    expect(budget(seen({ tokensSinceProgress: 31, taskBudgetTokens: 100 }))[0]?.code).toBe("D6");
    expect(budget(seen({ tokensSinceProgress: 30, taskBudgetTokens: 100 }))).toEqual([]);
  });

  it("the turns at their limit", () => {
    expect(budget(seen(), undefined, { turns: 24, max: 25 })).toEqual([]);
    expect(budget(seen(), undefined, { turns: 25, max: 25 })).toEqual([
      { kind: "budget", code: "turns", evidence: "took 25 turns" },
    ]);
  });

  it("detect reads the drift, stall and budget monitors as before, in D1–D8 order", () => {
    const all = seen({
      changedPaths: ["x"],
      gateBypass: ["b"],
      forbidden: ["f"],
      falseClaim: "c",
      tokensSinceProgress: 200_000,
    });
    expect(detect(all, 10 * 60_000).map((d) => d.code)).toEqual([
      "D1",
      "D4",
      "D5",
      "D6",
      "D7",
      "D8",
    ]);
  });
});

describe("stuck (OpenHands' patterns over the log)", () => {
  let n = 0;
  const act = (action: string, ok = true, out = "same"): Step[] => {
    const id = `a${++n}`;
    return [
      { kind: "action", id, action },
      { kind: "result", id, ok, out },
    ];
  };
  const say: Step = { kind: "text", text: "Working on it." };

  it.each([
    ["nothing", [], []],
    [
      "the same action and result four times",
      [1, 2, 3, 4].flatMap(() => act("npm test")),
      ["repeat"],
    ],
    ["three times is not yet", [1, 2, 3].flatMap(() => act("npm test")), []],
    [
      "the same action, other results",
      ["a", "b", "c", "d"].flatMap((o) => act("npm test", true, o)),
      [],
    ],
    [
      "the same action failing three times",
      [1, 2, 3].flatMap(() => act("npm test", false)),
      ["error"],
    ],
    ["three turns of words, no action", [say, say, say], ["talk"]],
    ["words between actions", [say, ...act("ls"), say, say], []],
    [
      "two actions taking turns",
      [1, 2, 3].flatMap(() => [...act("cat a"), ...act("cat b")]),
      ["alternate"],
    ],
    [
      "an action without its result yet",
      [
        ...[1, 2, 3].flatMap(() => act("npm test")),
        { kind: "action", id: "z", action: "npm test" },
      ],
      [],
    ],
  ] as [string, Step[], string[]][])("%s", (_, steps, codes) => {
    expect(stuck(steps).map((s) => s.code)).toEqual(codes);
  });
});
