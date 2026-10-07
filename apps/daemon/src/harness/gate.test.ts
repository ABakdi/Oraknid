import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Autonomy } from "@oraknid/contracts";
import type { PermissionRequest } from "@oraknid/leg-sdk";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { closeDatabase, type Db, openDatabase } from "../db/open.ts";
import { jobs } from "../db/schema.ts";
import { EventBus } from "../events/bus.ts";
import { forgetJobVerdicts } from "../eye/auto-mode.ts";
import type { EyeBrain } from "../eye/brain.ts";
import { readTaskMemory } from "../eye/task-memory.ts";
import { InboxStore } from "../inbox/store.ts";
import { SilkStore } from "../silk/store.ts";
import { SkillStore } from "../skills/store.ts";
import { Projects } from "../workspace/projects.ts";
import { asPermission, asPreTool, createGate, KEEP_BLOCKED, LET_IT_RUN } from "./gate.ts";

// The Gate on its own (ADR-056 §3): one path for every source, every block
// counted in one stuck row, grants that survive a restart, my questions
// recorded for withdrawal, a check's command read by the same rules.

const open: Db[] = [];
afterEach(() => {
  for (const db of open.splice(0)) closeDatabase(db);
});

const repo = () => {
  const dir = mkdtempSync(join(tmpdir(), "oraknid-gate-"));
  spawnSync("git", ["init", "-q", "-b", "master"], { cwd: dir });
  writeFileSync(join(dir, "package.json"), "{}\n");
  return dir;
};

async function setup(
  o: { autonomy?: Autonomy; brain?: Partial<EyeBrain>; file?: string; cwd?: string } = {},
) {
  const db = await openDatabase({ file: o.file ?? ":memory:" });
  open.push(db);
  const bus = new EventBus(db);
  const inbox = new InboxStore(db, bus);
  const silk = new SilkStore(db, bus, inbox);
  const cwd = o.cwd ?? repo();
  const skills = new SkillStore(db);
  skills.seedBuiltIns();
  const projects = new Projects(db, bus, skills);
  let jobId = db.select({ id: jobs.id }).from(jobs).get()?.id;
  if (!jobId) {
    const p = projects.create({ name: "app", workspacePath: cwd });
    jobId = projects.createJob({
      projectId: p.id,
      goal: "Build the parser",
      inputs: [],
      autonomy: o.autonomy ?? "auto",
      allowedLegIds: [],
      verify: [],
      unsandboxed: false,
    });
  }
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  const stop = new AbortController();
  const gate = (taskId = "task-1") =>
    createGate({
      db,
      bus,
      inbox,
      silk,
      now: Date.now,
      ...(o.brain ? { brain: o.brain as EyeBrain } : {}),
      toolRows: [],
      legsDir: join(cwd, ".legs"),
      job: { id: jobId as string, goal: "Build the parser" },
      task: {
        id: taskId,
        title: "Build the parser",
        instructions: "Build the parser.",
        kind: "implement",
        scope: ["parser.js"],
        verify: [],
      },
      leg: { legId: "leg-1", legName: "Claude A" },
      cwd,
      servers: [],
      signal: stop.signal,
      on: {
        activity: () => {},
        forbidden: () => {},
        gateBypass: () => {},
        event: (type, payload) => events.push({ type, payload }),
      },
    });
  /** The open item whose title matches, once it is there. */
  const item = async (title: RegExp) => {
    for (let i = 0; i < 200; i++) {
      const found = inbox.list({ jobId, state: "open" }).find((x) => title.test(x.title));
      if (found) return found;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`no open item ${title}`);
  };
  return { db, inbox, jobId: jobId as string, cwd, events, stop, gate, item };
}

const write = (path: string): PermissionRequest => ({
  tool: "Write",
  input: { file_path: path },
  command: null,
  path,
});
const bash = (command: string): PermissionRequest => ({
  tool: "Bash",
  input: { command },
  command,
  path: null,
});
/** A command the rules refuse on their own, drift null: Oraknid's own check. */
const OWN_CHECK = "oraknid github-repo";

