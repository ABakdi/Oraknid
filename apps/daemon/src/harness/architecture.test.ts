import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Ratchets on the task harness (ADR-056 §9). The attempt reaches the rules,
// the judge, the policy, the grants and the stuck count only through the
// Gate (§3); checks run only through the Verifier (§4); and `attempt.ts`
// doesn't grow back: its line count is a ceiling, lowered as code leaves
// it, never raised.

const here = dirname(fileURLToPath(import.meta.url));
const ATTEMPT = join(here, "..", "eye", "attempt.ts");
const SRC = join(here, "..");

/**
 * attempt.ts's lines when the Verifier and the attempt log were extracted
 * (ADR-056 stage 3; 2,165 after the Gate, 2,973 before). Lower it when a
 * stage moves more out; never raise it.
 */
const CEILING = 2100;

/** Modules only the Gate may use: the guard, the judge and the rules, the policy, the task's memory. */
const GATE_ONLY_MODULES = [
  "@oraknid/guard",
  "./auto-mode.ts",
  "./policy.ts",
  "./approvals.ts",
  "./task-memory.ts",
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

describe("the attempt goes through the Gate (ADR-056 §3, §9)", () => {
  const source = readFileSync(ATTEMPT, "utf8");
  const imports = importsOf(source);

  it("reads the imports it checks", () => {
    expect(imports.some((i) => i.from === "../harness/gate.ts")).toBe(true);
    expect(imports.find((i) => i.from === "@oraknid/core")?.names).toContain("route");
  });

  it("imports no guard, judge, policy or grant module itself", () => {
    expect(imports.map((i) => i.from).filter((f) => GATE_ONLY_MODULES.includes(f))).toEqual([]);
  });

  it("imports none of the decision's parts by name", () => {
    const named = imports.flatMap((i) => i.names.map((n) => `${n} (from ${i.from})`));
    expect(named.filter((n) => GATE_ONLY_NAMES.includes(n.split(" ")[0] as string))).toEqual([]);
  });

  it(`doesn't grow: at most ${CEILING} lines`, () => {
    const lines = source.split("\n").length - (source.endsWith("\n") ? 1 : 0);
    expect(lines).toBeLessThanOrEqual(CEILING);
  });
});

/** Every source file of the daemon, tests left out, relative to src. */
function sources(dir = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [relative(SRC, path)] : [];
  });
}

/** What runs a check's command: only the Verifier may (ADR-056 §4). */
const RUNNERS = ["runVerify", "runServerCheck", "runBuiltinCheck"];

describe("checks run only through the Verifier (ADR-056 §4, §9)", () => {
  const files = sources();

  it("finds the daemon's sources", () => {
    expect(files).toContain(join("eye", "program.ts"));
    expect(files).toContain(join("harness", "verifier.ts"));
  });

  it("no module but the Verifier imports a check's runner", () => {
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
