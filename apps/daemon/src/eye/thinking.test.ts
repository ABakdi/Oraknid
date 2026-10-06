import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event, EyeThought } from "@oraknid/contracts";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { type Daemon, startDaemon } from "../daemon.ts";
import { sessions, steps } from "../db/schema.ts";
import type { JobProgram } from "../engine/runner.ts";
import { readSessionLog } from "../legs/session-log.ts";
import { resolvePaths } from "../paths.ts";
import { fakeOs } from "../testing/fake-os.ts";
import { seedJob } from "../testing/fixtures.ts";
import { type Action, scriptedLeg, type TurnContext } from "../testing/scripted-leg.ts";
import { PoolLegBrain } from "./brain.ts";
import { conversation, stopThinking, type TalkDeps, talk } from "./talk.ts";

// M13.25: The Eye thinks out loud, and I can step in.

let daemon: Daemon | undefined;
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
});

const task = {
  key: "t1",
  title: "Set up the database",
  instructions: "x",
  kind: "implement",
  dependsOn: [],
  scope: ["a"],
  verify: ["true"],
  requiredCapabilities: ["implementation"],
  difficulty: "low",
};
const PLAN = `\`\`\`json\n${JSON.stringify({ summary: "s", tasks: [task], jobVerify: [] })}\n\`\`\``;
const TRIAGE = `\`\`\`json\n${JSON.stringify({ intent: "context", reply: "Noted.", silk: { kind: "fact", title: "Dark mode", body: "also add dark mode" } })}\n\`\`\``;

const until = async (ok: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** A daemon with its database in a file backs it up as it starts: closed only once that is done. */
const backedUp = (dir: string, n: number) =>
  until(() => {
    const folder = resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }).backups;
    return (
      existsSync(folder) &&
      readdirSync(folder).filter((f) => f.startsWith("nightly-") && f.endsWith(".db")).length >= n
    );
  }, 15_000);

/** A daemon with a scripted Claude, The Eye's brain on it showing its thoughts. */
async function harness(
  script: (t: TurnContext) => Action[],
  o: { dir?: string; program?: JobProgram } = {},
) {
  const leg = scriptedLeg(script);
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), "oraknid-think-"));
  daemon = await startDaemon({
    paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
    port: 0,
    dbFile: o.program ? join(dir, "oraknid.db") : ":memory:",
    os: fakeOs({ keychain: true }).os,
    adapters: { "claude-code": leg.adapter },
    ...(o.program ? { program: o.program } : {}),
  });
  if (!daemon.registry.all().length)
    await daemon.registry.create({
      kind: "claude-code",
      name: "Claude",
      config: { binary: "claude" },
    });
  await daemon.health.checkAll();
  const d = daemon;
  const brain = new PoolLegBrain({
    registry: d.registry,
    supervisor: d.supervisor,
    pinnedModelId: () => null,
    thinking: d.thinking,
  });
  const seen: Event[] = [];
  d.bus.subscribe((e) => seen.push(e));
  const deps: TalkDeps = {
    db: d.db,
    bus: d.bus,
    silk: d.silk,
    runner: d.runner,
    brain,
    tmpDir: dir,
    inbox: d.inbox,
    thinking: d.thinking,
  };
  const input = (jobId: string) => ({
    jobId,
    cwd: dir,
    goal: "A notes app",
    skill: "",
    silk: "",
    digest: "",
    verify: [],
  });
  return { d, brain, seen, deps, input, log: leg.log, dir };
}

const thoughts = (seen: Event[], type: string) =>
  seen.filter((e) => e.type === type).map((e) => e.payload as EyeThought);

