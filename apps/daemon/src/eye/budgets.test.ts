import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { type Daemon, startDaemon } from "../daemon.ts";
import { jobs, sessions } from "../db/schema.ts";
import type { JobRunner } from "../engine/runner.ts";
import { resolvePaths } from "../paths.ts";
import { fakeOs } from "../testing/fake-os.ts";
import { seedJob } from "../testing/fixtures.ts";
import { startBudgetWatch } from "./budgets.ts";

let daemon: Daemon | undefined;
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
});

describe("the budget watch (Audit 1 → D1-04, Q1-24)", () => {
  it("marks a hard limit reached only once the job is paused and asked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oraknid-budget-"));
    daemon = await startDaemon({
      paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
      port: 0,
      dbFile: ":memory:",
      os: fakeOs().os,
      adapters: {},
    });
    const d = daemon;
    const jobId = seedJob(d.db, "running");
    d.db
      .update(jobs)
      .set({
        budget: {
          tokens: { limit: 100, hard: true },
          quotaShare: null,
          wallClockMs: null,
          money: { limit: 0, hard: true },
        },
      })
      .where(eq(jobs.id, jobId))
      .run();
    d.db
      .insert(sessions)
      .values({
        id: "01J9Z3K8W2Q4V6X8Y0A1B2C3S9",
        jobId,
        legId: "l",
        legModelId: "m",
        logFile: "/dev/null",
        startedAt: 0,
        inputTokens: 500,
      })
      .run();
    // The daemon dies while the job pauses: nothing may be marked settled.
    const dying = startBudgetWatch({
      db: d.db,
      bus: d.bus,
      inbox: d.inbox,
      runner: {
        pause: async () => {
          throw new Error("killed");
        },
      } as unknown as JobRunner,
      now: Date.now,
      intervalMs: 3_600_000,
    });
    await expect(dying.check(jobId)).rejects.toThrow("killed");
    dying.stop();
    expect(d.db.select().from(jobs).where(eq(jobs.id, jobId)).get()?.budgetFlags).toEqual([]);
    // After the restart, the next check pauses and asks.
    const paused: string[] = [];
    const watch = startBudgetWatch({
      db: d.db,
      bus: d.bus,
      inbox: d.inbox,
      runner: { pause: async (id: string) => void paused.push(id) } as unknown as JobRunner,
      now: Date.now,
      intervalMs: 3_600_000,
    });
    await watch.check(jobId);
    watch.stop();
    expect(paused).toEqual([jobId]);
    const job = d.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    expect(job?.budgetFlags).toEqual(["tokens:reached"]);
    expect(job?.budgetQuestion).toMatch(/:tokens$/);
    expect(d.inbox.list({ jobId, state: "open" }).map((i) => i.title)).toEqual([
      'Raise the tokens budget of "t"?',
    ]);
  });
});
