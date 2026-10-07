import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The daemon's build bundles the workspace packages in and leaves every
// third-party package external (tsdown.config.ts), so each one a bundled
// package uses must be the daemon's own dependency too: else an install
// builds a daemon that can't start (seen in v0.2.0's install check:
// "Cannot find package '@ai-sdk/mcp'").

/** Used only by a workspace package's test kit (leg-sdk's `./contract`), never by the daemon. */
const TEST_ONLY = new Set(["vitest"]);

const root = join(import.meta.dirname, "..", "..", "..");
type Pkg = { name: string; dependencies?: Record<string, string> };
const read = (dir: string) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Pkg;

function workspaceDirs(): Map<string, string> {
  const dirs = new Map<string, string>();
  for (const dir of [
    "packages/contracts",
    "packages/core",
    "packages/guard",
    "packages/os",
    "packages/tunnel",
    "packages/legs/sdk",
    "packages/legs/claude-code",
    "packages/legs/codex",
    "packages/legs/opencode",
    "packages/legs/antigravity",
    "packages/legs/openai-compatible",
    "packages/legs/oraknid-agent",
  ])
    dirs.set(read(join(root, dir)).name, join(root, dir));
  return dirs;
}

describe("the daemon's bundle", () => {
  it("lists every third-party package its bundled workspace packages use", () => {
    const daemon = read(join(root, "apps", "daemon"));
    const own = new Set(Object.keys(daemon.dependencies ?? {}));
    const dirs = workspaceDirs();
    const missing: string[] = [];
    const seen = new Set<string>();
    const walk = (name: string) => {
      if (seen.has(name)) return;
      seen.add(name);
      const dir = dirs.get(name);
      expect(dir, `${name} is a workspace package this test knows`).toBeTruthy();
      for (const dep of Object.keys(read(dir as string).dependencies ?? {})) {
        if (dep.startsWith("@oraknid/")) walk(dep);
        else if (!own.has(dep) && !TEST_ONLY.has(dep)) missing.push(`${dep} (used by ${name})`);
      }
    };
    for (const dep of own) if (dep.startsWith("@oraknid/")) walk(dep);
    expect(missing).toEqual([]);
  });
});
