import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, type Db, openDatabase } from "../db/open.ts";
import { attempts, jobs, legModels, legs, sessions, settings, tasks } from "../db/schema.ts";
import { projectBudgetKey } from "../settings.ts";
import { seedJob } from "../testing/fixtures.ts";
import { charts } from "./stats.ts";

// The charts' numbers (Web-UI → Charts): seeded attempts, sessions and budgets.

const H = 3600_000;
const DAY = 24 * H;
const T0 = Date.parse("2026-10-01T00:00:00.000Z");

let db: Db;
let jobA: string;
let jobB: string;
let projectId: string;
let n = 0;

function leg(id: string, name: string, kind: string) {
  db.insert(legs)
    .values({ id, name, kind, config: {}, enabled: true, health: "healthy", quota: [] })
    .run();
  db.insert(legModels)
    .values({
      id: `${id}-m`,
      legId: id,
      model: "m",
      displayName: "m",
      hidden: false,
      effortLevels: [],
      quota: [],
      profile: {},
    })
    .run();
}

function task(jobId: string, id: string, kind: string) {
  db.insert(tasks)
    .values({
      id,
      jobId,
      title: id,
      instructions: "",
      kind,
      scope: [],
      verify: [],
      requiredCapabilities: [],
      difficulty: "low",
      state: "done",
    })
    .run();
}

/** An attempt of `taskId` on `legId`, and its session's tokens. */
function attempt(
  jobId: string,
  taskId: string,
  legId: string,
  outcome: "succeeded" | "failed" | "reassigned" | null,
  startedAt: number,
  ms: number,
  tokens: number,
) {
  const id = `a${++n}`;
  db.insert(attempts)
    .values({
      id,
      taskId,
      jobId,
      legId,
      legModelId: `${legId}-m`,
      startedAt,
      endedAt: outcome ? startedAt + ms : null,
      outcome,
      escalations: [],
    })
    .run();
  db.insert(sessions)
    .values({
      id: `s${n}`,
      attemptId: id,
      jobId,
      taskId,
      legId,
      legModelId: `${legId}-m`,
      logFile: "/dev/null",
      startedAt,
      inputTokens: tokens,
    })
    .run();
}

beforeEach(async () => {
  db = await openDatabase({ file: ":memory:" });
  jobA = seedJob(db, "running");
  projectId = db.select().from(jobs).where(eq(jobs.id, jobA)).get()?.projectId as string;
  jobB = seedJob(db, "completed");
  leg("L1", "Work", "claude-code");
  leg("L2", "Ollama", "openai-compatible");
  task(jobA, "t1", "code");
  task(jobA, "t2", "code");
  task(jobA, "t3", "docs");
  task(jobB, "t4", "test");
  // t1: Work fails, hands off to Ollama, which verifies it (a handoff).
  attempt(jobA, "t1", "L1", "failed", T0, H, 1000);
  attempt(jobA, "t1", "L2", "succeeded", T0 + 2 * H, H, 3000);
  // t2: Work hits a limit (reassigned), then verifies it the next day.
  attempt(jobA, "t2", "L1", "reassigned", T0 + 3 * H, H / 2, 500);
  attempt(jobA, "t2", "L1", "succeeded", T0 + DAY + H, H, 1500);
  // t3: still running.
  attempt(jobA, "t3", "L2", null, T0 + DAY + 2 * H, 0, 200);
  // Another project's job.
  attempt(jobB, "t4", "L1", "succeeded", T0 + 2 * DAY, H, 9000);
  // The Eye's reasoning for job A: counts in the burn, not in a Leg's attempts.
  db.insert(sessions)
    .values({
      id: "eye",
      attemptId: "eye:plan",
      jobId: jobA,
      legId: "L1",
      legModelId: "L1-m",
      logFile: "/dev/null",
      startedAt: T0,
      inputTokens: 300,
    })
    .run();
});

afterEach(() => closeDatabase(db));

