import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SandboxSpec } from "../sandbox.ts";
import { createBwrapSandbox } from "./bwrap.ts";
import { gitBinds } from "./git-binds.ts";

// A job works in a git worktree of its project (.oraknid/worktrees/<job>), whose
// .git is a file pointing into the project's own .git. Before M13.22 the sandbox
// bound only the worktree: every git command in it said "not a git repository",
// and OpenCode, seeing no repo, ran `git init` (the piano job, 2026-10-03).

const sandbox = createBwrapSandbox();
const live = sandbox.status().available;

const host = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "/usr/bin",
      HOME: cwd,
      GIT_AUTHOR_NAME: "Me",
      GIT_AUTHOR_EMAIL: "me@example.com",
      GIT_COMMITTER_NAME: "Me",
      GIT_COMMITTER_EMAIL: "me@example.com",
    },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

/** A project with a commit, a job worktree on its branch, and a home that knows no git identity. */
function project() {
  const root = mkdtempSync(join(tmpdir(), "oraknid-sbx-git-"));
  const repo = join(root, "piano");
  const home = join(root, "home");
  mkdirSync(repo);
  mkdirSync(home);
  host(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "# piano\n");
  host(repo, "add", "README.md");
  host(repo, "commit", "-q", "-m", "first");
  host(repo, "branch", "-q", "other");
  const worktree = join(repo, ".oraknid", "worktrees", "01JOB");
  host(repo, "worktree", "add", "-q", "-b", "oraknid/piano-01job", worktree, "main");
  return { root, repo, home, worktree };
}

function inSandbox(p: ReturnType<typeof project>, script: string) {
  const spec: SandboxSpec = {
    command: "/bin/sh",
    args: ["-c", script],
    cwd: p.worktree,
    writable: [p.worktree, p.home],
    readonly: [],
    home: p.home,
    env: { PATH: "/usr/bin" },
  };
  const { command, args } = sandbox.wrap(spec);
  return spawnSync(command, args, { encoding: "utf8", timeout: 20_000 });
}

describe("gitBinds", () => {
  it("finds a worktree's own git folder and the project's common one", () => {
    const p = project();
    const b = gitBinds(p.worktree);
    const common = join(p.repo, ".git");
    const admin = join(common, "worktrees", "01JOB");
    // Inside, the project's .git is a throwaway layer over its entries.
    expect(b.layer).toEqual([common]);
    expect(b.readonly).toEqual(
      expect.arrayContaining([join(common, "config"), join(common, "hooks"), join(common, "HEAD")]),
    );
    expect(b.writable).toEqual(
      expect.arrayContaining([
        admin,
        join(common, "objects"),
        join(common, "refs"),
        join(common, "logs"),
      ]),
    );
    // What says where the repository is can't be rewritten from inside (it would point
    // Oraknid's own git, outside the sandbox, at a config the Leg wrote).
    expect(b.protect).toEqual(
      expect.arrayContaining([
        join(p.worktree, ".git"),
        join(admin, "commondir"),
        join(admin, "gitdir"),
      ]),
    );
    expect(b.writable).not.toContain(common);
    expect(b.writable).not.toContain(join(common, "config"));
  });

  it("finds the worktrees of a job folder of several repos (ADR-042)", () => {
    const p = project();
    const api = join(p.root, "api");
    mkdirSync(api);
    host(api, "init", "-q", "-b", "main");
    host(api, "commit", "-q", "--allow-empty", "-m", "first");
    const jobFolder = join(p.root, "job");
    host(p.repo, "worktree", "add", "-q", "-b", "oraknid/web", join(jobFolder, "web"), "main");
    host(api, "worktree", "add", "-q", "-b", "oraknid/api", join(jobFolder, "apps", "api"), "main");
    expect(gitBinds(jobFolder).layer.sort()).toEqual([join(api, ".git"), join(p.repo, ".git")]);
  });

  it("needs nothing for a folder that is a repository itself, or none", () => {
    const p = project();
    const none = { layer: [], writable: [], readonly: [], protect: [] };
    expect(gitBinds(p.repo)).toEqual(none);
    expect(gitBinds(p.home)).toEqual(none);
  });
});

describe.runIf(live)("git in a job's worktree, inside the sandbox", () => {
  it("runs status, add, commit, log, diff and switch -c without a prompt or an identity of its own", () => {
    const p = project();
    const r = inSandbox(
      p,
      [
        "set -e",
        "git status --short",
        "echo hello > notes.md",
        "git diff --stat",
        "git add notes.md",
        "git diff --cached --name-only",
        "git commit -q -m 'docs: notes'",
        "git log --oneline -n 2",
        "git switch -q -c oraknid/piano-01job-try",
        "echo more >> notes.md",
        "git commit -q -am 'docs: more notes'",
        "git switch -q oraknid/piano-01job",
        "git branch --show-current",
      ].join("\n"),
    );
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("notes.md");
    expect(r.stdout).toContain("docs: notes");
    expect(r.stdout.trim().split("\n").at(-1)).toBe("oraknid/piano-01job");
    // The commits are the project's: seen from outside, on the job's branch.
    expect(host(p.repo, "log", "--format=%s", "-n", "1", "oraknid/piano-01job")).toBe(
      "docs: notes",
    );
    expect(host(p.repo, "log", "--format=%s", "-n", "1", "oraknid/piano-01job-try")).toBe(
      "docs: more notes",
    );
  });

  it("keeps the project's config, hooks and the worktree's link out of reach", () => {
    const p = project();
    const r = inSandbox(
      p,
      [
        "echo '[core]' >> ../../../.git/config && echo config-written",
        "echo x > ../../../.git/hooks/pre-commit && echo hook-written",
        "echo 'gitdir: /tmp/x' > .git && echo link-written",
        "rm -f .git && echo link-removed",
        `echo /tmp > ${join(p.repo, ".git", "worktrees", "01JOB", "commondir")} && echo commondir-written`,
        // Written in the throwaway layer: never seen outside.
        "echo /tmp > ../../../.git/commondir",
        "mkdir -p ../../../.git/info && echo '* filter=x' > ../../../.git/info/attributes",
        "git status --short >/dev/null && echo still-a-worktree",
      ].join("\n"),
    );
    expect(r.stdout).not.toMatch(
      /config-written|hook-written|link-written|link-removed|commondir-written/,
    );
    expect(r.stdout).toContain("still-a-worktree");
    expect(readFileSync(join(p.worktree, ".git"), "utf8")).toMatch(/^gitdir: /);
    expect(existsSync(join(p.repo, ".git", "commondir"))).toBe(false);
    expect(existsSync(join(p.repo, ".git", "info", "attributes"))).toBe(false);
    expect(readFileSync(join(p.repo, ".git", "config"), "utf8")).not.toMatch(/\[core\]\s*\[core\]/);
    expect(host(p.worktree, "status", "--short")).toBe("");
  });

  it("deletes a branch it made and stashes, as git does outside", () => {
    const p = project();
    const r = inSandbox(
      p,
      [
        "set -e",
        "git switch -q -c scratch",
        "git switch -q oraknid/piano-01job",
        "git branch -q -D scratch",
        "echo wip > wip.md",
        "git add wip.md",
        "git stash -q",
        "git stash pop -q",
        "git status --short",
      ].join("\n"),
    );
    // Only the branch's settings in the project's config stay (read-only here): said, not fatal.
    expect(r.stderr).not.toMatch(/fatal|packed-refs/);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("wip.md");
    expect(() => host(p.repo, "rev-parse", "--verify", "-q", "refs/heads/scratch")).toThrow();
  });
});
