import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

// Every boundary the engine marks with faultPoint() in the scripted job.
const POINTS = [
  ...[1, 2, 3, 4].flatMap((i) =>
    ["before", "after-run", "after-commit"].map((p) => `step:s${i}:${p}`),
  ),
  ...["api", "mail"].flatMap((k) =>
    ["after-intend", "after-performing", "after-perform", "after-record"].map(
      (p) => `effect:${k}:${p}`,
    ),
  ),
];

const pkg = resolve(import.meta.dirname, "../..");
const child = resolve(import.meta.dirname, "../testing/fault-job.ts");

function run(dir: string, fault?: string) {
  // tsx as a loader inside node itself, so the SIGKILL reaches us as a signal.
  return spawnSync(process.execPath, ["--import", "tsx", child, dir], {
    cwd: pkg,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, ORAKNID_FAULT: fault ?? "" },
  });
}

const lines = (f: string) =>
  existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : [];

describe("fault injection: SIGKILL at every boundary (BR-6, BR-8)", () => {
  it.each(POINTS)("survives a kill at %s", (point) => {
    const dir = mkdtempSync(join(tmpdir(), "oraknid-fault-"));

    const killed = run(dir, point);
    expect(
      killed.signal,
      `expected a SIGKILL at ${point}; stdout: ${killed.stdout} stderr: ${killed.stderr}`,
    ).toBe("SIGKILL");

    const after = run(dir);
    expect(after.status, after.stderr).toBe(0);
    expect(JSON.parse(after.stdout)).toEqual({ state: "completed", reason: null });

    // Every step is recorded done exactly once.
    const db = new Database(join(dir, "o.db"), { readonly: true });
    const steps = db.prepare("select step_key, status from steps order by step_key").all();
    expect(steps).toEqual(["s1", "s2", "s3", "s4"].map((k) => ({ step_key: k, status: "done" })));

    // Step work is at-least-once: only the step cut down before its commit may have run twice.
    const work = lines(join(dir, "work.log"));
    for (const s of ["s1", "s2", "s3", "s4"]) {
      const n = work.filter((w) => w === s).length;
      const crashedHere = point === `step:${s}:after-run`;
      expect(n, `${s} ran ${n} times`).toBe(crashedHere ? 2 : 1);
    }

    // External actions are exactly once.
    const api = JSON.parse(readFileSync(join(dir, "api.json"), "utf8"));
    expect(Object.values(api)).toEqual([1]);
    expect(lines(join(dir, "sent.log"))).toHaveLength(1);
    const effects = db.prepare("select state from side_effects").all();
    expect(effects).toEqual([{ state: "performed" }, { state: "performed" }]);
    db.close();
  });
});
