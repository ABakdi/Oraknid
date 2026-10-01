import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobView, WebPlan } from "@oraknid/contracts";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import type { Router } from "../api/router.ts";
import { type Daemon, startDaemon } from "../daemon.ts";
import { jobs, legs } from "../db/schema.ts";
import { resolvePaths } from "../paths.ts";
import { fakeOs } from "../testing/fake-os.ts";
import { type Action, scriptedLeg, type TurnContext } from "../testing/scripted-leg.ts";
import type { EyeBrain } from "./brain.ts";

let daemon: Daemon | undefined;
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
});

const sh = (cwd: string, ...a: string[]) =>
  spawnSync("git", a, { cwd, encoding: "utf8" }).stdout.trim();

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "oraknid-eye-"));
  sh(dir, "init", "-q", "-b", "master");
  sh(dir, "config", "user.email", "me@example.com");
  sh(dir, "config", "user.name", "Me");
  writeFileSync(join(dir, "README.md"), "# demo\n");
  writeFileSync(join(dir, "package.json"), "{}\n");
  sh(dir, "add", ".");
  sh(dir, "commit", "-qm", "start");
  return dir;
}

const HELLO: WebPlan = {
  summary: "A script that says hi, then a test for it.",
  tasks: [
    {
      key: "t1",
      title: "Write hello.sh",
      instructions: "Create hello.sh that prints hi.",
      kind: "implement",
      dependsOn: [],
      scope: ["hello.sh"],
      verify: ["sh hello.sh | grep -qx hi"],
      requiredCapabilities: ["implementation"],
      difficulty: "low",
    },
    {
      key: "t2",
      title: "Test hello.sh",
      instructions: "Create test.sh that checks hello.sh.",
      kind: "test",
      dependsOn: ["t1"],
      scope: ["test.sh"],
      verify: ["sh test.sh"],
      requiredCapabilities: ["tests"],
      difficulty: "low",
    },
  ],
  jobVerify: ["sh test.sh"],
};

const task = (t: TurnContext) => t.system.match(/# Your task: (.*)/)?.[1] ?? "";

/** A coder that does each task right the first time. */
const good = (t: TurnContext): Action[] =>
  task(t) === "Write hello.sh"
    ? [{ write: "hello.sh", content: "echo hi\n" }, { say: "DONE: wrote hello.sh" }]
    : task(t) === "Test hello.sh"
      ? [{ write: "test.sh", content: 'test "$(sh hello.sh)" = hi\n' }, { say: "DONE" }]
      : [{ say: "?" }];

async function eye(
  script: (t: TurnContext) => Action[],
  o: {
    plan?: WebPlan;
    replan?: WebPlan;
    legs?: string[];
    autonomy?: "supervised" | "standard" | "full";
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "oraknid-eyed-"));
  const leg = scriptedLeg(script);
  const plans: string[] = [];
  const brain: EyeBrain = {
    plan: async () => {
      plans.push("plan");
      return o.plan ?? HELLO;
    },
    replan: async () => {
      plans.push("replan");
      if (!o.replan) throw new Error("no replan scripted");
      return o.replan;
    },
    summarize: async () => ({ title: "s", body: "s" }),
  };
  daemon = await startDaemon({
    paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
    port: 0,
    dbFile: ":memory:",
    os: fakeOs({ keychain: true }).os,
    adapters: { "claude-code": leg.adapter },
    brain,
    stallCheckMs: 100,
  });
  const api = createORPCClient<RouterClient<Router>>(new RPCLink({ url: `${daemon.url}/api` }));
  const legIds: string[] = [];
  for (const name of o.legs ?? ["Claude A"])
    legIds.push((await api.legs.create({ kind: "claude-code", name, config: {} })).id);
  const workspace = repo();
  const project = await api.projects.create({ name: "demo", workspacePath: workspace });
  const { id } = await api.jobs.create({
    projectId: project.id,
    goal: "Say hi, with a test",
    verify: [],
    autonomy: o.autonomy ?? "standard",
    inputs: [],
    allowedLegIds: [],
    unsandboxed: false,
  });
  await api.jobs.start({ id });
  return { d: daemon, api, id, workspace, leg, plans, legIds };
}

