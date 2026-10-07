import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide } from "@oraknid/core";
import { createBwrapSandbox } from "@oraknid/os";
import { describe, expect, it } from "vitest";
import { jobHomeDir, prepareJobHome, removeJobHomes, scratchFor } from "./job-home.ts";
import { sandboxPlan } from "./plan.ts";
import type { LegRow } from "./registry.ts";

/** A Claude Code Leg signed in: its login and settings, and what its earlier sessions left. */
function signedInLeg() {
  const root = mkdtempSync(join(tmpdir(), "oraknid-jobhome-"));
  const legsDir = join(root, "legs");
  const legHome = join(legsDir, "L1", "home");
  const configDir = join(legsDir, "L1", "claude-config");
  mkdirSync(join(legHome, ".config", "tool"), { recursive: true });
  mkdirSync(join(legHome, ".ssh"), { recursive: true });
  mkdirSync(join(legHome, ".local", "share", "opencode", "storage"), { recursive: true });
  writeFileSync(join(legHome, ".config", "tool", "settings"), "shared settings");
  writeFileSync(join(legHome, ".ssh", "old_key"), "a key of before");
  writeFileSync(join(legHome, ".local", "share", "opencode", "auth.json"), "opencode login");
  writeFileSync(join(legHome, ".local", "share", "opencode", "storage", "s1"), "old session");
  mkdirSync(join(configDir, "projects", "-old-job"), { recursive: true });
  writeFileSync(join(configDir, ".credentials.json"), "the login");
  writeFileSync(join(configDir, "projects", "-old-job", "t.jsonl"), "old transcript");
  const leg = {
    id: "L1",
    kind: "claude-code",
    config: { configDir, binary: "claude" },
  } as unknown as LegRow;
  const worktree = (job: string) => {
    const w = join(root, "work", job);
    mkdirSync(w, { recursive: true });
    return w;
  };
  return { root, legsDir, legHome, configDir, leg, worktree };
}

describe("a home per job on a shared Leg (Audit 2, S2-08)", () => {
  it("links the Leg's login and settings in, and keeps each job's own things its own", () => {
    const l = signedInLeg();
    const a = prepareJobHome({
      legsDir: l.legsDir,
      legId: "L1",
      jobId: "A",
      legHome: l.legHome,
      legConfigDir: l.configDir,
    });
    expect(a.home).toBe(jobHomeDir(l.legsDir, "L1", "A"));
    expect(a.home.startsWith(l.legHome)).toBe(false);
    expect(readFileSync(join(a.configDir ?? "", ".credentials.json"), "utf8")).toBe("the login");
    expect(readFileSync(join(a.home, ".config", "tool", "settings"), "utf8")).toBe(
      "shared settings",
    );
    expect(readFileSync(join(a.home, ".local/share/opencode/auth.json"), "utf8")).toBe(
      "opencode login",
    );
    // Not linked: SSH keys, earlier transcripts and sessions.
    expect(existsSync(join(a.home, ".ssh"))).toBe(false);
    expect(existsSync(join(a.configDir ?? "", "projects"))).toBe(false);
    expect(existsSync(join(a.home, ".local/share/opencode/storage"))).toBe(false);
    expect(a.shared).toContain(join(l.configDir, ".credentials.json"));
    expect(a.shared).not.toContain(join(l.legHome, ".ssh"));
    expect(a.shared).not.toContain(join(l.configDir, "projects"));
    expect(a.shared.some((p) => p.includes("storage"))).toBe(false);
  });

  it("gives a token a program rewrote by rename back to the Leg, for every job", () => {
    const l = signedInLeg();
    const prep = (jobId: string) =>
      prepareJobHome({
        legsDir: l.legsDir,
        legId: "L1",
        jobId,
        legHome: l.legHome,
        legConfigDir: l.configDir,
      });
    const a = prep("A");
    const cred = join(a.configDir ?? "", ".credentials.json");
    // A refresh written to a new file and renamed over the link.
    writeFileSync(`${cred}.new`, "refreshed login");
    renameSync(`${cred}.new`, cred);
    const later = Date.now() / 1000 + 5;
    utimesSync(cred, later, later);
    const b = prep("B");
    expect(readFileSync(join(l.configDir, ".credentials.json"), "utf8")).toBe("refreshed login");
    expect(readFileSync(join(b.configDir ?? "", ".credentials.json"), "utf8")).toBe(
      "refreshed login",
    );
    expect(lstatSync(cred).isSymbolicLink()).toBe(true);
    expect(readlinkSync(cred)).toBe(join(l.configDir, ".credentials.json"));
  });

  it("removes a job's home when it ends, its keys with it", () => {
    const l = signedInLeg();
    const a = prepareJobHome({
      legsDir: l.legsDir,
      legId: "L1",
      jobId: "A",
      legHome: l.legHome,
      legConfigDir: l.configDir,
    });
    mkdirSync(join(a.home, ".ssh"));
    writeFileSync(join(a.home, ".ssh", "key"), "job A's key");
    removeJobHomes(l.legsDir, "A", () => l.configDir);
    expect(existsSync(a.home)).toBe(false);
    expect(readFileSync(join(l.configDir, ".credentials.json"), "utf8")).toBe("the login");
  });

  const sandbox = createBwrapSandbox();
  it.skipIf(!sandbox.status().available)(
    "job A's session can't read job B's files, keys or transcripts, and still has the login",
    () => {
      const l = signedInLeg();
      const run = (jobId: string, script: string) => {
        const plan = sandboxPlan(l.leg, sandbox, l.legsDir, [], jobId);
        const cwd = l.worktree(jobId);
        const w = plan.sandbox.wrap({
          command: "/bin/sh",
          args: ["-c", script],
          cwd,
          writable: [...new Set([cwd, plan.home, plan.configDir ?? "", ...plan.writable])].filter(
            Boolean,
          ),
          readonly: plan.readonly,
          home: plan.home,
          env: { ...plan.env, CLAUDE_CONFIG_DIR: plan.configDir ?? "" },
        });
        return spawnSync(w.command, w.args, { encoding: "utf8" });
      };
      const b = run(
        "B",
        'set -e; echo "B notes" > ~/notes.txt; mkdir -p ~/.ssh && echo "B key" > ~/.ssh/key; mkdir -p "$CLAUDE_CONFIG_DIR/projects/b" && echo "B transcript" > "$CLAUDE_CONFIG_DIR/projects/b/t.jsonl"; cat "$CLAUDE_CONFIG_DIR/.credentials.json"',
      );
      expect(b.status, b.stderr).toBe(0);
      expect(b.stdout).toContain("the login");
      const bHome = jobHomeDir(l.legsDir, "L1", "B");
      expect(readFileSync(join(bHome, "notes.txt"), "utf8")).toBe("B notes\n");

      const bConfig = join(bHome, "..", "claude-config");
      const a = run(
        "A",
        [
          `cat ${bHome}/notes.txt && echo READ-NOTES`,
          `cat ${bHome}/.ssh/key && echo READ-KEY`,
          `cat ${bConfig}/projects/b/t.jsonl && echo READ-TRANSCRIPT`,
          `cat ${l.legHome}/.ssh/old_key && echo READ-OLD-KEY`,
          `cat ${l.configDir}/projects/-old-job/t.jsonl && echo READ-OLD-TRANSCRIPT`,
          `ls ~/.ssh 2>/dev/null && echo SAW-SSH`,
          'cat "$CLAUDE_CONFIG_DIR/.credentials.json"',
          "cat ~/.config/tool/settings",
          "true",
        ].join("; "),
      );
      expect(a.status, a.stderr).toBe(0);
      expect(a.stdout).not.toMatch(
        /READ-|SAW-SSH|B notes|B key|B transcript|old_key|old transcript/,
      );
      expect(a.stdout).toContain("the login");
      expect(a.stdout).toContain("shared settings");
    },
  );
});

