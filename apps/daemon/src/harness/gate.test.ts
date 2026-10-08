import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Autonomy } from "@oraknid/contracts";
import { asRequest, type PermissionRequest } from "@oraknid/leg-sdk";
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
import { AttemptLog } from "./log.ts";

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
  const forbidden: string[] = [];
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
        forbidden: (what) => forbidden.push(what),
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
  return { db, inbox, jobId: jobId as string, cwd, events, forbidden, stop, gate, item };
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

  it("counts my denials too: three in a row and I'm asked at the agent's next action (stage 2)", async () => {
    const s = await setup({ autonomy: "careful" });
    const gate = s.gate();
    for (const branch of ["a", "b", "c"]) {
      const asking = gate.decide({ source: "prompt", request: bash(`git push origin ${branch}`) });
      s.inbox.answer((await s.item(/wants to run `git push/)).id, "Deny");
      expect(asPermission(await asking).allow).toBe(false);
    }
    const next = gate.decide({ source: "prompt", request: write(join(s.cwd, "parser.js")) });
    const stuck = await s.item(/is stuck on blocked actions/);
    expect(stuck.detail).toContain("- `git push origin c` — denied (you)");
    s.inbox.answer(stuck.id, KEEP_BLOCKED);
    expect(asPermission(await next).allow).toBe(false);
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

describe("an action that ran ends the stuck row, whoever let it run (stage 3)", () => {
  it("ends the row when Claude Code's classifier let the hook's action run: its result says it ran", async () => {
    const s = await setup();
    const gate = s.gate();
    for (const p of ["/etc/a", "/etc/b"]) await gate.decide({ source: "hook", request: write(p) });
    // The hook has no opinion; Claude Code's own classifier lets it run and its result comes back.
    expect(
      asPreTool(await gate.decide({ source: "hook", request: bash("npm install left-pad") })),
    ).toBeNull();
    gate.ran("toolu_1", true);
    expect(
      asPreTool(await gate.decide({ source: "hook", request: write("/etc/c") })),
    ).toMatchObject({ decision: "deny" });
    // One block in the row, not three: nothing to ask.
    expect(gate.takeStuck()).toBeNull();
  });

  it("reads the row from the log after a restart: what ran ended it", async () => {
    const s = await setup();
    const gate = s.gate();
    await gate.decide({ source: "hook", request: write("/etc/a") });
    await gate.decide({ source: "hook", request: bash("npm install left-pad") });
    gate.ran("toolu_1", true);
    // A result that failed (a refusal, a command that failed) says nothing of the row.
    gate.ran("toolu_2", false);
    await gate.decide({ source: "hook", request: write("/etc/b") });
    expect(readTaskMemory(s.db, "task-1").stuck?.row.map((b) => b.action)).toEqual(["Write"]);
    expect(readTaskMemory(s.db, "task-1").stuck?.total).toHaveLength(2);
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

  it("refuses again only the tool call I refused, not every call of that tool (stage 2)", async () => {
    const s = await setup();
    const gate = s.gate();
    const send = (to: string): PermissionRequest => ({
      tool: "mcp__mail__send_message",
      input: { to, body: "hello" },
      command: null,
      path: null,
    });
    const first = gate.decide({ source: "mcp", request: send("a@example.com") });
    s.inbox.answer((await s.item(/wants to use mcp__mail__send_message/)).id, "Deny");
    expect(asPermission(await first).allow).toBe(false);
    // The same call again: refused at once (D8).
    expect(await gate.decide({ source: "mcp", request: send("a@example.com") })).toMatchObject({
      verdict: "deny",
      message: "I already refused that.",
    });
    // Another: asked, as any new request is.
    const other = gate.decide({ source: "mcp", request: send("b@example.com") });
    const asked = await s.item(/wants to use mcp__mail__send_message/);
    s.inbox.answer(asked.id, "Approve");
    expect(asPermission(await other)).toEqual({ allow: true });
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

describe("a Leg without an inline gate: its actions audited after the fact (ADR-056 §2, stage 5)", () => {
  it("reads what it ran by the same rules, logs it, and feeds what they refuse to drift (D7)", async () => {
    const s = await setup();
    const gate = s.gate();
    // Antigravity's own names, read through the Leg SDK.
    const ran = asRequest("run_command", { CommandLine: "sudo rm -rf /etc/nginx" });
    expect(await gate.afterTheFact(ran)).toBe("forbidden");
    expect(s.forbidden).toHaveLength(1);
    expect(s.forbidden[0]).toMatch(/sudo rm -rf \/etc\/nginx/);
    expect(s.events.some((e) => e.type === "task.audited")).toBe(true);
    // A write in its folder: allowed by the rules, logged, nothing for drift.
    const wrote = asRequest("write_to_file", { TargetFile: join(s.cwd, "parser.js") });
    expect(await gate.afterTheFact(wrote)).toBe("allow");
    expect(s.forbidden).toHaveLength(1);
    // A read isn't audited; nor what the Gate decided before it ran; nor the same action twice.
    expect(await gate.afterTheFact(asRequest("view_file", { AbsolutePath: "/etc/hosts" }))).toBe(
      null,
    );
    await gate.decide({ source: "prompt", request: bash("ls") });
    expect(await gate.afterTheFact(asRequest("run_command", { CommandLine: "ls" }))).toBe(null);
    expect(await gate.afterTheFact(ran)).toBe(null);
    const logged = new AttemptLog(s.db)
      .task("task-1", { kinds: ["GateDecision"] })
      .filter((e) => e.data.source === "audit");
    expect(logged.map((e) => [e.data.verdict, e.data.by])).toEqual([
      ["deny", "rule"],
      ["allow", "rule"],
    ]);
    // Never counted toward the stuck rule, never asked.
    expect(logged.every((e) => e.data.counts === undefined)).toBe(true);
    expect(s.inbox.list({ jobId: s.jobId, state: "open" })).toEqual([]);
  });
});
