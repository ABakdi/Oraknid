import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  changedSince,
  checkpoint,
  commitAll,
  createWorktree,
  detectBranches,
  git,
  rollback,
  setShadowRoot,
  shadowRepo,
  worktreeGit,
} from "./git.ts";

const sh = (cwd: string, ...a: string[]) =>
  spawnSync("git", a, { cwd, encoding: "utf8" }).stdout.trim();

function repo(branch = "master", commit = true) {
  const dir = mkdtempSync(join(tmpdir(), "oraknid-repo-"));
  sh(dir, "init", "-q", "-b", branch);
  sh(dir, "config", "user.email", "me@example.com");
  sh(dir, "config", "user.name", "Me");
  if (commit) {
    writeFileSync(join(dir, "a.txt"), "one\n");
    sh(dir, "add", ".");
    sh(dir, "commit", "-qm", "start");
  }
  return dir;
}

describe("branches (BR-14)", () => {
  it("uses the repo's own branches, falling back to main and dev", () => {
    const r = repo("master");
    expect(detectBranches(r)).toEqual({ release: "master", work: "dev" });
    sh(r, "branch", "develop");
    expect(detectBranches(r)).toEqual({ release: "master", work: "develop" });
    expect(detectBranches(mkdtempSync(join(tmpdir(), "x-")))).toEqual({
      release: "main",
      work: "dev",
    });
  });
});

describe("worktrees", () => {
  it("makes a job worktree on its own branch from the work branch, and keeps .oraknid out of git", () => {
    const r = repo("master");
    const wt = createWorktree(r, "01J9Z3K8W2Q4V6X8Y0A1B2C3D4", "add-login", detectBranches(r));
    expect(wt.branch).toBe("oraknid/add-login-b2c3d4");
    expect(existsSync(join(wt.path, "a.txt"))).toBe(true);
    expect(sh(r, "branch", "--list", "dev")).toContain("dev");
    expect(readFileSync(join(r, ".git", "info", "exclude"), "utf8")).toContain(
      "/.oraknid/*\n!/.oraknid/silk/",
    );
    expect(sh(r, "status", "--porcelain")).toBe("");
  });

  it("gives a repo with no commit an empty first one", () => {
    const r = repo("main", false);
    const wt = createWorktree(r, "01J9Z3K8W2Q4V6X8Y0A1B2C3D5", "x", detectBranches(r));
    expect(existsSync(wt.path)).toBe(true);
    expect(sh(r, "log", "--format=%s", "main")).toBe("chore: start the repository");
  });
});

describe("checkpoints", () => {
  it("records the work tree on a private ref without touching HEAD, the branch or the index", () => {
    const r = repo();
    const g = { cwd: r, base: [] };
    writeFileSync(join(r, "a.txt"), "two\n");
    writeFileSync(join(r, "new.txt"), "new\n");
    const head = sh(r, "rev-parse", "HEAD");
    const status = sh(r, "status", "--porcelain");
    checkpoint(g, "refs/oraknid/j/t/1", "checkpoint 1", join(r, ".git", "oraknid-tmp"));
    expect(sh(r, "rev-parse", "HEAD")).toBe(head);
    expect(sh(r, "status", "--porcelain")).toBe(status);
    expect(sh(r, "show", "refs/oraknid/j/t/1:new.txt")).toBe("new");
  });

  it("lists what changed since a checkpoint, and rolls back to it, trashing new files", () => {
    const r = repo();
    const g = { cwd: r, base: [] };
    const tmp = join(r, ".git", "oraknid-tmp");
    checkpoint(g, "refs/oraknid/j/t/1", "c1", tmp);
    writeFileSync(join(r, "a.txt"), "broken\n");
    mkdirSync(join(r, "src"));
    writeFileSync(join(r, "src", "junk.ts"), "x");
    expect(changedSince(g, "refs/oraknid/j/t/1", tmp).sort()).toEqual(["a.txt", "src/junk.ts"]);

    const trash = join(r, ".oraknid", "trash");
    const result = rollback(g, "refs/oraknid/j/t/1", tmp, trash);
    expect(result).toEqual({ restored: ["a.txt"], trashed: ["src/junk.ts"] });
    expect(readFileSync(join(r, "a.txt"), "utf8")).toBe("one\n");
    expect(existsSync(join(r, "src", "junk.ts"))).toBe(false);
    expect(changedSince(g, "refs/oraknid/j/t/1", tmp)).toEqual([]);
    // Only the trash is new (this test repo does not exclude .oraknid); a.txt is back as it was.
    expect(sh(r, "status", "--porcelain")).toBe("?? .oraknid/");
  });

  it("commits a task's verified work on the job branch", () => {
    const r = repo();
    writeFileSync(join(r, "b.txt"), "b\n");
    expect(commitAll({ cwd: r, base: [] }, "feat: add b")).toMatch(/^[0-9a-f]{40}$/);
    expect(sh(r, "log", "-1", "--format=%s %an")).toBe("feat: add b Me");
    expect(commitAll({ cwd: r, base: [] }, "nothing")).toBeNull();
  });
});

