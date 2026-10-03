import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JobView, WebPlan } from "@oraknid/contracts";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it } from "vitest";
import type { Router } from "../api/router.ts";
import { type Daemon, startDaemon } from "../daemon.ts";
import { jobs, projects, sessions } from "../db/schema.ts";
import type { JobRunner } from "../engine/runner.ts";
import { resolvePaths } from "../paths.ts";
import { fakeOs } from "../testing/fake-os.ts";
import { seedJob } from "../testing/fixtures.ts";
import { type Action, scriptedLeg, type TurnContext } from "../testing/scripted-leg.ts";
import type { EyeBrain, EyeTriage } from "./brain.ts";
import { KEEP_PAUSED, RAISE_DOUBLE, startBudgetWatch } from "./budgets.ts";

// ADR-034: the project is the place, jobs are its history.

let daemon: Daemon | undefined;
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
});

const sh = (cwd: string, ...a: string[]) =>
  spawnSync("git", a, { cwd, encoding: "utf8" }).stdout.trim();

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "oraknid-pf-"));
  sh(dir, "init", "-q", "-b", "master");
  sh(dir, "config", "user.email", "me@example.com");
  sh(dir, "config", "user.name", "Me");
  writeFileSync(join(dir, "README.md"), "# demo\n");
  sh(dir, "add", ".");
  sh(dir, "commit", "-qm", "start");
  return dir;
}

const ONE: WebPlan = {
  summary: "One file.",
  tasks: [
    {
      key: "t1",
      title: "Write a.txt",
      instructions: "Create a.txt.",
      kind: "implement",
      dependsOn: [],
      scope: ["a.txt"],
      verify: ["test -s a.txt"],
      requiredCapabilities: ["implementation"],
      difficulty: "low",
    },
  ],
  jobVerify: [],
};

const quick = (_t: TurnContext): Action[] => [{ write: "a.txt", content: "a\n" }, { say: "DONE" }];

async function harness(
  script: (t: TurnContext) => Action[],
  triage: (message: string) => EyeTriage = () => ({
    intent: "question",
    reply: "Fine.",
    silk: null,
    tasks: [],
  }),
) {
  const dir = mkdtempSync(join(tmpdir(), "oraknid-pfd-"));
  const leg = scriptedLeg(script);
  const brain = {
    plan: async () => ONE,
    replan: async () => ONE,
    summarize: async () => ({ title: "s", body: "s" }),
    evaluate: async () => ({ accepted: true, reason: "ok", missing: [] }),
    repairCheck: async ({ command }: { command: string }) => ({
      broken: false,
      command,
      reason: "",
    }),
    triage: async ({ message }: { message: string }) => triage(message),
    classifyCommand: async () => ({ decision: "allow" as const, reason: "fine" }),
    interviewRound: async () => ({ done: true, playback: "Clear.", questions: [], open: [] }),
  } as unknown as EyeBrain;
  daemon = await startDaemon({
    paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
    port: 0,
    dbFile: ":memory:",
    os: fakeOs({ keychain: true }).os,
    adapters: { "claude-code": leg.adapter },
    brain,
    metricsIntervalMs: 50,
    stallCheckMs: 100,
  });
  const api = createORPCClient<RouterClient<Router>>(
    new RPCLink({
      url: `${daemon.url}/api`,
      headers: { authorization: `Bearer ${daemon.cliToken}` },
    }),
  );
  await api.legs.create({ kind: "claude-code", name: "Claude A", config: {} });
  const project = await api.projects.create({ name: "piano", workspacePath: repo() });
  return { d: daemon, api, leg, projectId: project.id };
}

type Api = Awaited<ReturnType<typeof harness>>["api"];

