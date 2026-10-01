import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, type Db, openDatabase } from "../db/open.ts";
import { jobs as jobsTable, tasks } from "../db/schema.ts";
import { EventBus } from "../events/bus.ts";
import { InboxStore } from "../inbox/store.ts";
import { seedJob } from "../testing/fixtures.ts";
import { SideEffects } from "./effects.ts";
import { JobStore } from "./jobs.ts";
import { StepJournal } from "./journal.ts";
import { recover } from "./recovery.ts";
import { DID_NOT_HAPPEN, type JobProgram, JobRunner } from "./runner.ts";

let db: Db;
beforeEach(async () => {
  db = await openDatabase({ file: ":memory:" });
});
afterEach(() => closeDatabase(db));

function engine(program: JobProgram, maxRunning?: number) {
  const bus = new EventBus(db);
  const jobs = new JobStore(db, bus);
  const journal = new StepJournal(db);
  const inbox = new InboxStore(db, bus);
  const effects = new SideEffects(db, bus, inbox);
  const runner = new JobRunner({
    jobs,
    journal,
    effects,
    inbox,
    bus,
    program,
    safePointTimeoutMs: 5000,
    ...(maxRunning ? { maxRunning: () => maxRunning } : {}),
  });
  return { bus, jobs, journal, inbox, effects, runner };
}

const settle = () => new Promise((r) => setTimeout(r, 20));
const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await settle();
  }
};

