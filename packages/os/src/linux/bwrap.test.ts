import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SandboxSpec } from "../sandbox.ts";
import { bwrapArgs, createBwrapSandbox } from "./bwrap.ts";

const sandbox = createBwrapSandbox();
const live = sandbox.status().available;

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "oraknid-sbx-"));
  const worktree = join(root, "worktree");
  const home = join(root, "home");
  const outside = join(root, "outside");
  const tools = join(root, "tools");
  for (const d of [worktree, home, outside, tools]) mkdirSync(d);
  writeFileSync(join(outside, "secret.txt"), "do not read");
  writeFileSync(join(tools, "tool.txt"), "tool");
  return { root, worktree, home, outside, tools };
}

function spec(w: ReturnType<typeof workspace>, script: string, env = {}): SandboxSpec {
  return {
    command: "/bin/sh",
    args: ["-c", script],
    cwd: w.worktree,
    writable: [w.worktree, w.home],
    readonly: [w.tools],
    home: w.home,
    env: { PATH: "/usr/bin", ...env },
  };
}

function run(s: SandboxSpec) {
  const { command, args } = sandbox.wrap(s);
  return spawnSync(command, args, { encoding: "utf8", timeout: 10_000 });
}

describe("bwrapArgs", () => {
  const w = { worktree: "/w", home: "/h" };
  const base: SandboxSpec = {
    command: "x",
    args: ["1"],
    cwd: w.worktree,
    writable: [w.worktree, w.home],
    readonly: ["/t"],
    home: w.home,
    env: { PATH: "/usr/bin" },
  };

  it("recreates merged-/usr symlinks instead of binding them", () => {
    const args = bwrapArgs(
      base,
      () => true,
      (p) => (p === "/bin" ? "usr/bin" : undefined),
    );
    expect(args.join(" ")).toContain("--symlink usr/bin /bin");
    expect(args.join(" ")).toContain("--ro-bind /lib /lib");
  });

  it("binds read-only directories before writable ones, so writable wins", () => {
    const args = bwrapArgs(
      base,
      () => false,
      () => undefined,
    );
    expect(args.indexOf("/t")).toBeLessThan(args.indexOf("/w"));
  });

  it("clears the environment and sets HOME", () => {
    const args = bwrapArgs(
      base,
      () => false,
      () => undefined,
    ).join(" ");
    expect(args).toContain("--clearenv");
    expect(args).toContain("--setenv HOME /h");
    expect(args).toMatch(/-- x 1$/);
  });

  it("can drop the network", () => {
    expect(
      bwrapArgs(
        { ...base, network: false },
        () => false,
        () => undefined,
      ),
    ).not.toContain("--share-net");
  });

  it("refuses a cwd or home that is not writable", () => {
    expect(() => bwrapArgs({ ...base, cwd: "/elsewhere" })).toThrow(/cwd/);
    expect(() => bwrapArgs({ ...base, home: "/elsewhere" })).toThrow(/home/);
  });
});

describe.runIf(live)("bubblewrap, for real", () => {
  it("runs in the worktree and can write there", () => {
    const w = workspace();
    const r = run(spec(w, "pwd && echo hi > made.txt"));
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(w.worktree);
    expect(readFileSync(join(w.worktree, "made.txt"), "utf8")).toBe("hi\n");
  });

  it("cannot see a directory it was not given", () => {
    const w = workspace();
    const r = run(spec(w, `cat ${w.outside}/secret.txt`));
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain("do not read");
  });

  it("cannot write to a read-only toolchain directory, but can read it", () => {
    const w = workspace();
    const r = run(spec(w, `cat ${w.tools}/tool.txt && echo x > ${w.tools}/new.txt`));
    expect(r.stdout).toContain("tool");
    expect(r.status).not.toBe(0);
  });

  it("sees only the environment it was given", () => {
    const w = workspace();
    process.env.ORAKNID_TEST_SECRET = "leaked";
    const r = run(spec(w, 'echo "[$ORAKNID_TEST_SECRET][$HOME][$GIVEN]"', { GIVEN: "yes" }));
    delete process.env.ORAKNID_TEST_SECRET;
    expect(r.stdout.trim()).toBe(`[][${w.home}][yes]`);
  });

  it("cannot write to the real home directory", () => {
    const w = workspace();
    const r = run(spec(w, `echo x > ${process.env.HOME}/oraknid-escape-test`));
    expect(r.status).not.toBe(0);
  });

  it("can't reach the desktop's abstract sockets, which live in the shared network namespace (Audit 2)", async () => {
    const w = workspace();
    const name = `oraknid-escape-${process.pid}`;
    const server = createServer(() => {}).listen(`\0${name}`);
    await new Promise((r) => server.once("listening", r));
    try {
      const r = run(
        spec(
          w,
          `python3 -c 'import socket,sys
s=socket.socket(socket.AF_UNIX)
try:
  s.connect("\\0${name}"); print("reached")
except OSError as e: print("refused")'`,
        ),
      );
      expect(r.stdout.trim()).toBe("refused");
    } finally {
      server.close();
    }
  });

  it("takes every process inside down when the sandbox is killed", async () => {
    const w = workspace();
    const marker = `${Math.floor(Math.random() * 1e6)}.5`;
    const { command, args } = sandbox.wrap(spec(w, `sleep ${marker} & sleep ${marker}; wait`));
    const child = spawn(command, args, { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 300));
    expect(pgrep(marker)).toBeGreaterThan(0);
    child.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 300));
    expect(pgrep(marker)).toBe(0);
  });
});

function pgrep(pattern: string): number {
  const r = spawnSync("pgrep", ["-fc", `sleep ${pattern}`], { encoding: "utf8" });
  return Number(r.stdout.trim() || 0);
}