async function until(api: Api, id: string, states: string[], ms = 8000): Promise<JobView> {
  const end = Date.now() + ms;
  for (;;) {
    const j = await api.jobs.get({ id });
    if (states.includes(j.state)) return j;
    if (Date.now() > end) throw new Error(`job stayed ${j.state} (${j.blockedReason ?? ""})`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function replies(api: Api, projectId: string, n: number) {
  const end = Date.now() + 5000;
  for (;;) {
    const c = await api.projects.conversation({ id: projectId });
    if (c.filter((m) => m.author === "eye").length >= n || Date.now() > end) return c;
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("The Eye's questions in its conversation (ADR-037)", () => {
  it("asks with options in a reply, and reads my answers as my next message", async () => {
    const got: string[] = [];
    const { api, projectId } = await harness(quick, (m) => {
      got.push(m);
      return got.length === 1
        ? {
            intent: "question",
            reply: "Which tuning first?",
            silk: null,
            tasks: [],
            questions: [
              {
                id: "tuning",
                shape: "multi",
                prompt: "Which tunings?",
                options: [
                  { id: "equal", label: "Equal temperament" },
                  { id: "just", label: "Just intonation" },
                ],
                recommended: "equal",
                allowOther: true,
              },
            ],
          }
        : { intent: "instruction", reply: "Noted.", silk: null, tasks: [] };
    });
    const first = await api.projects.talk({ id: projectId, text: "Add tunings" });
    await until(api, first.jobId, ["completed", "blocked"]);
    await api.projects.talk({ id: projectId, text: "About the tunings" });
    const c = await replies(api, projectId, 2);
    const asked = c.find((m) => m.questions?.length);
    expect(asked?.questions?.[0]).toMatchObject({ id: "tuning", shape: "multi" });
    expect(asked?.itemId).toBeNull();
    await api.projects.answer({
      id: projectId,
      messageId: asked?.id as string,
      answers: [{ questionId: "tuning", options: ["equal", "just"], text: "and meantone" }],
    });
    const after = await replies(api, projectId, 3);
    const mine = after.find((m) => m.replyTo === asked?.id);
    expect(mine?.text).toBe(
      "- Which tunings? — Equal temperament, Just intonation, Other: and meantone",
    );
    expect(got.at(-1)).toBe(mine?.text);
    await expect(
      api.projects.answer({ id: projectId, messageId: asked?.id as string, answers: [] }),
    ).rejects.toThrow(/answered already/);
  }, 30_000);
});

describe("the project's conversation (ADR-034)", () => {
  it("starts the first job from my message, then feeds the one running, then follows up", async () => {
    let hold = true;
    const { api, projectId, d } = await harness(
      (t) => (hold && t.turn === 1 ? [{ run: "sleep 0.6" }, ...quick(t)] : quick(t)),
      (m) =>
        m === "more please"
          ? { intent: "task", reply: "More it is.", silk: null, tasks: [] }
          : {
              intent: "instruction",
              reply: "Noted.",
              silk: { kind: "decision", title: "Keep it small", body: "Keep it small." },
              tasks: [],
            },
    );
    // A project with no job: my message becomes one, started.
    const first = await api.projects.talk({ id: projectId, text: "Add a metronome" });
    const job = await api.jobs.get({ id: first.jobId });
    expect(job).toMatchObject({ projectId, goal: "Add a metronome" });
    let c = await replies(api, projectId, 1);
    expect(c.map((m) => [m.author, m.jobId])).toEqual([
      ["owner", first.jobId],
      ["eye", first.jobId],
    ]);
    expect(c[1]?.action).toMatchObject({ did: ["Started a new job"], jobId: first.jobId });
    expect(c.every((m) => m.projectId === projectId)).toBe(true);

    // While it runs, my words go to it.
    await until(api, first.jobId, ["running"]);
    const second = await api.projects.talk({ id: projectId, text: "Keep it small" });
    expect(second.jobId).toBe(first.jobId);
    c = await replies(api, projectId, 2);
    expect(c.at(-1)?.action?.did).toContain("Recorded as your decision");
    expect(d.silk.current(first.jobId).map((e) => e.title)).toContain("Keep it small");
    hold = false;
    expect((await until(api, first.jobId, ["completed", "blocked"])).state).toBe("completed");

    // Once it has ended, new work starts a follow-up job in the project.
    const third = await api.projects.talk({ id: projectId, text: "more please" });
    expect(third.jobId).toBe(first.jobId);
    c = await replies(api, projectId, 3);
    const followId = c.at(-1)?.action?.jobId as string;
    expect(c.at(-1)?.action?.did).toEqual(["Started a follow-up job"]);
    expect(followId).not.toBe(first.jobId);
    expect((await api.jobs.get({ id: followId })).projectId).toBe(projectId);
    await until(api, followId, ["completed", "blocked"]);

    // Next, the project talks to the follow-up: it is the newest job.
    const fourth = await api.projects.talk({ id: projectId, text: "Keep it small" });
    expect(fourth.jobId).toBe(followId);
    c = await replies(api, projectId, 4);
    expect(c.map((m) => m.jobId)).toEqual([
      first.jobId,
      first.jobId,
      first.jobId,
      first.jobId,
      first.jobId,
      first.jobId,
      followId,
      followId,
    ]);
    // In order, from every job.
    expect(c.map((m) => m.createdAt)).toEqual([...c.map((m) => m.createdAt)].sort((a, b) => a - b));
    expect(await api.jobs.list({ projectId })).toHaveLength(2);
  }, 30_000);

  it("keeps a first job it can't start as a draft, and says why", async () => {
    const { api, projectId, d } = await harness(quick);
    // Its skill needs a tool that isn't set up: the job can't start.
    const upload = await api.skills.upload({
      name: "needs",
      markdown: "---\nname: needs\ndescription: d\nrequires:\n  tools: [missing-tool]\n---\nDo it.",
    });
    await api.projects.setSkills({ id: projectId, skillIds: [upload.skill.id] });
    const r = await api.projects.talk({ id: projectId, text: "Write a letter" });
    const c = await replies(api, projectId, 0);
    expect((await api.jobs.get({ id: r.jobId })).state).toBe("draft");
    // A draft's messages wait in New work, not in the project's conversation.
    expect(c).toEqual([]);
    const all = d.db.select().from(jobs).where(eq(jobs.id, r.jobId)).all();
    expect(all).toHaveLength(1);
    const own = await api.jobs.conversation({ id: r.jobId });
    expect(own.at(-1)?.action?.did).toEqual(["Kept as a draft"]);
    expect(own.at(-1)?.text).toContain("missing-tool");
  });
});

describe("eye_messages carry their project (migration 0029)", () => {
  it("fills each message's project from its job", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const folder = join(here, "..", "..", "drizzle");
    const journal = JSON.parse(readFileSync(join(folder, "meta", "_journal.json"), "utf8")) as {
      entries: { idx: number; tag: string }[];
    };
    // The migrations up to 0028, as a database made before this change had them.
    const old = mkdtempSync(join(tmpdir(), "oraknid-mig-"));
    mkdirSync(join(old, "meta"));
    const before = journal.entries.filter((e) => e.idx <= 28);
    writeFileSync(
      join(old, "meta", "_journal.json"),
      JSON.stringify({ ...journal, entries: before }),
    );
    for (const e of before) copyFileSync(join(folder, `${e.tag}.sql`), join(old, `${e.tag}.sql`));
    const client = new Database(":memory:");
    const db = drizzle(client);
    migrate(db, { migrationsFolder: old });
    client.exec(`
      insert into projects (id, name, workspace_path, is_git_repo, release_branch, work_branch, created_at)
        values ('P1', 'piano', '/tmp/piano', 1, 'main', 'dev', 0);
      insert into skills (id, version, name, description, source, body, interview, required_tools, verify, created_at)
        values ('S1', 1, 's', '', 'built-in', '', 0, '[]', '[]', 0);
      insert into jobs (id, project_id, title, goal, inputs, skill_id, skill_version, autonomy, allowed_leg_ids, budget, state, created_at)
        values ('J1', 'P1', 't', 'g', '[]', 'S1', 1, 'standard', '[]', '{}', 'completed', 0);
      insert into eye_messages (id, job_id, author, text, created_at) values ('M1', 'J1', 'owner', 'hi', 1);
    `);
    migrate(db, { migrationsFolder: folder });
    expect(client.prepare("select project_id from eye_messages where id = 'M1'").get()).toEqual({
      project_id: "P1",
    });
    client.close();
  });
});

describe("Silk per project, kept by job (ADR-034)", () => {
  it("groups a project's Silk by job, newest job first, and earlier jobs' standing Silk reaches a new job's context pack", async () => {
    const { api, projectId, d, leg } = await harness(quick);
    const make = async (goal: string) =>
      (
        await api.jobs.create({
          projectId,
          goal,
          verify: [],
          inputs: [],
          allowedLegIds: [],
          autonomy: "standard",
          unsandboxed: false,
        })
      ).id;
    const a = await make("First");
    d.silk.add({
      jobId: a,
      kind: "decision",
      title: "Use the Web Audio API",
      body: "Not a library.",
      authoredBy: "owner",
    });
    d.silk.add({ jobId: a, kind: "later", title: "A dark theme", body: "", authoredBy: "owner" });
    await new Promise((r) => setTimeout(r, 5));
    const b = await make("Second");
    d.silk.add({ jobId: b, kind: "fact", title: "Node 24", body: "", authoredBy: "eye" });

    const groups = await api.silk.byProject({ projectId });
    expect(groups.map((g) => [g.jobId, g.entries.map((e) => e.title)])).toEqual([
      [b, ["Node 24"]],
      [a, ["Use the Web Audio API", "A dark theme"]],
    ]);

    // The second job's sessions read what the first settled; never its notes for later.
    await api.jobs.start({ id: b });
    expect((await until(api, b, ["completed", "blocked"])).state).toBe("completed");
    const pack = leg.log[0]?.system ?? "";
    expect(pack).toContain("# From earlier jobs in this project");
    expect(pack).toContain("Use the Web Audio API");
    expect(pack).not.toContain("A dark theme");
  }, 20_000);
});

describe("a project budget (ADR-034)", () => {
  it("is a new job's default, and pauses a job past the project's total, then asks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oraknid-pbudget-"));
    daemon = await startDaemon({
      paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
      port: 0,
      dbFile: ":memory:",
      os: fakeOs().os,
      adapters: {},
    });
    const d = daemon;
    // The test's own watch, with a runner it can see, answers instead of the daemon's.
    d.budgets.stop();
    const api = createORPCClient<RouterClient<Router>>(
      new RPCLink({ url: `${d.url}/api`, headers: { authorization: `Bearer ${d.cliToken}` } }),
    );
    // Two jobs of one project: one ended, one running.
    const ended = seedJob(d.db, "completed");
    const projectId = d.db.select().from(jobs).where(eq(jobs.id, ended)).get()?.projectId as string;
    const running = seedJob(d.db, "running");
    d.db.update(jobs).set({ projectId }).where(eq(jobs.id, running)).run();

    await api.projects.setBudget({
      id: projectId,
      budget: { tokens: { limit: 1000, hard: true }, money: null },
    });
    // A new job in it starts with the project's limit.
    const fresh = await api.jobs.create({
      projectId,
      goal: "g",
      verify: [],
      inputs: [],
      allowedLegIds: [],
      autonomy: "standard",
      unsandboxed: false,
    });
    expect((await api.jobs.get({ id: fresh.id })).budget.tokens).toEqual({
      limit: 1000,
      hard: true,
    });
    // Each job alone is under the limit; together they pass it.
    const use = (jobId: string, id: string, n: number) =>
      d.db
        .insert(sessions)
        .values({
          id,
          jobId,
          legId: "l",
          legModelId: "m",
          logFile: "/dev/null",
          startedAt: 0,
          inputTokens: n,
        })
        .run();
    use(ended, "01J9Z3K8W2Q4V6X8Y0A1B2C3S1", 700);
    use(running, "01J9Z3K8W2Q4V6X8Y0A1B2C3S2", 600);
    expect(await api.projects.budget({ id: projectId })).toMatchObject({
      used: { tokens: 1300 },
      asking: false,
    });

    const paused: string[] = [];
    const resumed: string[] = [];
    const watch = startBudgetWatch({
      db: d.db,
      bus: d.bus,
      inbox: d.inbox,
      runner: {
        pause: async (id: string) => {
          paused.push(id);
          d.db.update(jobs).set({ state: "paused" }).where(eq(jobs.id, id)).run();
        },
        resume: async (id: string) => {
          resumed.push(id);
          d.db.update(jobs).set({ state: "running" }).where(eq(jobs.id, id)).run();
        },
      } as unknown as JobRunner,
      now: Date.now,
      intervalMs: 3_600_000,
    });
    await watch.check(running);
    expect(paused).toEqual([running]);
    const name = d.db.select().from(projects).where(eq(projects.id, projectId)).get()?.name;
    const asked = d.inbox.list({ jobId: running, state: "open" });
    expect(asked.map((i) => i.title)).toEqual([
      `Raise the tokens budget of the project "${name}"?`,
    ]);
    expect(asked[0]?.detail).toContain("The project used its token budget");
    expect((await api.projects.budget({ id: projectId })).asking).toBe(true);

    // Doubling it resumes the job it paused.
    await api.inbox.answer({ id: asked[0]?.id as string, answer: RAISE_DOUBLE });
    const end = Date.now() + 2000;
    while (!resumed.length && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    expect(resumed).toEqual([running]);
    expect(await api.projects.budget({ id: projectId })).toMatchObject({
      budget: { tokens: { limit: 2000, hard: true } },
      asking: false,
    });
    // Under the new limit, it runs on.
    await watch.check(running);
    expect(paused).toEqual([running]);

    // Past it again and kept paused: no resume, and asked again when it runs anew.
    use(running, "01J9Z3K8W2Q4V6X8Y0A1B2C3S3", 1000);
    await watch.check(running);
    const again = d.inbox.list({ jobId: running, state: "open" });
    expect(again).toHaveLength(1);
    await api.inbox.answer({ id: again[0]?.id as string, answer: KEEP_PAUSED });
    await new Promise((r) => setTimeout(r, 50));
    expect(resumed).toEqual([running]);
    expect((await api.projects.budget({ id: projectId })).asking).toBe(false);
    watch.stop();
  });
});