describe("shadow repo for a folder without git", () => {
  it("checkpoints and rolls back without making my folder a repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "oraknid-plain-"));
    writeFileSync(join(dir, "notes.md"), "v1\n");
    const g = shadowRepo(dir);
    const tmp = join(dir, ".oraknid", "tmp");
    checkpoint(g, "refs/oraknid/j/t/1", "c1", tmp);
    writeFileSync(join(dir, "notes.md"), "v2\n");
    expect(changedSince(g, "refs/oraknid/j/t/1", tmp)).toEqual(["notes.md"]);
    rollback(g, "refs/oraknid/j/t/1", tmp, join(dir, ".oraknid", "trash"));
    expect(readFileSync(join(dir, "notes.md"), "utf8")).toBe("v1\n");
    expect(existsSync(join(dir, ".git"))).toBe(false);
    expect(git(g, ["rev-parse", "--git-dir"]).trim()).toBe(join(dir, ".oraknid", "shadow.git"));
  });
});

describe("a work tree is the Leg's (Audit 1 → S1-01)", () => {
  it("never follows a rewritten .git file, nor runs an fsmonitor found in a repo", () => {
    const r = repo("master");
    const wt = createWorktree(r, "01J9Z3K8W2Q4V6X8Y0A1B2C3E1", "x", detectBranches(r));
    const marker = join(tmpdir(), `oraknid-pwned-${Date.now()}`);
    // The Leg builds its own repo whose fsmonitor runs a command, and points .git at it.
    const evil = join(wt.path, ".oraknid", "evil");
    sh(wt.path, "init", "-q", evil);
    sh(evil, "config", "core.fsmonitor", `touch ${marker}; false`);
    writeFileSync(join(wt.path, ".git"), `gitdir: ${join(evil, ".git")}\n`);
    const g = worktreeGit(r, wt.path);
    checkpoint(g, "refs/oraknid/j/t/1", "c1", join(r, ".oraknid", "tmp"));
    expect(existsSync(marker)).toBe(false);
    expect(git(g, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe(wt.branch);
    // Even a repo of my own with an fsmonitor set runs nothing through Oraknid.
    sh(r, "config", "core.fsmonitor", `touch ${marker}; false`);
    checkpoint(g, "refs/oraknid/j/t/2", "c2", join(r, ".oraknid", "tmp"));
    expect(existsSync(marker)).toBe(false);
    expect(() => worktreeGit(r, join(r, "elsewhere"))).toThrow(/is not a worktree/);
  });

  it("keeps shadow repos in Oraknid's data folder, and resets one moved from the old place", () => {
    const data = mkdtempSync(join(tmpdir(), "oraknid-data-"));
    const dir = mkdtempSync(join(tmpdir(), "oraknid-plain-"));
    writeFileSync(join(dir, "notes.md"), "v1\n");
    const old = shadowRepo(dir);
    const marker = join(tmpdir(), `oraknid-pwned-shadow-${Date.now()}`);
    git(old, ["config", "core.sshCommand", `touch ${marker}`]);
    setShadowRoot(data);
    try {
      const g = shadowRepo(dir);
      expect(git(g, ["rev-parse", "--git-dir"]).trim().startsWith(data)).toBe(true);
      expect(existsSync(join(dir, ".oraknid", "shadow.git"))).toBe(false);
      expect(git(g, ["config", "--get", "core.sshCommand"]).trim()).toBe("");
    } catch (e) {
      // `git config --get` of an unset key fails: that is the reset we want.
      expect(String(e)).toMatch(/config --get core.sshCommand failed/);
    } finally {
      setShadowRoot(null as unknown as string);
    }
  });
});

describe("what a crash or a Leg leaves in a worktree (Audit 1 → D1-10, D1-16)", () => {
  it("checkpoints around a nested repo with no commit", () => {
    const r = repo("master");
    const wt = createWorktree(r, "01J9Z3K8W2Q4V6X8Y0A1B2C3E2", "x", detectBranches(r));
    sh(wt.path, "init", "-q", "vendor/lib");
    writeFileSync(join(wt.path, "b.txt"), "two\n");
    const g = worktreeGit(r, wt.path);
    const tmp = join(r, ".oraknid", "tmp");
    checkpoint(g, "refs/oraknid/j/t/1", "c1", tmp);
    expect(git(g, ["ls-tree", "-r", "--name-only", "refs/oraknid/j/t/1"]).split("\n")).toContain(
      "b.txt",
    );
  });

  it("sets aside a folder a crash left that isn't a worktree, and makes it again", () => {
    const r = repo("master");
    const id = "01J9Z3K8W2Q4V6X8Y0A1B2C3E3";
    const half = join(r, ".oraknid", "worktrees", id);
    mkdirSync(half, { recursive: true });
    writeFileSync(join(half, "junk"), "half made\n");
    const wt = createWorktree(r, id, "x", detectBranches(r));
    expect(existsSync(join(wt.path, "a.txt"))).toBe(true);
    expect(existsSync(join(wt.path, "junk"))).toBe(false);
    // Made again a second time with its branch already there.
    sh(r, "worktree", "remove", "--force", wt.path);
    expect(createWorktree(r, id, "x", detectBranches(r)).branch).toBe(wt.branch);
  });
});
