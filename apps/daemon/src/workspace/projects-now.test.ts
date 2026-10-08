import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { closeDatabase, type Db, openDatabase } from "../db/open.ts";
import { jobs, tasks } from "../db/schema.ts";
import { EventBus } from "../events/bus.ts";
import { SkillStore } from "../skills/store.ts";
import { Projects } from "./projects.ts";

// The Projects list says what each project is doing now (Web-UI → Projects):
// its jobs that haven't ended, their tasks done, and its last activity.

const open: Db[] = [];
afterEach(() => {
  for (const db of open.splice(0)) closeDatabase(db);
});

async function setup() {
  const d = await openDatabase({ file: ":memory:" });
  open.push(d);
  const bus = new EventBus(d);
  const skills = new SkillStore(d);
  skills.seedBuiltIns();
  let clock = 1_000;
  const projects = new Projects(d, bus, skills, () => clock++);
  const p = projects.create({
    name: "app",
    workspacePath: mkdtempSync(join(tmpdir(), "o-now-")),
    initGit: true,
  });
  const job = (goal: string) =>
    projects.createJob({
      projectId: p.id,
      goal,
      inputs: [],
      autonomy: "auto",
      allowedLegIds: [],
      verify: [],
      unsandboxed: false,
    });
  return { d, bus, projects, p, job };
}

const task = (id: string, jobId: string, state: string) => ({
  id,
  jobId,
  title: id,
  instructions: "x",
  kind: "implement",
  scope: [],
  verify: [],
  requiredCapabilities: [],
  difficulty: "low" as const,
  state,
});

describe("what a project is doing now (Web-UI → Projects)", () => {
  it("lists its jobs that haven't ended, newest first, with their tasks done", async () => {
    const { d, projects, p, job } = await setup();
    const old = job("Old work");
    const going = job("Add login");
    const draft = job("A draft");
    d.update(jobs).set({ state: "completed" }).where(eq(jobs.id, old)).run();
    d.update(jobs)
      .set({ state: "running", startedAt: 5_000, queuedAt: null })
      .where(eq(jobs.id, going))
      .run();
    d.insert(tasks)
      .values([
        task("t1", going, "done"),
        task("t2", going, "skipped"),
        task("t3", going, "running"),
        task("t4", going, "pending"),
      ])
      .run();
    const view = projects.list().find((x) => x.id === p.id);
    expect(view?.now).toEqual([
      {
        id: draft,
        title: "A draft",
        state: "draft",
        done: 0,
        total: 0,
        queued: false,
        startedAt: null,
      },
      {
        id: going,
        title: "Add login",
        state: "running",
        done: 2,
        total: 4,
        queued: false,
        startedAt: 5_000,
      },
    ]);
  });

  it("says when one of its jobs last did something, and nothing before any", async () => {
    const { bus, projects, p, job } = await setup();
    const empty = projects.list().find((x) => x.id === p.id);
    expect(empty?.now).toEqual([]);
    expect(empty?.lastActivityAt).toBeNull();
    const id = job("Work");
    bus.publish({ type: "job.state", topic: `job:${id}`, jobId: id, payload: {} });
    const at = projects.list().find((x) => x.id === p.id)?.lastActivityAt;
    expect(typeof at).toBe("number");
  });
});