describe("a job's scratch on its Leg (M13.22)", () => {
  /** An OpenCode Leg as its probe left it: its tmp, its database, its login. */
  function openCodeLeg() {
    const root = mkdtempSync(join(tmpdir(), "oraknid-scratch-"));
    const legsDir = join(root, "legs");
    const legHome = join(legsDir, "OC", "home");
    const data = join(legHome, ".local", "share", "opencode");
    mkdirSync(join(legHome, "tmp", "opencode"), { recursive: true });
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "opencode.db"), "the Leg's sessions");
    writeFileSync(join(data, "auth.json"), "opencode login");
    return { root, legsDir, legHome, data };
  }

  it("gives each job its own tmp and OpenCode database, its login still shared", () => {
    const l = openCodeLeg();
    const a = prepareJobHome({ legsDir: l.legsDir, legId: "OC", jobId: "A", legHome: l.legHome });
    expect(existsSync(join(a.home, "tmp"))).toBe(false);
    expect(existsSync(join(a.home, ".local/share/opencode/opencode.db"))).toBe(false);
    expect(readFileSync(join(a.home, ".local/share/opencode/auth.json"), "utf8")).toBe(
      "opencode login",
    );
    expect(a.shared).not.toContain(join(l.legHome, "tmp"));
    expect(a.shared).not.toContain(join(l.data, "opencode.db"));
  });

  it("turns the links an older home had for them into the job's own", () => {
    const l = openCodeLeg();
    const home = jobHomeDir(l.legsDir, "OC", "A");
    mkdirSync(join(home, ".local", "share", "opencode"), { recursive: true });
    symlinkSync(join(l.legHome, "tmp"), join(home, "tmp"));
    symlinkSync(join(l.data, "opencode.db"), join(home, ".local/share/opencode/opencode.db"));
    prepareJobHome({ legsDir: l.legsDir, legId: "OC", jobId: "A", legHome: l.legHome });
    expect(existsSync(join(home, "tmp"))).toBe(false);
    expect(existsSync(join(home, ".local/share/opencode/opencode.db"))).toBe(false);
    // The Leg's own are untouched.
    expect(readFileSync(join(l.data, "opencode.db"), "utf8")).toBe("the Leg's sessions");
  });

  it("lets OpenCode write its own tmp, as the refused writes of 2026-10-04 asked", () => {
    const l = openCodeLeg();
    // The sandbox's own /tmp aside: this test's folders are under the host's.
    const scratch = scratchFor(l.legsDir, "OC", "J").filter((s) => s !== "/tmp");
    expect(scratchFor(l.legsDir, "OC", "J")).toContain("/tmp");
    const ctx = {
      worktree: join(l.root, "piano"),
      autonomy: "auto" as const,
      waived: new Set<never>(),
      scratch,
    };
    const write = (path: string) => decide({ tool: "Write", command: null, path }, ctx).verdict;
    // OpenCode's external_directory asks, as they came (a pattern ending in /*).
    expect(write(join(l.legHome, "tmp", "opencode", "*"))).toBe("allow");
    expect(write(join(l.legHome, "tmp", "opencode", "audiobench", "*"))).toBe("allow");
    expect(write(join(jobHomeDir(l.legsDir, "OC", "J"), "tmp", "opencode", "x.txt"))).toBe("allow");
    // Anywhere else is still refused: the Leg's login, another job's home, my home.
    expect(write(join(l.data, "auth.json"))).toBe("deny");
    expect(write(join(jobHomeDir(l.legsDir, "OC", "K"), "tmp", "x"))).toBe("deny");
    expect(write("/home/someone/.bashrc")).toBe("deny");
  });
});
