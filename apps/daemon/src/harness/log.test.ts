import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { closeDatabase, type Db, openDatabase } from "../db/open.ts";
import { attemptEvents, jobs } from "../db/schema.ts";
import { EventBus } from "../events/bus.ts";
import { SkillStore } from "../skills/store.ts";
import { Projects } from "../workspace/projects.ts";
import { AttemptLog, inputSummary } from "./log.ts";

// The attempt log (ADR-056 §1): append-only, ordered per attempt, read in
// bounded slices, kept across a restart, deleted with its job.

const open: Db[] = [];
afterEach(() => {
  for (const db of open.splice(0)) closeDatabase(db);
});

const place = (attemptId: string | null = "a1") => ({ jobId: "j1", taskId: "t1", attemptId });

async function db(file = ":memory:") {
  const d = await openDatabase({ file });
  open.push(d);
  return d;
}

describe("the attempt log (ADR-056 §1)", () => {
  it("appends typed events in order, each attempt its own sequence", async () => {
    const log = new AttemptLog(await db());
    log.append(place(), "SessionOpened", {
      sessionId: "s1",
      legId: "l1",
      model: "m",
      resumed: null,
    });
    log.append(place(), "ActionRequested", { id: "c1", tool: "Bash", input: "ls" });
    log.append(place("a2"), "ActionRequested", { id: "c9", tool: "Bash", input: "pwd" });
    log.append(place(), "ActionResult", { actionId: "c1", ok: true });
    const a1 = log.attempt("a1");
    expect(a1.map((e) => [e.seq, e.kind])).toEqual([
      [1, "SessionOpened"],
      [2, "ActionRequested"],
      [3, "ActionResult"],
    ]);
    expect(log.attempt("a2").map((e) => e.seq)).toEqual([1]);
    expect(log.count("a1")).toBe(3);
    // A task's events without an attempt have their own sequence.
    expect(log.append(place(null), "Forgotten", { reason: "settled" }).seq).toBe(1);
  });

  it("reads bounded slices: an attempt's last N, a task's by kind after a point", async () => {
    const log = new AttemptLog(await db());
    for (let i = 0; i < 10; i++)
      log.append(place(), "ActionRequested", { id: `c${i}`, tool: "Bash", input: `echo ${i}` });
    const marker = log.append(place(null), "Forgotten", { reason: "settled" });
    log.append(place("a2"), "Signal", { kind: "untrusted", code: null, evidence: "web" });
    expect(log.attempt("a1", { limit: 3 }).map((e) => e.data)).toMatchObject([
      { id: "c7" },
      { id: "c8" },
      { id: "c9" },
    ]);
    expect(log.task("t1", { kinds: ["ActionRequested"], limit: 2 }).map((e) => e.seq)).toEqual([
      9, 10,
    ]);
    expect(
      log.task("t1", { kinds: ["ActionRequested", "Signal"], afterId: marker.id }),
    ).toMatchObject([{ kind: "Signal" }]);
    expect(log.lastOf("t1", "Forgotten")?.id).toBe(marker.id);
  });

  it("finds the actions an attempt never saw the result of", async () => {
    const log = new AttemptLog(await db());
    log.append(place(), "ActionRequested", { id: "c1", tool: "Bash", input: "ls" });
    log.append(place(), "ActionResult", { actionId: "c1", ok: true });
    log.append(place(), "ActionRequested", { id: "c2", tool: "Bash", input: "rm -rf build" });
    expect(log.unmatched("a1").map((e) => e.data.id)).toEqual(["c2"]);
    log.append(place(), "ActionUncertain", { actionId: "c2", tool: "Bash", input: "rm -rf build" });
    expect(log.unmatched("a1")).toEqual([]);
  });

  it("keeps everything across a restart", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "oraknid-log-")), "o.db");
    const first = await db(file);
    new AttemptLog(first).append(place(), "ActionRequested", {
      id: "c1",
      tool: "Bash",
      input: "x",
    });
    closeDatabase(first);
    open.splice(open.indexOf(first), 1);
    const log = new AttemptLog(await db(file));
    log.append(place(), "ActionResult", { actionId: "c1", ok: false });
    expect(log.attempt("a1").map((e) => [e.seq, e.kind])).toEqual([
      [1, "ActionRequested"],
      [2, "ActionResult"],
    ]);
  });

  it("is deleted with its job", async () => {
    const d = await db();
    const bus = new EventBus(d);
    const skills = new SkillStore(d);
    skills.seedBuiltIns();
    const projects = new Projects(d, bus, skills);
    const p = projects.create({
      name: "app",
      workspacePath: mkdtempSync(join(tmpdir(), "o-")),
      initGit: true,
    });
    const jobId = projects.createJob({
      projectId: p.id,
      goal: "x",
      inputs: [],
      autonomy: "auto",
      allowedLegIds: [],
      verify: [],
      unsandboxed: false,
    });
    new AttemptLog(d).append({ jobId, taskId: "t1", attemptId: "a1" }, "AttemptEnded", {
      reason: "done",
    });
    projects.removeJob(jobId, mkdtempSync(join(tmpdir(), "o-logs-")));
    expect(d.select().from(jobs).where(eq(jobs.id, jobId)).get()).toBeUndefined();
    expect(d.select().from(attemptEvents).all()).toEqual([]);
  });

  it("keeps a tool call's input short", () => {
    expect(inputSummary({ command: "ls -la" })).toBe("ls -la");
    expect(inputSummary({ file_path: "/a/b" })).toBe("/a/b");
    expect(inputSummary({ q: "x".repeat(1000) }).length).toBe(300);
  });
});
