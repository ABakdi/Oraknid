import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Every package's test run gets one temporary folder, removed when the run
 * ends: the tests' own temporary folders go inside it, so none are left in
 * /tmp (they once used up its inodes).
 */
export default function setup() {
  const before = process.env.TMPDIR;
  const dir = mkdtempSync(join(tmpdir(), "oraknid-test-"));
  process.env.TMPDIR = dir;
  return () => {
    rmSync(dir, { recursive: true, force: true });
    if (before === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = before;
  };
}
