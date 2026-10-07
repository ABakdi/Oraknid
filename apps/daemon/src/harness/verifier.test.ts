import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeDatabase, type Db, openDatabase } from "../db/open.ts";
import { EventBus } from "../events/bus.ts";
import type { Servers } from "../servers/service.ts";
import { SkillStore } from "../skills/store.ts";
import { Projects } from "../workspace/projects.ts";
import { checkRefusal } from "./gate.ts";
import { AttemptLog } from "./log.ts";
import { createVerifier, reportOf } from "./verifier.ts";

// The Verifier on its own (ADR-056 §4): one runner for every check, a
// report that tells a broken check from a failing one, guards that must
// pass before the work, each command read by the Gate's rules first.

const open: Db[] = [];
afterEach(() => {
  for (const db of open.splice(0)) closeDatabase(db);
});

const SERVER = { id: "srv-1", name: "Staging", alias: "staging", production: false };

async function setup(o: { production?: boolean; scope?: (path: string) => boolean } = {}) {
  const db = await openDatabase({ file: ":memory:" });
  open.push(db);
  const bus = new EventBus(db);
  const skills = new SkillStore(db);
  skills.seedBuiltIns();
  const cwd = mkdtempSync(join(tmpdir(), "oraknid-verifier-"));
  const projects = new Projects(db, bus, skills);
  const p = projects.create({ name: "app", workspacePath: cwd, initGit: true });
  const jobId = projects.createJob({
    projectId: p.id,
    goal: "Build it",
    inputs: [],
    autonomy: "auto",
    allowedLegIds: [],
    verify: [],
    unsandboxed: true,
  });
  const ran: { id: string; remote: string }[] = [];
  const servers = {
    run: async (id: string, remote: string) => {
      ran.push({ id, remote });
      return remote.includes("missing")
        ? { code: 1, stdout: "", stderr: "not found" }
        : { code: 0, stdout: "ok\n", stderr: "" };
    },
  } as unknown as Servers;
  const log = new AttemptLog(db);
  const refs = [{ ...SERVER, production: o.production ?? false }];
  const stop = new AbortController();
  const verifier = createVerifier(
    { db, servers },
    { id: jobId },
    {
      cwd,
      localCommit: () => null,
      plan: () => null,
      servers: () => refs,
      refuse: checkRefusal(db, jobId, cwd, refs),
      signal: stop.signal,
      log: log.at({ jobId, taskId: "t1", attemptId: "a1" }),
      ...(o.scope ? { scope: { inScope: o.scope } } : {}),
    },
  );
  return { db, cwd, verifier, ran, log, stop };
}

describe("the Verifier (ADR-056 §4)", () => {
  it("runs a local check in the folder, stopping at the first failure, and logs the report", async () => {
    const s = await setup();
    writeFileSync(join(s.cwd, "a.txt"), "hi\n");
    const r = await s.verifier.run(["grep -q hi a.txt", "exit 3", "echo never"], { why: "turn" });
    expect(r.passed).toBe(false);
    expect(r.results.map((x) => [x.command, x.ok])).toEqual([
      ["grep -q hi a.txt", true],
      ["exit 3", false],
    ]);
    expect(r.failures.map((x) => x.exitCode)).toEqual([3]);
    expect(r.broken).toEqual([]);
    expect(s.log.attempt("a1")).toMatchObject([
      {
        kind: "ChecksRan",
        data: {
          passed: false,
          why: "turn",
          results: [
            { command: "grep -q hi a.txt", ok: true },
            { command: "exit 3", ok: false, exitCode: 3 },
          ],
        },
      },
    ]);
  });

  it("runs a check on one of the job's servers there, in its plain form, never locally", async () => {
    const s = await setup();
    const r = await s.verifier.run([
      "ssh -F /home/x/.ssh/config staging 'docker ps'",
      "ssh staging test -f /missing",
    ]);
    expect(s.ran).toEqual([
      { id: "srv-1", remote: "docker ps" },
      { id: "srv-1", remote: "test -f /missing" },
    ]);
    expect(r.results.map((x) => x.ok)).toEqual([true, false]);
    expect(r.failures[0]?.output).toContain("not found");
  });

  it("refuses a change on a production server: a check only reads there", async () => {
    const s = await setup({ production: true });
    const r = await s.verifier.run(["ssh staging 'rm -rf /srv/app'"]);
    expect(s.ran).toEqual([]);
    expect(r.failures[0]?.output).toMatch(/^Oraknid did not run this check: Staging is production/);
    expect(r.broken).toEqual([]);
  });

  it("answers Oraknid's own GitHub checks itself", async () => {
    const s = await setup();
    const r = await s.verifier.run(["oraknid github-repo"]);
    expect(r.results).toHaveLength(1);
    expect(r.results[0]?.ok).toBe(false);
    expect(r.results[0]?.output).toMatch(/GitHub|linked/i);
  });

  it("refuses a command the Gate's rules refuse: a failed check, not a broken one, never run", async () => {
    const s = await setup();
    const r = await s.verifier.run(["sudo touch ran.txt", "npm publish"]);
    expect(r.failures[0]?.output).toMatch(/^Oraknid did not run this check: .*never allowed/);
    expect(r.broken).toEqual([]);
    const gated = await s.verifier.run(["npm publish"]);
    expect(gated.failures[0]?.output).toMatch(/a check never does that\.$/);
    expect(s.log.attempt("a1").at(-1)?.data).toMatchObject({
      results: [{ refused: true }],
    });
  });

  it("tells a broken check (it can't run) from a failing one", async () => {
    const s = await setup();
    const missing = await s.verifier.run(["no-such-program-oraknid --check"]);
    expect(missing.broken).toEqual([
      { command: "no-such-program-oraknid --check", hint: expect.any(String) },
    ]);
    const failing = await s.verifier.run(["test -f nothing-here.txt"]);
    expect(failing.passed).toBe(false);
    expect(failing.broken).toEqual([]);
  });

  it("holds a guard that fails before the work as broken; after it, a failure like any", async () => {
    const s = await setup();
    const guard = "test -f kept.txt # guard: the old file stays";
    const before = await s.verifier.run([guard], { before: true });
    expect(before.guards.map((g) => g.command)).toEqual([guard]);
    expect(before.broken).toEqual([
      { command: guard, hint: "it guards what the work must keep true, yet fails before any work" },
    ]);
    const after = await s.verifier.run([guard]);
    expect(after.broken).toEqual([]);
    expect(after.failures).toHaveLength(1);
    expect(s.log.attempt("a1").map((e) => e.data)).toMatchObject([
      { why: "before", results: [{ guard: true, broken: expect.any(String) }] },
      { why: "turn" },
    ]);
  });

  it("stops with its job", async () => {
    const s = await setup();
    s.stop.abort();
    const r = await s.verifier.run(["sleep 5"]);
    expect(r.passed).toBe(false);
  });

  it("reports an empty run as passed", () => {
    expect(reportOf([])).toEqual({
      passed: true,
      results: [],
      failures: [],
      broken: [],
      guards: [],
    });
  });
});