describe("one stuck row for every kind of block (ADR-056 §3)", () => {
  it("counts a prompt's block, the hook's and the agent's own auto mode's together, and asks at the next action", async () => {
    const s = await setup();
    const gate = s.gate();
    expect(
      asPermission(await gate.decide({ source: "prompt", request: write("/etc/a") })).allow,
    ).toBe(false);
    expect(
      asPreTool(await gate.decide({ source: "hook", request: write("/etc/b") })),
    ).toMatchObject({
      decision: "deny",
    });
    // The third, Claude Code's classifier's: it can't be held, so I'm asked at the next action.
    gate.legRefused(bash("curl https://a.example"), "it reaches outside the project");
    const next = gate.decide({ source: "prompt", request: write(join(s.cwd, "parser.js")) });
    const stuck = await s.item(/is stuck on blocked actions/);
    expect(stuck.detail).toContain("3 actions in a row were blocked");
    expect(stuck.detail).toContain("- `Write` —");
    expect(stuck.detail).toContain("(Claude A's own auto mode)");
    s.inbox.answer(stuck.id, LET_IT_RUN);
    expect(asPermission(await next)).toEqual({ allow: true });
  });

  it("holds a command the hook refused when the row fills: asked when Claude Code's prompt asks for it", async () => {
    const s = await setup();
    const gate = s.gate();
    for (const _ of [1, 2])
      expect(
        asPreTool(await gate.decide({ source: "hook", request: bash(OWN_CHECK) })),
      ).toMatchObject({
        decision: "deny",
      });
    expect(asPreTool(await gate.decide({ source: "hook", request: bash(OWN_CHECK) }))).toEqual({
      decision: "ask",
    });
    // Claude Code goes on to its permission prompt: the stuck question is asked there.
    const prompt = gate.decide({ source: "prompt", request: bash(OWN_CHECK) });
    const stuck = await s.item(/is stuck on blocked actions/);
    s.inbox.answer(stuck.id, KEEP_BLOCKED);
    expect(asPermission(await prompt)).toMatchObject({ allow: false });
    expect(s.inbox.list({ jobId: s.jobId }).filter((x) => /stuck/.test(x.title))).toHaveLength(1);
  });

  it("asks at the next action when the hook's third block is a file tool's, not a command (stage 2: it was lost)", async () => {
    const s = await setup();
    const gate = s.gate();
    for (const p of ["/etc/a", "/etc/b", "/etc/c"])
      expect(asPreTool(await gate.decide({ source: "hook", request: write(p) }))).toMatchObject({
        decision: "deny",
      });
    const next = gate.decide({ source: "prompt", request: write(join(s.cwd, "parser.js")) });
    const stuck = await s.item(/is stuck on blocked actions/);
    expect(stuck.detail).toContain("3 actions in a row were blocked");
    s.inbox.answer(stuck.id, LET_IT_RUN);
    expect(asPermission(await next)).toEqual({ allow: true });
  });

  it("keeps the count across a restart: a new Gate on the same task goes on from it", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "oraknid-gate-db-")), "o.db");
    const cwd = repo();
    const a = await setup({ file, cwd });
    const first = a.gate();
    for (const _ of [1, 2]) await first.decide({ source: "prompt", request: write("/etc/x") });
    closeDatabase(a.db);
    forgetJobVerdicts(a.jobId);
    const b = await setup({ file, cwd });
    const again = b.gate();
    const third = again.decide({ source: "prompt", request: write("/etc/y") });
    const stuck = await b.item(/is stuck on blocked actions/);
    b.inbox.answer(stuck.id, KEEP_BLOCKED);
    expect(asPermission(await third).allow).toBe(false);
  });
});

