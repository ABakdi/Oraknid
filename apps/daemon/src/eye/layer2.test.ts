import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBwrapSandbox, sandboxForTests } from "@oraknid/os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, type Db, openDatabase } from "../db/open.ts";
import { jobs } from "../db/schema.ts";
import { EventBus } from "../events/bus.ts";
import { BUILT_IN_DEFAULT, SkillStore, stableId } from "../skills/store.ts";
import { NotAGitRepo, Projects } from "../workspace/projects.ts";
import { runVerify, signatureOf } from "./verify.ts";

let db: Db;
beforeEach(async () => {
  db = await openDatabase({ file: ":memory:" });
});
afterEach(() => closeDatabase(db));

const folder = () => mkdtempSync(join(tmpdir(), "oraknid-proj-"));
const gitRepo = () => {
  const d = folder();
  spawnSync("git", ["init", "-q", "-b", "master"], { cwd: d });
  return d;
};

describe("skills library", () => {
  it("seeds the built-in skills once, as version 1, the canon-driven one with a stable id", () => {
    const s = new SkillStore(db);
    expect(s.seedBuiltIns()).toBe(3);
    expect(s.seedBuiltIns()).toBe(0);
    expect(s.latest(BUILT_IN_DEFAULT)).toMatchObject({
      name: "canon-driven-development",
      version: 1,
      interview: true,
      source: "built-in",
    });
    expect(stableId("canon-driven-development")).toBe(BUILT_IN_DEFAULT);
    expect(BUILT_IN_DEFAULT).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("makes a changed built-in a new version, keeping the old one for jobs pinned to it", () => {
    const dir = folder();
    writeFileSync(
      join(dir, "canon-driven-development.md"),
      "---\nname: canon-driven-development\n---\nv1",
    );
    const s = new SkillStore(db);
    s.seedBuiltIns(dir);
    writeFileSync(
      join(dir, "canon-driven-development.md"),
      "---\nname: canon-driven-development\n---\nv2",
    );
    s.seedBuiltIns(dir);
    expect(s.latest(BUILT_IN_DEFAULT)?.version).toBe(2);
    expect(s.version(BUILT_IN_DEFAULT, 1)?.body).toBe("v1");
  });

  it("accepts an upload with bad front matter and says what was ignored", () => {
    const { skill, ignored } = new SkillStore(db).upload(
      "---\nname: mine\ninterview: sometimes\n---\nDo it well.",
      "x",
    );
    expect(skill).toMatchObject({
      name: "mine",
      source: "uploaded",
      interview: false,
      body: "Do it well.",
    });
    expect(ignored).toEqual(['"interview" should be true or false, not "sometimes".']);
  });
});

describe("projects", () => {
  const projects = () => {
    const skills = new SkillStore(db);
    skills.seedBuiltIns();
    return new Projects(db, new EventBus(db), skills);
  };

  it("adopts a git repo with its own branches", () => {
    const p = projects().create({ name: "app", workspacePath: gitRepo() });
    expect(p).toMatchObject({
      isGitRepo: true,
      shadow: false,
      releaseBranch: "master",
      workBranch: "dev",
    });
  });

  it("asks before touching a folder that isn't a git repo, then does what I chose", () => {
    const ps = projects();
    const plain = folder();
    expect(() => ps.create({ name: "notes", workspacePath: plain })).toThrow(NotAGitRepo);
    const shadow = ps.create({ name: "notes", workspacePath: plain, initGit: false });
    expect(shadow).toMatchObject({ isGitRepo: false, shadow: true });
    expect(existsSync(join(plain, ".git"))).toBe(false);
    const inited = ps.create({ name: "new", workspacePath: folder(), initGit: true });
    expect(inited).toMatchObject({ isGitRepo: true, releaseBranch: "main" });
  });

  it("refuses a missing folder or one that is already a project, creating nothing", () => {
    const ps = projects();
    expect(() => ps.create({ name: "x", workspacePath: "/nope/nowhere" })).toThrow(
      "/nope/nowhere is not a folder. Nothing was created.",
    );
    const repo = gitRepo();
    ps.create({ name: "a", workspacePath: repo });
    expect(() => ps.create({ name: "b", workspacePath: repo })).toThrow(/already the project "a"/);
  });

  it("creates a draft job with the built-in skill pinned, no money, and an 8-hour alarm", () => {
    const ps = projects();
    const p = ps.create({ name: "app", workspacePath: gitRepo() });
    const id = ps.createJob({
      projectId: p.id,
      goal: "Add a login page\nwith email and password",
      inputs: [],
      autonomy: "auto",
      allowedLegIds: [],
      verify: ["pnpm test"],
      unsandboxed: false,
    });
    const job = db.select().from(jobs).get();
    expect(job).toMatchObject({
      id,
      state: "draft",
      title: "Add a login page",
      skillId: BUILT_IN_DEFAULT,
      skillVersion: 1,
      verify: ["pnpm test"],
    });
    expect(job?.budget).toEqual({
      tokens: null,
      quotaShare: null,
      wallClockMs: { limit: 28_800_000, hard: false },
      money: { limit: 0, hard: true },
    });
  });
});

// The real sandbox where it works; a CI runner without one runs the commands as they are.
const testSandbox = sandboxForTests(createBwrapSandbox());

describe("verifier (BR-1)", () => {
  const plan = () => {
    const root = folder();
    const home = join(root, "home");
    const work = join(root, "work");
    mkdirSync(home);
    mkdirSync(work);
    return {
      work,
      plan: {
        sandbox: testSandbox.sandbox,
        home,
        writable: [],
        readonly: [],
        env: { PATH: "/usr/bin" },
      },
    };
  };

  it("runs each command in the sandbox and stops at the first failure", async () => {
    const { work, plan: p } = plan();
    writeFileSync(join(work, "hello.sh"), "echo hi\n");
    const results = await runVerify(["sh hello.sh | grep -q hi", "exit 3", "echo never"], work, p);
    expect(results.map((r) => [r.command, r.ok, r.exitCode])).toEqual([
      ["sh hello.sh | grep -q hi", true, 0],
      ["exit 3", false, 3],
    ]);
    expect(results[1]?.signature).toMatch(/^[0-9a-f]{16}$/);
  });

  it.runIf(testSandbox.isolated)("cannot reach outside the worktree", async () => {
    const { work, plan: p } = plan();
    const outside = join(work, "..", "outside.txt");
    // Inside, parent folders of bound paths are a throwaway filesystem: the write may "work" there,
    // but nothing reaches the host.
    await runVerify([`echo x > ${outside}`], work, p);
    expect(existsSync(outside)).toBe(false);
    // Its /tmp is private too: nothing lands in the host's.
    await runVerify([`echo x > /tmp/oraknid-verify-escape-${process.pid}`], work, p);
    expect(existsSync(`/tmp/oraknid-verify-escape-${process.pid}`)).toBe(false);
  });

  it("fingerprints a failure the same way when only numbers, times and temp paths change", () => {
    const a = signatureOf(
      "pnpm test",
      "FAIL src/a.test.ts (12 ms)\nExpected 3 to be 4 at /tmp/vitest-abc/x.js:10:5",
    );
    const b = signatureOf(
      "pnpm test",
      "FAIL src/a.test.ts (97 ms)\nExpected 3 to be 4 at /tmp/vitest-zzz/x.js:10:5",
    );
    const c = signatureOf("pnpm test", "FAIL src/b.test.ts\nExpected 'x' to be 'y'");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("skills library over the API", () => {
  it("lists, uploads, edits and deletes my skills; built-ins are read-only", async () => {
    const { startDaemon } = await import("../daemon.ts");
    const { resolvePaths } = await import("../paths.ts");
    const { fakeOs } = await import("../testing/fake-os.ts");
    const { createORPCClient } = await import("@orpc/client");
    const { RPCLink } = await import("@orpc/client/fetch");
    const dir = folder();
    const d = await startDaemon({
      paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
      port: 0,
      dbFile: ":memory:",
      os: fakeOs().os,
      adapters: {},
    });
    try {
      // biome-ignore lint/suspicious/noExplicitAny: a test client
      const api: any = createORPCClient(
        new RPCLink({ url: `${d.url}/api`, headers: { authorization: `Bearer ${d.cliToken}` } }),
      );
      // The default first, then by name.
      expect((await api.skills.list()).map((s: { name: string }) => s.name)).toEqual([
        "canon-driven-development",
        "email-triage",
        "server-work",
      ]);
      await expect(api.skills.edit({ id: BUILT_IN_DEFAULT, markdown: "x" })).rejects.toThrow(
        "Built-in skills are read-only",
      );
      await expect(api.skills.remove({ id: BUILT_IN_DEFAULT })).rejects.toThrow(
        "Built-in skills cannot be deleted.",
      );
      const up = await api.skills.upload({
        name: "emails",
        markdown: "---\nname: triage\ncolour: red\n---\nRead, classify.",
      });
      expect(up.skill).toMatchObject({ name: "triage", version: 1, source: "uploaded" });
      expect(up.ignored).toEqual(['"colour" is not a field Oraknid knows; it was ignored.']);
      const edited = await api.skills.edit({
        id: up.skill.id,
        markdown: "---\nname: triage\n---\nRead, classify, draft.",
      });
      expect(edited.skill.version).toBe(2);
      expect((await api.skills.get({ id: up.skill.id, version: 1 })).body).toBe("Read, classify.");
      await api.skills.remove({ id: up.skill.id });
      expect(await api.skills.list()).toHaveLength(3);
    } finally {
      await d.close();
    }
  });
});
