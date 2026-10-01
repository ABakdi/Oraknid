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
  shadowRepo,
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
