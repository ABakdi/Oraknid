import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { LegKind } from "@oraknid/contracts";
import { ASK_NAMES, TOOL_VOCABULARY } from "@oraknid/leg-sdk";
import { describe, expect, it } from "vitest";

// Ratchets on the task harness (ADR-056 §9). The attempt is the
// TaskController (`harness/controller.ts`): it reaches the rules, the
// judge, the policy, the grants and the stuck count only through the Gate
// (§3); it decides through `decideOutcome` and applies through
// `applyOutcome` (§6); checks run only through the Verifier (§4); no
// Leg's kind or tool names appear in the harness (§2: capabilities from
// the probe, tool names from the Leg SDK); and `runAttempt` is gone.

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "..");
const ATTEMPT = join(SRC, "eye", "attempt.ts");
const CONTROLLER = join(here, "controller.ts");

/**
 * The controller's lines when it took over from `runAttempt` (ADR-056
 * stage 5; `attempt.ts` was 1,419 lines, 2,973 before stage 2). Lower it
 * when code leaves it; never raise it.
 */
const CEILING = 625;

/** Modules only the Gate may use: the guard, the judge and the rules, the policy, the task's memory. */
const GATE_ONLY_MODULES = [
  "@oraknid/guard",
  "../eye/auto-mode.ts",
  "../eye/policy.ts",
  "../eye/approvals.ts",
  "../eye/task-memory.ts",
];
/** Names only the Gate may use, wherever they come from. */
const GATE_ONLY_NAMES = [
  "decide",
  "gateStep",
  "serverVerdict",
  "removalTargets",
  "namedIn",
  "policyFor",
  "layer1",
  "judgeAction",
  "logDecision",
  "stuck",
  "rememberForTask",
  "readTaskMemory",
  "approveAllLikeThis",
  "verifyRefusal",
];

/**
 * What decides a turn's end (ADR-056 §5–§7): the drift detectors and the
 * ladder, the agent's words read for what isn't the task's or what it needs
 * of me, the answers to my questions. Only core's `decideOutcome` and the
 * harness's facts and apply use them; the controller decides through it.
 */
const DECISION_NAMES = [
  "detect",
  "nextEscalation",
  "SEVERITY",
  "worstDrift",
  "correctivePrompt",
  "claimsDone",
  "saysOwnerNeeded",
  "usageLimitOf",
  "deprecationOf",
  "providerFailure",
  "unusableOf",
  "verdictOf",
  "keepsGoingWrong",
  "readKeepsGoingWrong",
  "agentNeedsAnswer",
  "keepsGoingWrongAnswer",
  "drift",
  "stall",
  "budget",
  "stuck",
  "next",
  "step",
];

/** Each import of a file: its module and the names it brings in. */
function importsOf(source: string): { from: string; names: string[] }[] {
  const out: { from: string; names: string[] }[] = [];
  for (const m of source.matchAll(/^import\s+(type\s+)?([\s\S]*?)\s+from\s+"([^"]+)";/gm)) {
    const clause = m[2] ?? "";
    const names = (clause.match(/\{([\s\S]*)\}/)?.[1] ?? clause)
      .split(",")
      .map((n) =>
        n
          .trim()
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/)[0]
          ?.trim(),
      )
      .filter((n): n is string => !!n);
    out.push({ from: m[3] as string, names });
  }
  return out;
}

/** Every source file of the daemon, tests left out, relative to src. */
function sources(dir = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [relative(SRC, path)] : [];
  });
}

const lines = (s: string) => s.split("\n").length - (s.endsWith("\n") ? 1 : 0);