describe("The Eye thinking out loud (M13.25)", () => {
  it("streams what a call thinks into the job's conversation, then ends with what came of it", async () => {
    const { d, brain, seen, input } = await harness(() => [
      { think: "The goal needs storage first. " },
      { say: PLAN },
    ]);
    const jobId = seedJob(d.db, "planning");
    const plan = await brain.plan(input(jobId));
    expect(plan.tasks).toHaveLength(1);

    const [started] = thoughts(seen, "eye.thinking.started");
    expect(started).toMatchObject({
      jobId,
      call: "plan",
      purpose: "Planning the work",
      model: "Claude · opus",
      outcome: "thinking",
      interruptible: true,
    });
    const id = started?.id as string;
    // On the job's topic, what it thinks and writes as it comes, named by its session.
    const streamed = seen.filter(
      (e) => e.topic === `job:${jobId}` && (e.payload as { sessionId?: string })?.sessionId === id,
    );
    expect(streamed.map((e) => e.type)).toEqual(
      expect.arrayContaining(["session.started", "session.thinking", "session.text"]),
    );
    expect(streamed.find((e) => e.type === "session.thinking")?.payload).toMatchObject({
      text: "The goal needs storage first. ",
    });
    const [ended] = thoughts(seen, "eye.thinking.ended");
    expect(ended).toMatchObject({ id, outcome: "done", summary: "Planned 1 task" });
    expect(ended?.endedAt).toBeGreaterThanOrEqual(started?.startedAt ?? 0);
    expect(seen.findIndex((e) => e.type === "eye.thinking.ended")).toBeGreaterThan(
      seen.findIndex((e) => e.type === "session.text"),
    );

    // Its log reads as reasoning, then the answer; the conversation lists it, folded.
    const row = d.db.select().from(sessions).where(eq(sessions.id, id)).get();
    const entries = readSessionLog(row?.logFile ?? "").entries;
    expect(entries.map((x) => x.kind).slice(0, 2)).toEqual(["thinking", "text"]);
    expect(d.thinking.list([jobId])).toEqual([
      expect.objectContaining({ id, outcome: "done", summary: "Planned 1 task" }),
    ]);
  });

  it("stops and thinks again with my correction: the Leg session ended, my words in the new prompt", async () => {
    const { d, brain, seen, deps, input, log } = await harness((t) =>
      t.message.includes("Plan this job")
        ? t.session === 1
          ? [{ hang: true }]
          : [{ say: PLAN }]
        : [{ say: TRIAGE }],
    );
    const jobId = seedJob(d.db, "planning");
    const planned = brain.plan(input(jobId));
    await until(() => d.thinking.running([jobId]).length === 1);
    const first = d.thinking.running([jobId])[0] as EyeThought;

    // "no, use Postgres" corrects what it thinks: stop and redo, by default.
    talk(deps, jobId, "no, use Postgres", {}, "auto");
    const plan = await planned;
    expect(plan.tasks).toHaveLength(1);
    const rows = d.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.jobId, jobId), eq(sessions.attemptId, "eye:plan")))
      .all();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === first.id)?.endReason).toBe("stopped");
    const second = log.filter((t) => t.message.includes("Plan this job")).at(-1);
    expect(second?.session).toBe(2);
    expect(second?.message).toContain("What the owner said while you were thinking");
    expect(second?.message).toContain('"no, use Postgres"');

    expect(thoughts(seen, "eye.thinking.ended").map((t) => [t.outcome, t.again])).toEqual([
      ["redone", false],
      ["done", true],
    ]);
    expect(thoughts(seen, "eye.thinking.started")[1]?.purpose).toBe(
      "Planning the work again, with what you said",
    );
    // Kept as my decision, said in the conversation; my message isn't read again as a new one.
    expect(d.silk.current(jobId).some((e) => e.title === "My correction: no, use Postgres")).toBe(
      true,
    );
    const said = conversation(d.db, jobId);
    expect(said.map((m) => m.author)).toEqual(["owner", "eye"]);
    expect(said[1]?.text).toBe("Stopped planning the work: thinking again with what you said.");
    expect(said[1]?.action?.did).toContain("Thinking again with your message");
    expect(log.filter((t) => t.message.includes("Decide what the message is"))).toHaveLength(0);
  });

  it("adds a message that doesn't correct it as context: nothing stopped, the next call reads it", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { d, brain, seen, deps, input, log } = await harness((t) =>
      t.message.includes("Plan this job") ? [{ say: PLAN }] : [{ say: TRIAGE }],
    );
    const jobId = seedJob(d.db, "planning");
    // A call held open: the triage of a message of mine before.
    const held = d.thinking.begin({ id: "held", jobId, call: "plan", model: "Claude · opus" });
    void gate.then(() => d.thinking.end(held, "done", "Planned 1 task"));

    talk(deps, jobId, "also add dark mode", {}, "auto");
    expect(held.interruption).toBeNull();
    await until(() => conversation(d.db, jobId).length === 2);
    expect(conversation(d.db, jobId)[1]?.text).toBe("Noted.");
    (release as unknown as () => void)();
    await until(() => d.thinking.running([jobId]).length === 0);
    expect(thoughts(seen, "eye.thinking.ended").find((t) => t.id === "held")?.outcome).toBe("done");

    // The next call that plans reads it.
    await brain.plan(input(jobId));
    const prompt = log.filter((t) => t.message.includes("Plan this job")).at(-1)?.message;
    expect(prompt).toContain('"also add dark mode"');
    // Once: the call after that doesn't read it again.
    await brain.plan(input(jobId));
    expect(log.filter((t) => t.message.includes("Plan this job")).at(-1)?.message).not.toContain(
      "also add dark mode",
    );
  });

  it("asked to redo with nothing thinking, reads the message as any other", async () => {
    const { d, deps, log } = await harness(() => [{ say: TRIAGE }]);
    const jobId = seedJob(d.db, "running");
    talk(deps, jobId, "no, use Postgres", {}, "redo");
    await until(() => conversation(d.db, jobId).length === 2);
    expect(conversation(d.db, jobId)[1]?.text).toBe("Noted.");
    expect(log).toHaveLength(1);
  });

  it("Stop pauses a job mid-plan; the plan isn't recorded, and after a restart it is thought again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oraknid-think-crash-"));
    let brain: PoolLegBrain | undefined;
    let input: ((jobId: string) => Parameters<PoolLegBrain["plan"]>[0]) | undefined;
    const program: JobProgram = async (ctx) => {
      const plan = await ctx.step("plan", { goal: "g" }, () =>
        (brain as PoolLegBrain).plan(
          (input as (j: string) => Parameters<PoolLegBrain["plan"]>[0])(ctx.jobId),
        ),
      );
      if (!plan.tasks.length) throw new Error("no plan");
      ctx.setState("verifying");
      ctx.setState("completed");
    };
    const first = await harness((t) => (t.session === 1 ? [{ hang: true }] : [{ say: PLAN }]), {
      dir,
      program,
    });
    brain = first.brain;
    input = first.input;
    const jobId = seedJob(first.d.db, "running");
    first.d.runner.start(jobId);
    await until(() => first.d.thinking.running([jobId]).length === 1);
    const stopped = first.d.thinking.running([jobId])[0] as EyeThought;

    expect(stopThinking(first.deps, [jobId])).toBe(1);
    await until(() => first.d.jobs.require(jobId).state === "paused");
    const step = () =>
      first.d.db
        .select()
        .from(steps)
        .where(and(eq(steps.jobId, jobId), eq(steps.stepKey, "plan")))
        .get();
    expect(step()?.status).not.toBe("done");
    expect(
      first.d.db.select().from(sessions).where(eq(sessions.id, stopped.id)).get()?.endReason,
    ).toBe("stopped");
    expect(conversation(first.d.db, jobId).at(-1)?.text).toContain(
      "Stopped planning the work, as you asked. The job is paused",
    );
    expect(first.d.thinking.list([jobId]).map((t) => t.outcome)).toEqual(["stopped"]);

    // Oraknid stops and starts again: resuming thinks the plan again, once.
    await backedUp(dir, 1);
    await first.d.close();
    daemon = undefined;
    const again = await harness(() => [{ say: PLAN }], { dir, program });
    brain = again.brain;
    input = again.input;
    expect(again.d.thinking.list([jobId]).map((t) => t.outcome)).toEqual(["stopped"]);
    await again.d.runner.resume(jobId);
    await until(() => again.d.jobs.require(jobId).state === "completed");
    expect(
      again.d.db
        .select()
        .from(steps)
        .where(and(eq(steps.jobId, jobId), eq(steps.stepKey, "plan")))
        .get()?.status,
    ).toBe("done");
    expect(
      again.d.thinking
        .list([jobId])
        .filter((t) => t.call === "plan")
        .map((t) => t.outcome),
    ).toEqual(["stopped", "done"]);
    await backedUp(dir, 1);
  });
});