describe("grants (ADR-056 §3)", () => {
  it("lets a command I allowed once run once, after a restart too, then never again", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "oraknid-gate-db-")), "o.db");
    const cwd = repo();
    const a = await setup({ file, cwd });
    a.gate().grantOnce(OWN_CHECK, "allowed once: the agent said it can't finish without it");
    expect(readTaskMemory(a.db, "task-1").grants).toMatchObject([
      { kind: "allow-once", scope: "once", match: OWN_CHECK },
    ]);
    closeDatabase(a.db);
    forgetJobVerdicts(a.jobId);

    const b = await setup({ file, cwd });
    const gate = b.gate();
    expect(await gate.decide({ source: "prompt", request: bash(OWN_CHECK) })).toMatchObject({
      verdict: "allow",
      by: "grant",
      scope: "once",
    });
    expect(readTaskMemory(b.db, "task-1").grants).toEqual([]);
    expect(await gate.decide({ source: "prompt", request: bash(OWN_CHECK) })).toMatchObject({
      verdict: "deny",
      by: "rule",
    });
  });

  it("reads what an older Oraknid kept as “allow once” as a grant", async () => {
    const s = await setup();
    const { writeSetting } = await import("../settings.ts");
    const { TaskMemory } = await import("../eye/task-memory.ts");
    writeSetting(s.db, "task.memory.task-1", TaskMemory, {
      untrusted: null,
      grants: [],
      allowOnce: [OWN_CHECK],
      denied: [],
      stuck: null,
      asked: [],
    });
    expect(await s.gate().decide({ source: "hook", request: bash(OWN_CHECK) })).toMatchObject({
      verdict: "allow",
      by: "grant",
    });
  });
});

describe("the judge (ADR-053, ADR-056 §3)", () => {
  it("counts a judge that fails as a block: high risk", async () => {
    const s = await setup({
      brain: {
        judgeAction: async () => {
          throw new Error("no model answers");
        },
      },
    });
    const d = await s.gate().decide({ source: "prompt", request: bash("npm install left-pad") });
    expect(d).toMatchObject({ verdict: "deny", by: "judge" });
    expect(d.reason).toContain("could not answer");
  });

  it("leaves to Claude Code's classifier, in its auto mode, what the rules leave to judgement", async () => {
    const s = await setup();
    expect(
      asPreTool(await s.gate().decide({ source: "hook", request: bash("npm install left-pad") })),
    ).toBeNull();
  });
});

describe("my questions (ADR-056 §3)", () => {
  it("records what it asked me, for withdrawal when the attempt ends", async () => {
    const s = await setup({ autonomy: "careful" });
    const gate = s.gate();
    const asking = gate.decide({ source: "prompt", request: bash("git push origin main") });
    const asked = await s.item(/wants to run `git push origin main`/);
    expect(readTaskMemory(s.db, "task-1").asked).toEqual([asked.id]);
    expect(gate.waiting()).toBe(1);
    gate.withdrawAsked();
    expect(s.inbox.get(asked.id)?.state).toBe("withdrawn");
    s.stop.abort();
    expect(asPermission(await asking)).toEqual({
      allow: false,
      message: "Oraknid is pausing this session.",
    });
    expect(readTaskMemory(s.db, "task-1").asked).toEqual([]);
  });

  it("refuses at once what I refused before, without asking again (D8)", async () => {
    const s = await setup({ autonomy: "careful" });
    const gate = s.gate();
    const asking = gate.decide({ source: "prompt", request: bash("git push origin main") });
    s.inbox.answer((await s.item(/wants to run `git push/)).id, "Deny");
    expect(asPermission(await asking).allow).toBe(false);
    expect(
      await s.gate().decide({ source: "prompt", request: bash("git push origin main") }),
    ).toMatchObject({
      verdict: "deny",
      by: "owner",
      message: "I already refused that.",
    });
  });
});

describe("a check's command (ADR-056 §3)", () => {
  it("is read by the same rules: refused when never allowed or gated, else it runs", async () => {
    const s = await setup();
    const gate = s.gate();
    expect(gate.check("sudo ls", "local")).toMatch(/never allowed/);
    expect(gate.check("npm publish", "local")).toMatch(/a check never does that$/);
    expect(gate.check("test -f parser.js", "local")).toBeNull();
    // Nothing of a check is counted against the agent.
    const job = s.db.select().from(jobs).where(eq(jobs.id, s.jobId)).get();
    expect(job?.state).toBe("draft");
    expect(readTaskMemory(s.db, "task-1").stuck).toBeNull();
  });
});