describe("runAttempt is gone: the TaskController runs an attempt (ADR-056 §8, §9)", () => {
  it("eye/attempt.ts is gone, or a thin export under 150 lines", () => {
    if (existsSync(ATTEMPT)) expect(lines(readFileSync(ATTEMPT, "utf8"))).toBeLessThan(150);
  });

  it("no module runs `runAttempt`; the job's program runs the controller", () => {
    for (const f of sources())
      expect(`${f}: ${readFileSync(join(SRC, f), "utf8")}`).not.toMatch(/\brunAttempt\(/);
    const program = importsOf(readFileSync(join(SRC, "eye", "program.ts"), "utf8"));
    expect(program.find((i) => i.from === "../harness/controller.ts")?.names).toContain(
      "runController",
    );
  });

  it(`the controller doesn't grow: at most ${CEILING} lines`, () => {
    expect(lines(readFileSync(CONTROLLER, "utf8"))).toBeLessThanOrEqual(CEILING);
  });
});

describe("the controller goes through the Gate and decides nothing itself (ADR-056 §3, §6, §8)", () => {
  const source = readFileSync(CONTROLLER, "utf8");
  const imports = importsOf(source);
  const named = imports.flatMap((i) => i.names.map((n) => `${n} (from ${i.from})`));

  it("reads the imports it checks", () => {
    expect(imports.some((i) => i.from === "./gate.ts")).toBe(true);
    expect(imports.find((i) => i.from === "./route.ts")?.names).toContain("pickRoute");
  });

  it("imports no guard, judge, policy or grant module itself", () => {
    expect(imports.map((i) => i.from).filter((f) => GATE_ONLY_MODULES.includes(f))).toEqual([]);
    expect(named.filter((n) => GATE_ONLY_NAMES.includes(n.split(" ")[0] as string))).toEqual([]);
  });

  it("decides through core's decideOutcome and applies through the harness", () => {
    expect(imports.find((i) => i.from === "@oraknid/core")?.names).toContain("decideOutcome");
    expect(imports.find((i) => i.from === "./apply.ts")?.names).toContain("applyOutcome");
  });

  it("imports none of the decision's parts: drift, the ladder, the monitors, the agent's words, my answers", () => {
    expect(named.filter((n) => DECISION_NAMES.includes(n.split(" ")[0] as string))).toEqual([]);
    expect(imports.map((i) => i.from)).not.toContain("../eye/questions.ts");
    expect(imports.map((i) => i.from)).not.toContain("../eye/drift.ts");
  });

  it("reads no turn's end reason nor counts an attempt itself", () => {
    expect(source).not.toMatch(/\bend\.reason\s*===/);
    expect(source).not.toMatch(/"redirected"|"reassigned"/);
  });

  it("the job's program applies an attempt's outcome from a table, its counting from core", () => {
    const program = readFileSync(join(SRC, "eye", "program.ts"), "utf8");
    expect(program).not.toMatch(/switch \(outcome\.kind\)/);
    expect(program).toMatch(/SPENDS_ATTEMPT/);
    expect(program).not.toMatch(/\["failed", "reassigned"\]/);
  });
});

describe("no Leg's kind or tool names in the harness (ADR-056 §2, §9)", () => {
  const harness = sources().filter((f) => f.startsWith(`harness${"/"}`));
  const kinds = LegKind.options;
  /** Each agent's own tool names, from the Leg SDK: the harness asks the SDK what a tool does. */
  const CLASSES = ["shell", "read", "write", "other"];
  const toolNames = [
    ...new Set([
      ...Object.values(TOOL_VOCABULARY).flatMap((v) => [...v.shell, ...v.write]),
      ...ASK_NAMES.shell,
    ]),
  ].filter((t) => !CLASSES.includes(t));

  it("finds the harness's sources, the controller and the sessions among them", () => {
    expect(harness).toContain(join("harness", "controller.ts"));
    expect(harness).toContain(join("harness", "sessions.ts"));
    expect(harness).toContain(join("harness", "route.ts"));
  });

  it("names no Leg kind: capabilities come from the probe, the provider from routing", () => {
    const found = harness.flatMap((f) => {
      const src = readFileSync(join(SRC, f), "utf8");
      return kinds
        .filter((k) => src.includes(`"${k}"`) || src.includes(`'${k}'`))
        .map((k) => `${f}: ${k}`);
    });
    expect(found).toEqual([]);
  });

  it("names no agent's tool: a tool's class is the Leg SDK's", () => {
    const found = harness.flatMap((f) => {
      const src = readFileSync(join(SRC, f), "utf8");
      return toolNames.filter((t) => src.includes(`"${t}"`)).map((t) => `${f}: ${t}`);
    });
    expect(found).toEqual([]);
  });

  it("asks a session for what its Leg can do, never its kind", () => {
    const sessions = readFileSync(join(here, "sessions.ts"), "utf8");
    expect(sessions).toMatch(/capabilitiesOf\(d\.registry\.features\(/);
    // A Leg's kind is compared nowhere in the harness: it is only passed on to routing.
    const compared = harness.filter((f) =>
      /\b(leg|l|legRow)\.kind\s*[!=]==|registry\.(require|get)\([^)]*\)\??\.kind\s*[!=]==|legKind\s*[!=]==/.test(
        readFileSync(join(SRC, f), "utf8"),
      ),
    );
    expect(compared).toEqual([]);
  });
});

describe("checks run only through the Verifier (ADR-056 §4, §9)", () => {
  const files = sources();

  it("finds the daemon's sources", () => {
    expect(files).toContain(join("eye", "program.ts"));
    expect(files).toContain(join("harness", "verifier.ts"));
  });

  it("no module but the Verifier imports a check's runner", () => {
    const RUNNERS = ["runVerify", "runServerCheck", "runBuiltinCheck"];
    const importers = files.filter((f) => {
      const imports = importsOf(readFileSync(join(SRC, f), "utf8"));
      return imports.some((i) => i.names.some((n) => RUNNERS.includes(n)));
    });
    expect(importers).toEqual([join("harness", "verifier.ts")]);
  });

  it("the job's program runs no check itself, nor reads a check's refusal from the policy", () => {
    const imports = importsOf(readFileSync(join(SRC, "eye", "program.ts"), "utf8"));
    const from = imports.map((i) => i.from);
    expect(from).not.toContain("./verify.ts");
    expect(from).not.toContain("../servers/checks.ts");
    expect(from).not.toContain("./policy.ts");
    expect(imports.flatMap((i) => i.names)).not.toContain("decide");
  });
});
