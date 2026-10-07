import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Ratchets on the task harness (ADR-056 §9). The attempt reaches the rules,
// the judge, the policy, the grants and the stuck count only through the
// Gate (§3); and `attempt.ts` doesn't grow back: its line count is a
// ceiling, lowered as code leaves it, never raised.

const here = dirname(fileURLToPath(import.meta.url));
const ATTEMPT = join(here, "..", "eye", "attempt.ts");

/**
 * attempt.ts's lines when the Gate was extracted (ADR-056 stage 2; 2,973
 * before). Lower it when a stage moves more out; never raise it.
 */
const CEILING = 2165;

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
