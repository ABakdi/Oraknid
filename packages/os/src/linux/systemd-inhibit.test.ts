import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Inhibitor } from "../inhibitor.ts";
import { createSystemdInhibitor } from "./systemd-inhibit.ts";

/** A stand-in for systemd-inhibit: behaves per mode, then runs the wrapped command. */
function fakeInhibit(behaviour: { block: "hold" | "refuse"; delay: "hold" | "refuse" }) {
  const dir = mkdtempSync(join(tmpdir(), "oraknid-inhibit-"));
  const script = join(dir, "fake-inhibit");
  writeFileSync(
    script,
    `#!/bin/sh
mode=""
for a in "$@"; do case "$a" in --mode=*) mode="\${a#--mode=}";; esac; done
if [ "$mode" = block ] && [ "${behaviour.block}" = refuse ]; then echo "Access denied" >&2; exit 1; fi
if [ "$mode" = delay ] && [ "${behaviour.delay}" = refuse ]; then echo "Access denied" >&2; exit 1; fi
exec sleep ${MARK}
`,
  );
  chmodSync(script, 0o755);
  return script;
}

/** Unique per run, so pkill only ever matches our fake holders. */
const MARK = `${process.pid}${Date.now() % 100000}`;

let inhibitor: Inhibitor | undefined;
afterEach(async () => {
  await inhibitor?.release();
  inhibitor = undefined;
});

describe("systemd inhibitor", () => {
  it("holds a blocking lock and releases it", async () => {
    inhibitor = createSystemdInhibitor({
      command: fakeInhibit({ block: "hold", delay: "hold" }),
      settleMs: 150,
    });
    const s = await inhibitor.acquire("1 job running");
    expect(s).toEqual({ held: true, mode: "block", why: "1 job running", problem: null });
    await inhibitor.release();
    expect(inhibitor.state().held).toBe(false);
  });

  it("falls back to a delay lock when blocking is refused, and says so", async () => {
    inhibitor = createSystemdInhibitor({
      command: fakeInhibit({ block: "refuse", delay: "hold" }),
      settleMs: 150,
    });
    const s = await inhibitor.acquire("1 job running");
    expect(s.held).toBe(true);
    expect(s.mode).toBe("delay");
    expect(s.problem).toMatch(/Access denied/);
  });

  it("reports plainly when no lock can be taken", async () => {
    inhibitor = createSystemdInhibitor({
      command: fakeInhibit({ block: "refuse", delay: "refuse" }),
      settleMs: 150,
    });
    const s = await inhibitor.acquire("1 job running");
    expect(s.held).toBe(false);
    expect(s.problem).toMatch(/Could not keep the machine awake/);
  });

  it("re-takes the lock when the holder dies while it is wanted", async () => {
    inhibitor = createSystemdInhibitor({
      command: fakeInhibit({ block: "hold", delay: "hold" }),
      settleMs: 100,
      restartDelayMs: 100,
    });
    await inhibitor.acquire("1 job running");
    const states: boolean[] = [];
    inhibitor.onChange((s) => states.push(s.held));
    spawnSync("pkill", ["-f", `^sleep ${MARK}$`]);
    await new Promise((r) => setTimeout(r, 600));
    expect(states).toEqual([false, true]);
    expect(inhibitor.state().held).toBe(true);
  });
});

const realInhibit = spawnSync("systemd-inhibit", ["--list", "--no-pager"]).status === 0;

describe.runIf(realInhibit)("systemd inhibitor, for real", () => {
  it("shows up in systemd-inhibit --list while held, and is gone after release", async () => {
    inhibitor = createSystemdInhibitor();
    const why = `oraknid test ${process.pid}`;
    expect((await inhibitor.acquire(why)).held).toBe(true);
    expect(list()).toContain(why);
    await inhibitor.release();
    await new Promise((r) => setTimeout(r, 200));
    expect(list()).not.toContain(why);
  });
});

function list() {
  return spawnSync("systemd-inhibit", ["--list", "--no-pager"], { encoding: "utf8" }).stdout;
}