/** A gate a test opens to let a step finish. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => {
    open = r;
  });
  return { open, opened };
}

describe("steps", () => {
  it("runs each step once, then replays recorded outputs after a pause", async () => {
    const runs: string[] = [];
    const g = gate();
    const program: JobProgram = async (ctx) => {
      if (ctx.state() === "draft") ctx.setState("planning");
      const a = await ctx.step("a", null, async () => {
        runs.push("a");
        return { n: 1 };
      });
      await ctx.step("b", a, async (signal) => {
        runs.push("b");
        await Promise.race([
          g.opened,
          new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
        ]);
        return 2;
      });
      await ctx.step("c", null, async () => {
        runs.push("c");
      });
      ctx.setState("running");
      ctx.setState("verifying");
      ctx.setState("completed");
    };
    const e = engine(program);
    const id = seedJob(db);
    e.runner.start(id);
    await until(() => runs.includes("b"));

    await e.runner.pause(id);
    expect(e.jobs.require(id).state).toBe("paused");
    expect(e.jobs.require(id).resumeState).toBe("planning");

    g.open();
    await e.runner.resume(id);
    await until(() => e.jobs.require(id).state === "completed");
    // a ran once; b was cut short and ran again; c once.
    expect(runs).toEqual(["a", "b", "b", "c"]);
  });

  it("applies a resume sent while a pause is reaching its safe point, and starts nothing once shutting down", async () => {
    let slow = true;
    const e = engine(async (ctx) => {
      if (ctx.state() === "draft") ctx.setState("planning");
      await ctx.step("slow", null, async () => {
        // Reaches its safe point late, ignoring the abort for a moment.
        if (slow) await new Promise((r) => setTimeout(r, 200));
        return 1;
      });
      ctx.setState("running");
      ctx.setState("verifying");
      ctx.setState("completed");
    });
    const id = seedJob(db);
    e.runner.start(id);
    const pausing = e.runner.pause(id);
    slow = false;
    await e.runner.resume(id);
    await pausing;
    await until(() => e.jobs.require(id).state === "completed");

    const other = seedJob(db);
    await e.runner.shutdown();
    expect(() => e.runner.start(other)).toThrow(/stopping/);
  });

  it("queues jobs past the limit and starts them by priority, then age (ADR-016)", async () => {
    const gates = new Map<string, ReturnType<typeof gate>>();
    const order: string[] = [];
    const e = engine(async (ctx) => {
      order.push(ctx.jobId);
      if (ctx.state() === "draft") ctx.setState("planning");
      const g = gate();
      gates.set(ctx.jobId, g);
      await ctx.step("work", null, async () => {
        await g.opened;
        return 1;
      });
      ctx.setState("running");
      ctx.setState("verifying");
      ctx.setState("completed");
    }, 1);
    const [a, b, c] = [seedJob(db), seedJob(db), seedJob(db)];
    e.runner.start(a);
    e.runner.start(b);
    e.runner.start(c);
    await until(() => order.length === 1);
    expect(e.jobs.require(b).queuedAt).toBeTruthy();
    expect(e.jobs.require(c).state).toBe("draft");
    // c goes before b: higher priority.
    db.update(jobsTable).set({ priority: 5 }).where(eq(jobsTable.id, c)).run();
    gates.get(a)?.open();
    await until(() => order.length === 2);
    expect(order).toEqual([a, c]);
    gates.get(c)?.open();
    await until(() => order.length === 3);
    gates.get(b)?.open();
    await until(() => e.jobs.require(b).state === "completed");
    expect(order).toEqual([a, c, b]);
    expect(e.jobs.require(b).queuedAt).toBeNull();
  });

  it("refuses to replay a step with different input", async () => {
    let input = 1;
    const e = engine(async (ctx) => {
      if (ctx.state() === "draft") ctx.setState("planning");
      await ctx.step("x", input, async () => "out");
      if (input === 1) throw new Error("stop here");
    });
    const id = seedJob(db);
    e.runner.start(id);
    await until(() => e.jobs.require(id).state === "blocked");
    input = 2;
    await e.runner.resume(id);
    await until(() => e.jobs.require(id).blockedReason?.includes("different input") ?? false);
  });

  it("blocks a job whose program ends without finishing it, and says why", async () => {
    const e = engine(async (ctx) => {
      ctx.setState("planning");
    });
    const id = seedJob(db);
    e.runner.start(id);
    await until(() => e.jobs.require(id).state === "blocked");
    expect(e.jobs.require(id).blockedReason).toBe("The plan ended without finishing the job.");
  });

  it("blocks a job whose program fails, with the error in plain words", async () => {
    const e = engine(async (ctx) => {
      ctx.setState("planning");
      await ctx.step("x", null, async () => {
        throw new Error("The tests fail the same way after 3 Legs tried.");
      });
    });
    const id = seedJob(db);
    e.runner.start(id);
    await until(() => e.jobs.require(id).state === "blocked");
    expect(e.jobs.require(id).blockedReason).toMatch(/3 Legs tried/);
    expect(e.bus.since(0, [`job:${id}`], 100).map((x) => x.type)).toContain("job.error");
  });

  it("cancels a running job at a safe point", async () => {
    const e = engine(async (ctx) => {
      ctx.setState("planning");
      await ctx.step(
        "forever",
        null,
        (signal) =>
          new Promise((_, rej) => signal.addEventListener("abort", () => rej(signal.reason))),
      );
    });
    const id = seedJob(db);
    e.runner.start(id);
    await settle();
    await e.runner.cancel(id);
    expect(e.jobs.require(id).state).toBe("cancelled");
    expect(e.jobs.require(id).finishedAt).not.toBeNull();
  });
});

describe("side effects", () => {
  const send = (count: { n: number }) => async (key: string) => {
    count.n++;
    return { sentWith: key };
  };

  it("waits for my approval of a gated action, then does it exactly once", async () => {
    const count = { n: 0 };
    const e = engine(async (ctx) => {
      if (ctx.state() === "draft") {
        ctx.setState("planning");
        ctx.setState("running");
      }
      await ctx.effect(
        { key: "push", action: "git.push", payload: { branch: "dev" }, gated: true },
        send(count),
      );
      await ctx.effect(
        { key: "push", action: "git.push", payload: { branch: "dev" }, gated: true },
        send(count),
      );
      ctx.setState("verifying");
      ctx.setState("completed");
    });
    const id = seedJob(db);
    e.runner.start(id);
    await until(() => e.jobs.require(id).state === "waiting");
    expect(count.n).toBe(0);
    const effect = e.effects.get(`${id}:-:push`);
    expect(effect?.state).toBe("intended");
    const item = e.inbox.get(effect?.inboxItemId as string);
    expect(item?.kind).toBe("approval");

    e.inbox.answer(item?.id as string, "Approve");
    await e.runner.resume(id);
    await until(() => e.jobs.require(id).state === "completed");
    expect(count.n).toBe(1);
    expect(e.effects.get(`${id}:-:push`)?.result).toEqual({ sentWith: `${id}:-:push` });
  });

  it("never does a denied action", async () => {
    const count = { n: 0 };
    const e = engine(async (ctx) => {
      if (ctx.state() === "draft") {
        ctx.setState("planning");
        ctx.setState("running");
      }
      await ctx.effect({ key: "deploy", action: "deploy", payload: {}, gated: true }, send(count));
    });
    const id = seedJob(db);
    e.runner.start(id);
    await until(() => e.jobs.require(id).state === "waiting");
    e.inbox.answer(e.effects.get(`${id}:-:deploy`)?.inboxItemId as string, "Deny");
    await e.runner.resume(id);
    await until(() => e.jobs.require(id).state === "blocked");
    expect(count.n).toBe(0);
    expect(e.jobs.require(id).blockedReason).toBe('I denied "deploy".');
  });

  it("checks an action interrupted by a pause instead of repeating it", async () => {
    const count = { n: 0 };
    const g = gate();
    const e = engine(async (ctx) => {
      if (ctx.state() === "draft") {
        ctx.setState("planning");
        ctx.setState("running");
      }
      await ctx.effect(
        { key: "mail", action: "email.send", payload: { to: "a@b.c" } },
        async (_key, signal) => {
          count.n++;
          await Promise.race([
            g.opened,
            new Promise((_, rej) => signal.addEventListener("abort", () => rej(signal.reason))),
          ]);
        },
      );
      ctx.setState("verifying");
      ctx.setState("completed");
    });
    // The outside world says the first attempt went through.
    e.effects.reconciler("email.send", async () => "happened");
    const id = seedJob(db);
    e.runner.start(id);
    await until(() => count.n === 1);
    await e.runner.pause(id);
    await e.runner.resume(id);
    await until(() => e.jobs.require(id).state === "completed");
    expect(count.n).toBe(1);
  });
});

describe("pause from parked states", () => {
  it("pauses a waiting job and resumes it to where it was going", async () => {
    const e = engine(async (ctx) => {
      if (ctx.state() === "draft") {
        ctx.setState("planning");
        ctx.setState("running");
      }
      await ctx.effect({ key: "k", action: "git.push", payload: {}, gated: true }, async () => 1);
      ctx.setState("verifying");
      ctx.setState("completed");
    });
    const id = seedJob(db);
    e.runner.start(id);
    await until(() => e.jobs.require(id).state === "waiting");
    await e.runner.pause(id);
    expect(e.jobs.require(id)).toMatchObject({ state: "paused", resumeState: "running" });
    e.inbox.answer(e.effects.get(`${id}:-:k`)?.inboxItemId as string, "Approve");
    await e.runner.resume(id);
    await until(() => e.jobs.require(id).state === "completed");
  });
});

describe("recovery", () => {
  it("forgets unfinished steps, readies interrupted tasks and asks me about an unknown action", async () => {
    // The state a crash leaves behind.
    const crashed = engine(async () => {});
    const id = seedJob(db, "running");
    crashed.journal.begin(id, "half-done", "h");
    db.insert(tasks)
      .values({
        id: "01J9Z3K8W2Q4V6X8Y0A1B2C3TK",
        jobId: id,
        title: "t",
        instructions: "",
        kind: "implement",
        scope: [],
        verify: [],
        requiredCapabilities: [],
        difficulty: "low",
        state: "running",
        leaseUntil: 123,
      })
      .run();
    crashed.effects.intend(id, { key: "mail", action: "email.send", payload: {} });
    crashed.effects.set(`${id}:-:mail`, "performing");

    const count = { n: 0 };
    const e = engine(async (ctx) => {
      await ctx.effect({ key: "mail", action: "email.send", payload: {} }, async () => {
        count.n++;
      });
      ctx.setState("verifying");
      ctx.setState("completed");
    });
    const summary = await recover({ ...e, db });
    expect(summary).toMatchObject({ unfinishedSteps: 1, tasksReset: 1, effectsNeedingMe: 1 });
    expect(db.select().from(tasks).get()).toMatchObject({ state: "ready", leaseUntil: null });
    expect(e.jobs.require(id).state).toBe("waiting");
    const question = e.inbox.get(e.effects.get(`${id}:-:mail`)?.inboxItemId as string);
    expect(question?.title).toBe('Did "email.send" happen?');

    e.inbox.answer(question?.id as string, DID_NOT_HAPPEN);
    await e.runner.resume(id);
    await until(() => e.jobs.require(id).state === "completed");
    expect(count.n).toBe(1);
    expect(e.bus.since(0, ["overview"], 100).map((x) => x.type)).toContain("system.recovered");
  });

  it("resumes active jobs and leaves paused ones paused", async () => {
    const started: string[] = [];
    const e = engine(async (ctx) => {
      started.push(ctx.jobId);
      ctx.setState("verifying");
      ctx.setState("completed");
    });
    const active = seedJob(db, "running");
    const paused = seedJob(db, "paused");
    const s = await recover({ ...e, db });
    expect(s.jobsResumed).toEqual([active]);
    await until(() => e.jobs.require(active).state === "completed");
    expect(started).toEqual([active]);
    expect(e.jobs.require(paused).state).toBe("paused");
  });
});