describe("the charts' numbers (Web-UI → Charts)", () => {
  it("counts a job's throughput per day, every day between the first and the last", () => {
    const c = charts(db, { jobId: jobA, bucketMs: DAY }, T0 + 3 * DAY);
    expect(c.throughput).toEqual([
      { t: T0, done: 1, failed: 1 },
      { t: T0 + DAY, done: 1, failed: 0 },
    ]);
    const hourly = charts(db, { jobId: jobA, bucketMs: H }, T0 + 3 * DAY);
    expect(hourly.throughput[0]).toEqual({ t: T0 + H, done: 0, failed: 1 });
    expect(hourly.throughput.at(-1)).toEqual({ t: T0 + DAY + 2 * H, done: 1, failed: 0 });
    // Every hour between, empty ones as 0.
    expect(hourly.throughput).toHaveLength(26);
  });

  it("gives success and failure by Leg, with tokens and time per verified task", () => {
    const now = T0 + DAY + 3 * H;
    const c = charts(db, { jobId: jobA }, now);
    expect(c.byLeg).toEqual([
      {
        legId: "L1",
        leg: "Work",
        kind: "claude-code",
        succeeded: 1,
        failed: 1,
        other: 1,
        tokens: 3000,
        ms: H + H / 2 + H,
        tokensPerVerified: 3000,
        msPerVerified: 2.5 * H,
      },
      {
        legId: "L2",
        leg: "Ollama",
        kind: "openai-compatible",
        succeeded: 1,
        failed: 0,
        other: 0,
        tokens: 3200,
        // The running attempt counts until now.
        ms: H + H,
        tokensPerVerified: 3200,
        msPerVerified: 2 * H,
      },
    ]);
  });

  it("gives success and failure by task kind", () => {
    const c = charts(db, { jobId: jobA });
    expect(c.byKind).toEqual([
      { kind: "code", succeeded: 2, failed: 1, other: 1 },
      { kind: "docs", succeeded: 0, failed: 0, other: 0 },
    ]);
  });

  it("covers a project's jobs, or everything, and only attempts since a time", () => {
    expect(charts(db, { projectId }).byLeg.map((l) => l.leg)).toEqual(["Work", "Ollama"]);
    const all = charts(db, {});
    expect(all.byKind.map((k) => k.kind)).toEqual(["code", "test", "docs"]);
    expect(all.byLeg.find((l) => l.legId === "L1")?.succeeded).toBe(2);
    const recent = charts(db, { since: T0 + DAY });
    expect(recent.byKind).toEqual([
      { kind: "code", succeeded: 1, failed: 0, other: 0 },
      { kind: "test", succeeded: 1, failed: 0, other: 0 },
      { kind: "docs", succeeded: 0, failed: 0, other: 0 },
    ]);
  });

  it("burns a job's tokens against its limit, the Eye's included", () => {
    db.update(jobs)
      .set({
        budget: {
          tokens: { limit: 10_000, hard: true },
          quotaShare: null,
          wallClockMs: null,
          money: { limit: 0, hard: true },
        },
      })
      .where(eq(jobs.id, jobA))
      .run();
    const c = charts(db, { jobId: jobA, bucketMs: DAY });
    expect(c.burn).toEqual({
      limit: 10_000,
      hard: true,
      used: 6500,
      points: [
        { t: T0, used: 4800 },
        { t: T0 + DAY, used: 6500 },
      ],
    });
  });

  it("burns a project's tokens against the project's limit, and none for everything", () => {
    const none = charts(db, { projectId, bucketMs: DAY });
    expect(none.burn?.limit).toBeNull();
    expect(none.burn?.used).toBe(6500);
    db.insert(settings)
      .values({
        key: projectBudgetKey(projectId),
        value: { tokens: { limit: 5000, hard: false }, money: null },
      })
      .run();
    const c = charts(db, { projectId, bucketMs: DAY });
    expect(c.burn).toMatchObject({ limit: 5000, hard: false, used: 6500 });
    expect(charts(db, {}).burn).toBeNull();
  });

  it("counts no money yet, and is empty for a job with no attempts", () => {
    const empty = seedJob(db, "draft");
    const c = charts(db, { jobId: empty });
    expect(c).toMatchObject({
      throughput: [],
      byLeg: [],
      byKind: [],
      money: { total: 0, points: [] },
      burn: { limit: null, used: 0, points: [] },
    });
  });
});
