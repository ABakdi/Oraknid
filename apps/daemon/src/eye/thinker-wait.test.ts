import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, type Db, openDatabase } from "../db/open.ts";
import { JobStore } from "../engine/jobs.ts";
import { EventBus } from "../events/bus.ts";
import { seedJob } from "../testing/fixtures.ts";
import { watchForThinker } from "./thinker-wait.ts";

// A job blocked only because no model could think for The Eye (the Keys job,
// 2026-10-13) waits for one with a time when a reset is known, and goes on by
// itself once one can think. A stand-in brain; never a real agent.

let db: Db;
beforeEach(async () => {
  db = await openDatabase({ file: ":memory:" });
});
afterEach(() => closeDatabase(db));

const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

const NO_THINKER =
  "No Leg can think for The Eye right now: every agent that can think is paused or out of quota (Codex is out of quota). It goes on when a limit resets.";

describe("a job blocked for no thinker", () => {
  it("waits until the known reset, then goes on by itself once a model can think", async () => {
    const bus = new EventBus(db);
    const jobs = new JobStore(db, bus);
    const reset = Date.now() + 3_600_000;
    let thinker = { free: false, until: reset as number | null };
    const resumed: string[] = [];
    const auto: unknown[] = [];
    bus.subscribe((e) => {
      if (e.type === "job.auto-resumed") auto.push(e.payload);
    });
    const stop = watchForThinker({
      db,
      bus,
      runner: { resume: async (id: string) => void resumed.push(id) },
      brain: { thinkerFree: () => thinker },
      intervalMs: 20,
    });
    try {
      const id = seedJob(db, "verifying");
      jobs.transition(id, "blocked", NO_THINKER);
      // A wait with its time, as for quota.
      expect(jobs.require(id).blockedUntil).toBe(reset);
      // Another blocked job, for something else, is left alone.
      const other = seedJob(db, "running");
      jobs.transition(other, "blocked", '"Build it" failed 8 attempts. Look at it, then resume.');
      await new Promise((r) => setTimeout(r, 60));
      expect(resumed).toEqual([]);
      // A Leg unpaused: it goes on, said so.
      thinker = { free: true, until: null };
      await until(() => resumed.length > 0);
      expect(resumed).toEqual([id]);
      expect(jobs.require(id).blockedUntil).toBeNull();
      await until(() => auto.length > 0);
      expect(auto[0]).toEqual({
        reason: "An agent can think for The Eye again; it goes on by itself.",
      });
    } finally {
      stop();
    }
  });

  it("is a plain block with no time when nothing will free up by itself", async () => {
    const bus = new EventBus(db);
    const jobs = new JobStore(db, bus);
    const stop = watchForThinker({
      db,
      bus,
      runner: { resume: async () => {} },
      brain: { thinkerFree: () => ({ free: false, until: null }) },
      intervalMs: 20,
    });
    try {
      const id = seedJob(db, "planning");
      jobs.transition(id, "blocked", NO_THINKER);
      expect(jobs.require(id).blockedUntil).toBeNull();
    } finally {
      stop();
    }
  });
});
