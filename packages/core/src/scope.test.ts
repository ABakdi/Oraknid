import { describe, expect, it } from "vitest";
import { detect, type Observed } from "./drift.ts";
import { pathsIn, statedOutputs, taskScope } from "./scope.ts";

const observed = (scope: string[], changedPaths: string[]): Observed => ({
  scope,
  changedPaths,
  commands: [],
  verifyFailures: [],
  falseClaim: null,
  lastActivityAt: 0,
  tokensSinceProgress: 0,
  taskBudgetTokens: null,
  forbidden: [],
  gateBypass: [],
  local: false,
});

describe("a task's scope (M13.22)", () => {
  // The research task of 2026-10-04, as its plan and its repaired checks had it.
  const research = {
    kind: "research",
    scope: ["research", "documentation"],
    verify: [
      "test -s docs/audio-libraries-recommendation.md",
      "awk '/^## Libraries Evaluated/{f=1;next} /^## /{f=0} f && /^\\| \\[/{n++} END{exit !(n>=3)}' docs/audio-libraries-recommendation.md",
      "Latency and feature comparison included",
    ],
    instructions:
      "Investigate Web Audio helper libraries (Tone.js, Timbre.js) for low-latency synthesis.",
  };

  it("holds the file its own check tests: writing it is no drift", () => {
    const scope = taskScope(research);
    expect(scope).toContain("docs/audio-libraries-recommendation.md");
    expect(detect(observed(scope, ["docs/audio-libraries-recommendation.md"]), 0)).toEqual([]);
  });

  it("lets research and planning write their deliverable under docs/", () => {
    const scope = taskScope({ ...research, verify: [] });
    expect(detect(observed(scope, ["docs/notes/web-audio.md"]), 0)).toEqual([]);
  });

  it("still sees what it changed elsewhere", () => {
    const scope = taskScope(research);
    const d = detect(observed(scope, ["src/App.tsx", "docs/audio-libraries-recommendation.md"]), 0);
    expect(d).toEqual([{ code: "D1", evidence: "changed files outside its scope: src/App.tsx" }]);
  });

  it("gives an implementation task no docs/ of its own, only what its checks and instructions name", () => {
    const scope = taskScope({
      kind: "implement",
      scope: ["src/audio/**"],
      verify: ["npm test -- src/audio", "test -f CHANGELOG.md"],
      instructions: "Add the synth engine. Write its notes to `docs/synth.md`.",
    });
    expect(scope).toEqual(["src/audio/**", "src/audio", "CHANGELOG.md", "docs/synth.md"]);
    expect(detect(observed(scope, ["docs/other.md"]), 0)[0]?.code).toBe("D1");
  });

  it.each([
    ["test -s docs/a.md", ["docs/a.md"]],
    ["grep -q 'Tone.js' docs/a.md && wc -l ./README.md", ["docs/a.md", "README.md"]],
    ["node -e \"require('./package.json')\"", []],
    ["npm run build && test -f dist/index.js", ["dist/index.js"]],
    ["curl -s https://example.com/x.json", []],
    ["ls docs/*.md | wc -l", ["docs/*.md"]],
    ["python3 -c 'print(1.5)' > /tmp/out.txt", []],
    ["test -f ../outside.md", []],
  ])("names the files of `%s`", (command, paths) => {
    expect(pathsIn(command)).toEqual(paths);
  });

  it("reads the files instructions say a task writes", () => {
    expect(
      statedOutputs(
        "Compare the libraries and write the recommendation to docs/audio.md.\nCreate `notes/latency.csv` with the numbers. Read src/main.ts first.",
      ),
    ).toEqual(["docs/audio.md", "notes/latency.csv"]);
  });
});