async function until(
  api: { jobs: { get(i: { id: string }): Promise<JobView> } },
  id: string,
  states: string[],
  ms = 8000,
) {
  const end = Date.now() + ms;
  for (;;) {
    const j = await api.jobs.get({ id });
    if (states.includes(j.state)) return j;
    if (Date.now() > end) throw new Error(`job stayed ${j.state} (${j.blockedReason ?? ""})`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("The Eye, end to end", () => {
  it("plans, runs each task on a Leg, verifies it, commits it, and completes the job", async () => {
    const { api, id, workspace, d } = await eye(good);
    const job = await until(api, id, ["completed", "blocked"]);
    expect(job.state, job.blockedReason ?? "").toBe("completed");
    expect(job.tasks.map((t) => [t.title, t.state])).toEqual([
      ["Write hello.sh", "done"],
      ["Test hello.sh", "done"],
    ]);
    // A worktree on a job branch, with one commit per verified task; my folder is untouched.
    expect(job.worktree).toBe(join(workspace, ".oraknid", "worktrees", id));
    expect(sh(job.worktree as string, "log", "--format=%s", "-2")).toBe(
      "test: test hello.sh\nfeat: write hello.sh",
    );
    expect(existsSync(join(workspace, "hello.sh"))).toBe(false);
    expect(sh(workspace, "status", "--porcelain")).toBe("");
    // Silk remembers the plan and the progress, mirrored in the worktree.
    const silk = await api.silk.list({ jobId: id });
    expect(silk.map((e) => e.title)).toEqual([
      "The plan",
      "Done: Write hello.sh",
      "Done: Test hello.sh",
      "Job verified",
    ]);
    expect(
      readFileSync(join(job.worktree as string, ".oraknid", "silk", "progress.md"), "utf8"),
    ).toContain("Done: Test hello.sh");
    // The router's choice is recorded, and the learning saw two successes.
    const types = d.bus.since(0, [`job:${id}`], 500).map((e) => e.type);
    expect(types).toContain("task.verified");
    expect(d.inhibit).toBeDefined();
  });

  it("sends the exact failure back when verification fails, until the Leg gets it right (self-prompting)", async () => {
    const { api, id, leg } = await eye((t) => {
      if (task(t) === "Write hello.sh" && t.turn === 1)
        return [{ write: "hello.sh", content: "echo hello\n" }, { say: "DONE" }];
      return good(t);
    });
    const job = await until(api, id, ["completed", "blocked"]);
    expect(job.state).toBe("completed");
    const second = leg.log.find((x) => task(x) === "Write hello.sh" && x.turn === 2);
    // It said DONE but the check failed: a false claim (D4), corrected with the exact failure.
    expect(second?.message).toMatch(
      /said it was done, but `sh hello.sh \| grep -qx hi` failed[\s\S]*exit 1/,
    );
    expect(job.tasks[0]?.attemptCount).toBe(1);
  });

  it("reverts an out-of-scope edit, corrects the Leg, and keeps the in-scope work (D1)", async () => {
    const { api, id, leg } = await eye((t) => {
      if (task(t) === "Write hello.sh" && t.turn === 1) {
        return [
          { write: "hello.sh", content: "echo hi\n" },
          { write: "package.json", content: '{"scripts":{}}\n' },
          { say: "DONE" },
        ];
      }
      return good(t);
    });
    const job = await until(api, id, ["completed", "blocked"]);
    expect(job.state).toBe("completed");
    const corrective = leg.log.find((x) => task(x) === "Write hello.sh" && x.turn === 2);
    expect(corrective?.message).toMatch(
      /changed files outside its scope: package.json[\s\S]*Only change files in: hello.sh/,
    );
    expect(readFileSync(join(job.worktree as string, "package.json"), "utf8")).toBe("{}\n");
    expect(sh(job.worktree as string, "show", "--stat", "--format=", "HEAD~1")).not.toContain(
      "package.json",
    );
  });

  it("moves a task to another Leg when one hits its usage limit, and keeps the first one out until it resets", async () => {
    const resetsAt = Date.now() + 3600_000;
    const { api, id, legIds } = await eye(
      (t) =>
        t.leg === "Claude A"
          ? [
              {
                rateLimit: {
                  window: "five_hour",
                  scope: "account",
                  status: "rejected",
                  utilization: 1,
                  resetsAt,
                },
              },
            ]
          : good(t),
      { legs: ["Claude A", "Claude B"] },
    );
    const job = await until(api, id, ["completed", "blocked"]);
    expect(job.state).toBe("completed");
    const a = await api.legs.get({ id: legIds[0] as string });
    expect(a).toMatchObject({ health: "rate-limited", limitedUntil: resetsAt });
    const silk = await api.silk.list({ jobId: id, includeSuperseded: true });
    expect(silk.some((e) => e.kind === "handoff")).toBe(true);
  });

  it("blocks the job until the earliest reset when every Leg is out of quota, then resumes on its own", async () => {
    const resetsAt = Date.now() + 3600_000;
    let limited = true;
    const { api, id, d, legIds } = await eye((t) =>
      limited
        ? [
            {
              rateLimit: {
                window: "five_hour",
                scope: "account",
                status: "rejected",
                utilization: 1,
                resetsAt,
              },
            },
          ]
        : good(t),
    );
    const blocked = await until(api, id, ["blocked", "completed"]);
    expect(blocked.state).toBe("blocked");
    expect(blocked.blockedReason).toMatch(/out of quota until/);
    expect(d.db.select().from(jobs).where(eq(jobs.id, id)).get()?.blockedUntil).toBe(resetsAt);

    // The window resets: the Leg is healthy again and the job resumes.
    limited = false;
    d.db
      .update(legs)
      .set({ health: "healthy", limitedUntil: null, quota: [] })
      .where(eq(legs.id, legIds[0] as string))
      .run();
    await d.runner.resume(id);
    const after = await until(api, id, ["completed", "blocked"]);
    expect(after.state, after.blockedReason ?? "").toBe("completed");
  });

  it("waits for my approval before a gated command, and tells the Leg when I deny it", async () => {
    const { api, id, leg } = await eye((t) =>
      task(t) === "Write hello.sh" && t.turn === 1
        ? [
            { write: "hello.sh", content: "echo hi\n" },
            { run: "git push origin dev" },
            { say: "DONE" },
          ]
        : good(t),
    );
    const end = Date.now() + 5000;
    let item: Awaited<ReturnType<typeof api.inbox.list>>[number] | undefined;
    while (!item && Date.now() < end) {
      item = (await api.inbox.list({ state: "open" }))[0];
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(item?.title).toBe("Claude A wants to run `git push origin dev`");
    expect(item?.detail).toContain("push needs my approval");
    await api.inbox.answer({ id: item?.id as string, answer: "Deny" });
    const job = await until(api, id, ["completed", "blocked"]);
    expect(job.state).toBe("completed");
    void leg;
  });

  it("replans when the job-level check fails, then completes", async () => {
    const plan: WebPlan = {
      ...HELLO,
      tasks: [HELLO.tasks[0] as WebPlan["tasks"][number]],
      jobVerify: ["test -f NOTES.md"],
    };
    const replan: WebPlan = {
      summary: "Add the missing notes.",
      tasks: [
        {
          key: "fix1",
          title: "Write NOTES.md",
          instructions: "Create NOTES.md.",
          kind: "mechanical",
          dependsOn: [],
          scope: ["NOTES.md"],
          verify: ["test -f NOTES.md"],
          requiredCapabilities: ["docs"],
          difficulty: "low",
        },
      ],
      jobVerify: [],
    };
    const { api, id, plans } = await eye(
      (t) =>
        task(t) === "Write NOTES.md"
          ? [{ write: "NOTES.md", content: "notes\n" }, { say: "DONE" }]
          : good(t),
      { plan, replan },
    );
    const job = await until(api, id, ["completed", "blocked"]);
    expect(job.state, job.blockedReason ?? "").toBe("completed");
    expect(plans).toEqual(["plan", "replan"]);
    expect(job.tasks.map((t) => t.title)).toEqual(["Write hello.sh", "Write NOTES.md"]);
    expect((await api.silk.list({ jobId: id })).map((e) => e.title)).toContain("Plan, version 2");
  });

  it("pauses mid-task at a safe point, leaves a handoff, and resumes to completion", async () => {
    let hang = true;
    const { api, id, d } = await eye((t) =>
      task(t) === "Write hello.sh" && hang
        ? [{ write: "hello.sh", content: "echo hi\n" }, { hang: true }]
        : good(t),
    );
    const end = Date.now() + 5000;
    while ((await api.jobs.get({ id })).tasks[0]?.state !== "running" && Date.now() < end)
      await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 100));
    await api.jobs.pause({ id });
    const paused = await api.jobs.get({ id });
    expect(paused).toMatchObject({ state: "paused", pauseReason: "Paused by me." });
    const handoff = (await api.silk.list({ jobId: id })).find((e) => e.kind === "handoff");
    expect(handoff?.body).toContain("## Goal of the task");
    expect(handoff?.body).toContain("hello.sh");

    hang = false;
    await api.jobs.resume({ id });
    const after = await until(api, id, ["completed", "blocked"]);
    expect(after.state, after.blockedReason ?? "").toBe("completed");
    expect(d.bus.since(0, [`job:${id}`], 1000).map((e) => e.type)).toContain("job.pausing");
  });
});

describe("approvals of an attempt that ends", () => {
  it("are withdrawn, so my inbox never holds a question nobody waits for", async () => {
    let hang = true;
    const { api, id } = await eye((t) =>
      task(t) === "Write hello.sh" && hang
        ? [{ write: "hello.sh", content: "echo hi\n" }, { run: "nmap localhost" }]
        : good(t),
    );
    const end = Date.now() + 5000;
    while ((await api.inbox.list({ state: "open" })).length === 0 && Date.now() < end)
      await new Promise((r) => setTimeout(r, 20));
    expect((await api.inbox.list({ state: "open" }))[0]?.title).toMatch(/nmap/);
    await api.jobs.pause({ id });
    expect(await api.inbox.list({ state: "open" })).toEqual([]);
    expect((await api.inbox.list({ state: "withdrawn" }))[0]?.title).toMatch(/nmap/);
    hang = false;
    await api.jobs.resume({ id });
    expect((await until(api, id, ["completed", "blocked"])).state).toBe("completed");
  });
});

describe("after a restart", () => {
  it("withdraws a Leg's permission request left open by the previous run", async () => {
    const { api, id, d } = await eye(good);
    await until(api, id, ["completed"]);
    const stale = d.inbox.open({
      kind: "approval",
      jobId: id,
      raisedBy: { legId: "01J9Z3K8W2Q4V6X8Y0A1B2C3D4" },
      title: "old",
      detail: "",
      options: ["Approve", "Deny"],
    });
    const mine = d.inbox.open({
      kind: "question",
      jobId: id,
      raisedBy: "eye",
      title: "keep",
      detail: "",
      options: [],
    });
    // A fresh program run of the job (as after a restart) cleans up.
    d.db.update(jobs).set({ state: "running" }).where(eq(jobs.id, id)).run();
    d.runner.start(id);
    await until(api, id, ["completed"]);
    expect(d.inbox.get(stale)?.state).toBe("withdrawn");
    expect(d.inbox.get(mine)?.state).toBe("open");
  });
});
