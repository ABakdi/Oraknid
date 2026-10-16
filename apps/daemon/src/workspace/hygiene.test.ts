import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type CommitJudge,
  commitAll,
  discardGenerated,
  ensureIgnoreFile,
  type Git,
  mergeFailureSaid,
  mergeTaskBranch,
  readMergeFailure,
  type StewardMemory,
  stageAll,
  untrackGenerated,
  untrackOraknid,
} from "./git.ts";

// A repository's care (ADR-067 §1, §2, §5, §6), from the Keys project of
// 2026-10-11: its first commit took node_modules (24,141 files) and dist,
// with no .gitignore; a test run rewrote node_modules/.vite in Oraknid's
// checkout, and every merge after was refused, reported as "conflicted ()".

const sh = (cwd: string, ...a: string[]) =>
  spawnSync("git", a, { cwd, encoding: "utf8" }).stdout.trim();

function put(dir: string, files: Record<string, string>) {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
}

/** A repo whose first commit took everything: Keys as it was. */
function keys(): string {
  const dir = mkdtempSync(join(tmpdir(), "oraknid-hygiene-"));
  sh(dir, "init", "-q", "-b", "master");
  sh(dir, "config", "user.email", "me@example.com");
  sh(dir, "config", "user.name", "Me");
  put(dir, {
    "package.json": "{}\n",
    "src/main.tsx": "export {};\n",
    "node_modules/react/index.js": "module.exports = 1;\n",
    "node_modules/.vite/deps/_metadata.json": '{"hash":"a"}\n',
    "dist/index.html": "<html></html>\n",
  });
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "feat: scaffold");
  return dir;
}

const g = (cwd: string): Git => ({ cwd, base: [] });