describe("a check passes because the work is done, not another way (ADR-052 §2)", () => {
  const inSrc = (path: string) => path.startsWith("src/") || path.startsWith("notes/");

  it("fails a check that passes only with a file made outside the task's scope after it failed", async () => {
    const s = await setup({ scope: inSrc });
    const first = await s.verifier.run(["grep -q yes result.txt"]);
    expect(first.passed).toBe(false);
    // The agent writes what the check reads, outside its scope.
    writeFileSync(join(s.cwd, "result.txt"), "yes\n");
    const r = await s.verifier.run(["grep -q yes result.txt"]);
    expect(r.passed).toBe(false);
    expect(r.failures[0]?.output).toMatch(
      /^This check failed, then passed only with files created outside the task's scope after it failed \(result\.txt\)\. Run without them, it fails\./,
    );
    // The file is back where the agent left it.
    expect(readFileSync(join(s.cwd, "result.txt"), "utf8")).toBe("yes\n");
    expect(existsSync(join(s.cwd, "..", "result.txt"))).toBe(false);
  });

  it("passes a check the work inside the scope makes pass", async () => {
    const s = await setup({ scope: inSrc });
    expect((await s.verifier.run(["grep -q yes src/result.txt"])).passed).toBe(false);
    mkdirSync(join(s.cwd, "src"), { recursive: true });
    writeFileSync(join(s.cwd, "src", "result.txt"), "yes\n");
    // Something else outside the scope the check doesn't name changes nothing.
    writeFileSync(join(s.cwd, "scratch.log"), "x\n");
    expect((await s.verifier.run(["grep -q yes src/result.txt"])).passed).toBe(true);
  });

  it("fails a check that needs a named file outside the scope, and passes one that does not", async () => {
    const s = await setup({ scope: inSrc });
    expect((await s.verifier.run(["test -f src/app.txt && test -f extra.txt"])).passed).toBe(false);
    mkdirSync(join(s.cwd, "src"), { recursive: true });
    writeFileSync(join(s.cwd, "src", "app.txt"), "ok\n");
    writeFileSync(join(s.cwd, "extra.txt"), "ok\n");
    // extra.txt is named and outside: hidden, the check fails, so it is flagged.
    expect((await s.verifier.run(["test -f src/app.txt && test -f extra.txt"])).passed).toBe(false);
    // A check that doesn't need it passes, hidden or not.
    expect((await s.verifier.run(["test -f src/app.txt"])).passed).toBe(true);
  });

  it("looks at nothing without a scope (as before)", async () => {
    const s = await setup();
    expect((await s.verifier.run(["grep -q yes result.txt"])).passed).toBe(false);
    writeFileSync(join(s.cwd, "result.txt"), "yes\n");
    expect((await s.verifier.run(["grep -q yes result.txt"])).passed).toBe(true);
  });
});