describe("why a merge failed, as git said it (ADR-067 §2)", () => {
  it("tells local changes, untracked files, a lock and a conflict apart", () => {
    const local = readMergeFailure(
      "error: Your local changes to the following files would be overwritten by merge:\n\tnode_modules/.vite/deps/_metadata.json\n\tsrc/a.ts\nPlease commit your changes or stash them before you merge.\nAborting\n",
    );
    expect(local).toMatchObject({
      kind: "local-changes",
      files: ["node_modules/.vite/deps/_metadata.json", "src/a.ts"],
    });
    expect(mergeFailureSaid(local)).toMatch(/uncommitted changes git won't overwrite/);
    expect(mergeFailureSaid(local)).toMatch(/nothing conflicted/);
    expect(
      readMergeFailure(
        "error: The following untracked working tree files would be overwritten by merge:\n\tdist/x.js\nPlease move or remove them before you merge.\n",
      ),
    ).toMatchObject({ kind: "untracked", files: ["dist/x.js"] });
    expect(
      readMergeFailure("fatal: Unable to create '/r/.git/index.lock': File exists.\n").kind,
    ).toBe("locked");
    expect(
      readMergeFailure("CONFLICT (content): Merge conflict in src/a.ts\n", ["src/a.ts"]),
    ).toMatchObject({ kind: "conflict", files: ["src/a.ts"] });
    // Never "conflicted ()": an empty list says what git said instead.
    expect(mergeFailureSaid(readMergeFailure("fatal: something odd\n"))).toBe(
      "git refused to merge: fatal: something odd",
    );
  });
});

describe("a merge in Oraknid's own checkout (ADR-067 §2)", () => {
  it("isn't stopped by what a test run rewrote under node_modules", async () => {
    const r = keys();
    sh(r, "checkout", "-q", "-b", "task");
    put(r, { "node_modules/.vite/deps/_metadata.json": '{"hash":"task"}\n', "src/b.ts": "b\n" });
    sh(r, "commit", "-qam", "task work");
    sh(r, "add", "src/b.ts");
    sh(r, "commit", "-qm", "b");
    sh(r, "checkout", "-q", "master");
    // A check ran in the job's checkout: Vite rewrote its cache.
    put(r, { "node_modules/.vite/deps/_metadata.json": '{"hash":"check"}\n' });
    const m = await mergeTaskBranch(g(r), "task", "merge: task");
    expect(m.ok).toBe(true);
    expect(existsSync(join(r, "src/b.ts"))).toBe(true);
  });

  it("says why when what blocks it is work, and merges nothing", async () => {
    const r = keys();
    sh(r, "checkout", "-q", "-b", "task");
    put(r, { "src/main.tsx": "export const a = 1;\n" });
    sh(r, "commit", "-qam", "task");
    sh(r, "checkout", "-q", "master");
    put(r, { "src/main.tsx": "// mine, not committed\n" });
    const m = await mergeTaskBranch(g(r), "task", "merge: task");
    expect(m).toMatchObject({ ok: false, kind: "local-changes", files: ["src/main.tsx"] });
    expect(readFileSync(join(r, "src/main.tsx"), "utf8")).toBe("// mine, not committed\n");
  });

  it("joins two tasks' additions to .gitignore", async () => {
    const r = keys();
    put(r, { ".gitignore": "node_modules/\n" });
    sh(r, "add", ".gitignore");
    sh(r, "commit", "-qm", "ignore");
    sh(r, "checkout", "-q", "-b", "task");
    put(r, { ".gitignore": "node_modules/\ncoverage/\n" });
    sh(r, "commit", "-qam", "task");
    sh(r, "checkout", "-q", "master");
    put(r, { ".gitignore": "node_modules/\n.turbo/\n" });
    sh(r, "commit", "-qam", "other");
    const m = await mergeTaskBranch(g(r), "task", "merge: task");
    expect(m.ok).toBe(true);
    expect(readFileSync(join(r, ".gitignore"), "utf8").split("\n")).toEqual(
      expect.arrayContaining(["node_modules/", ".turbo/", "coverage/"]),
    );
  });

  it("discards only what the project's tools rewrote", () => {
    const r = keys();
    put(r, {
      "node_modules/.vite/deps/_metadata.json": "changed\n",
      "src/main.tsx": "my work\n",
    });
    expect(discardGenerated(g(r))).toEqual(["node_modules/.vite/deps/_metadata.json"]);
    expect(readFileSync(join(r, "src/main.tsx"), "utf8")).toBe("my work\n");
  });
});

describe("generated folders a repository tracks (ADR-067 §1)", () => {
  it("untracks them in one commit, keeps every file on disk, and ignores them", async () => {
    const r = keys();
    const done = await untrackGenerated(g(r));
    expect(done?.folders).toEqual([
      { folder: "dist", files: 1 },
      { folder: "node_modules", files: 2 },
    ]);
    expect(sh(r, "log", "-1", "--format=%s")).toBe("chore: stop tracking generated files");
    expect(sh(r, "ls-files")).toBe(
      ["package.json", "src/main.tsx", ".gitignore"].sort().join("\n"),
    );
    expect(existsSync(join(r, "node_modules/react/index.js"))).toBe(true);
    expect(existsSync(join(r, "dist/index.html"))).toBe(true);
    expect(readFileSync(join(r, ".gitignore"), "utf8")).toMatch(
      /node_modules\/\ndist\/|dist\/\nnode_modules\//,
    );
    expect(sh(r, "status", "--porcelain")).toBe("");
    // Nothing more to do the second time.
    expect(await untrackGenerated(g(r))).toBeNull();
  });
});

describe("Oraknid's own folder is never in a project's history (ADR-072 §1)", () => {
  /** A job's branch as the version before ADR-072 left it: the Silk mirror committed. */
  function tracksMirror(): string {
    const r = keys();
    // As the repository's exclude file was: Oraknid's folder out, except the mirror.
    writeFileSync(join(r, ".git", "info", "exclude"), "# Oraknid\n/.oraknid/*\n!/.oraknid/silk/\n");
    put(r, {
      ".gitignore": "node_modules/\ndist/\n",
      ".oraknid/silk/issues.md": "# Issues\n",
      ".oraknid/silk/handoffs/T1.md": "# Handoff\n",
      ".oraknid/trash/x/old.ts": "x\n",
    });
    sh(r, "rm", "-r", "-q", "--cached", "node_modules", "dist");
    sh(r, "add", "-A");
    sh(r, "commit", "-qm", "feat: recover: The job's work");
    return r;
  }

  it("untracks it on the job's branch in one commit, keeps the files, and ignores it", async () => {
    const r = tracksMirror();
    expect(sh(r, "ls-files", ".oraknid")).toBe(
      ".oraknid/silk/handoffs/T1.md\n.oraknid/silk/issues.md",
    );
    const done = await untrackOraknid(g(r));
    expect(done?.files).toBe(2);
    expect(sh(r, "log", "-1", "--format=%s")).toBe("chore: stop tracking Oraknid's own files");
    expect(sh(r, "show", "--name-status", "--format=", "HEAD").split("\n").sort()).toEqual([
      "D\t.oraknid/silk/handoffs/T1.md",
      "D\t.oraknid/silk/issues.md",
      "M\t.gitignore",
    ]);
    expect(sh(r, "ls-files", ".oraknid")).toBe("");
    // Legs still read it on disk.
    expect(readFileSync(join(r, ".oraknid/silk/issues.md"), "utf8")).toBe("# Issues\n");
    expect(readFileSync(join(r, ".gitignore"), "utf8").split("\n")).toContain(".oraknid/");
    const exclude = readFileSync(join(r, ".git", "info", "exclude"), "utf8");
    expect(exclude).not.toContain("!/.oraknid/silk/");
    // Oraknid rewriting its mirror leaves the tree clean: a check of a clean tree passes.
    writeFileSync(join(r, ".oraknid/silk/issues.md"), "# Issues\n\n## New\nx\n");
    expect(sh(r, "status", "--porcelain")).toBe("");
    expect(await untrackOraknid(g(r))).toBeNull();
  });

  it("never stages it in a commit of a task's work, even where the branch still tracks it", async () => {
    const r = tracksMirror();
    writeFileSync(join(r, ".oraknid/silk/issues.md"), "# Issues\n\n## Rewritten\nby Oraknid\n");
    put(r, { "src/parser.ts": "export {};\n" });
    const result = await stageAll(g(r), { ignoreFile: true });
    expect(result.staged).toBe(true);
    expect(sh(r, "diff", "--cached", "--name-only")).toBe("src/parser.ts");
  });
});

describe("a commit of a task's work takes only what belongs (ADR-067 §5, §6)", () => {
  it("leaves out dependencies, build output, secrets and a large binary, and writes a .gitignore", async () => {
    const r = mkdtempSync(join(tmpdir(), "oraknid-scaffold-"));
    sh(r, "init", "-q", "-b", "master");
    sh(r, "config", "user.email", "me@example.com");
    sh(r, "config", "user.name", "Me");
    sh(r, "commit", "-q", "--allow-empty", "-m", "start");
    put(r, {
      "package.json": '{"name":"keys"}\n',
      "pnpm-lock.yaml": "lockfileVersion: 9\n",
      "src/main.tsx": "export {};\n",
      "node_modules/react/index.js": "x\n",
      "dist/index.html": "<html></html>\n",
      ".env": "API_KEY=abc\n",
      "src/secret.ts": 'export const k = "AKIAABCDEFGHIJKLMNOP";\n',
    });
    writeFileSync(join(r, "tool.bin"), Buffer.alloc(30 * 1024 * 1024, 1));
    const result = await stageAll(g(r), { ignoreFile: true });
    expect(result.staged).toBe(true);
    const staged = sh(r, "diff", "--cached", "--name-only").split("\n").sort();
    expect(staged).toEqual([".gitignore", "package.json", "pnpm-lock.yaml", "src/main.tsx"]);
    expect(result.ignore).toMatch(/wrote a .gitignore/);
    expect(result.left.map((l) => [l.path, l.why]).sort()).toEqual([
      ["src/secret.ts", "secret"],
      ["tool.bin", "artifact"],
    ]);
    const ignore = readFileSync(join(r, ".gitignore"), "utf8");
    expect(ignore).toContain("node_modules/");
    expect(ignore).toContain("dist/");
    expect(ignore).toContain(".env");
    // What was left out stays out of the next commit too, and on disk.
    sh(r, "commit", "-qm", "scaffold");
    expect(await commitAll(g(r), "again", { ignoreFile: true })).toBeNull();
    expect(existsSync(join(r, "tool.bin"))).toBe(true);
  });

  it("extends an existing .gitignore with generated folders it misses", () => {
    const r = keys();
    put(r, { ".gitignore": "*.log\n" });
    expect(ensureIgnoreFile(g(r))).toMatch(/added .*node_modules\//);
    const text = readFileSync(join(r, ".gitignore"), "utf8");
    expect(text.startsWith("*.log\n")).toBe(true);
    // dist is tracked here, on purpose as far as Oraknid knows: never ignored.
    expect(text).not.toContain("dist/");
    // What Oraknid writes there keeps its own folder out too (ADR-072 §1), once.
    expect(text.split("\n").filter((l) => l === ".oraknid/")).toHaveLength(1);
  });

  it("asks the judge about an unusual commit and does what it says", async () => {
    const r = mkdtempSync(join(tmpdir(), "oraknid-unusual-"));
    sh(r, "init", "-q", "-b", "master");
    sh(r, "config", "user.email", "me@example.com");
    sh(r, "config", "user.name", "Me");
    put(r, { "src/a.ts": "a\n", ".gitignore": "node_modules/\n" });
    sh(r, "add", "-A");
    sh(r, "commit", "-qm", "start");
    put(r, { "src/b.ts": "b\n", "downloads/big/x.json": "{}\n", "downloads/big/y.json": "{}\n" });
    const asked: string[] = [];
    const result = await stageAll(g(r), {
      ignoreFile: true,
      scope: ["src/**"],
      judge: async ({ why, folders }) => {
        asked.push(why);
        return {
          folders: folders.map((f) => ({
            folder: f.folder,
            include: !f.folder.startsWith("downloads"),
            reason: f.folder.startsWith("downloads") ? "downloaded data" : "source",
          })),
        };
      },
    });
    expect(asked[0]).toMatch(/outside the task's scope: downloads\//);
    expect(sh(r, "diff", "--cached", "--name-only")).toBe("src/b.ts");
    expect(result.left.map((l) => l.why)).toEqual(["judged", "judged"]);
    expect(result.judged).toMatch(/downloaded data/);
  });

  it("asks the steward about a kind of project it doesn't know, writes its ignore lines, and remembers", async () => {
    const r = mkdtempSync(join(tmpdir(), "oraknid-odin-"));
    sh(r, "init", "-q", "-b", "master");
    sh(r, "config", "user.email", "me@example.com");
    sh(r, "config", "user.name", "Me");
    put(r, { "src/main.odin": "package main\n" });
    sh(r, "add", "-A");
    sh(r, "commit", "-qm", "start");
    put(r, { "src/util.odin": "package main\n", "odin-out/app.o": "\0\0object" });
    let memory: StewardMemory = { folders: {}, ignore: [] };
    let calls = 0;
    const judge: CommitJudge = async ({ why, folders }) => {
      calls++;
      expect(why).toMatch(/isn't one Oraknid's conventions know/);
      return {
        folders: folders.map((f) => ({
          folder: f.folder,
          include: f.folder !== "odin-out/",
          reason: f.folder === "odin-out/" ? "the compiler's output" : "source",
        })),
        ignore: ["odin-out/", "!src/", "*"],
      };
    };
    const opts = () => ({
      ignoreFile: true,
      judge,
      memory,
      remember: (m: StewardMemory) => {
        memory = m;
      },
    });
    await stageAll(g(r), opts());
    expect(sh(r, "diff", "--cached", "--name-only").split("\n").sort()).toEqual([
      ".gitignore",
      "src/util.odin",
    ]);
    // Only a plain pattern is taken from a model: never a negation, never "ignore everything".
    const ignore = readFileSync(join(r, ".gitignore"), "utf8");
    expect(ignore).toContain("odin-out/");
    expect(ignore).not.toMatch(/^!src\/$/m);
    expect(ignore).not.toMatch(/^\*$/m);
    expect(memory.ignore).toEqual(["odin-out/"]);
    sh(r, "commit", "-qm", "util");
    // The same folders again: decided before, no model asked.
    put(r, { "src/more.odin": "package main\n", "odin-out/b.o": "\0x" });
    const again = await stageAll(g(r), opts());
    expect(calls).toBe(1);
    expect(again.judged).toMatch(/decided before/);
    expect(sh(r, "diff", "--cached", "--name-only")).toBe("src/more.odin");
  });
});
