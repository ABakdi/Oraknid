import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InterviewRound, JobView, WebPlan } from "@oraknid/contracts";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import type { Router } from "../api/router.ts";
import { type Daemon, startDaemon } from "../daemon.ts";
import { jobs, projects, skills } from "../db/schema.ts";
import { resolvePaths } from "../paths.ts";
import { stableId } from "../skills/store.ts";
import { fakeOs } from "../testing/fake-os.ts";
import { fakeJudge } from "../testing/judge.ts";
import { type Action, scriptedLeg, type TurnContext } from "../testing/scripted-leg.ts";
import type { EyeBrain, InterviewInput, PlanInput } from "./brain.ts";
import { readExperience } from "./experience.ts";
import { type DraftSkillInput, type NeedsInput, type NeedsProposal, readNeeds } from "./needs.ts";

// The Eye picks what the work needs (ADR-064 §6) and the interview asks
// for the experience (§4), with a scripted brain and a scripted Leg: no
// real agent runs.

let daemon: Daemon | undefined;
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
});

const sh = (cwd: string, ...a: string[]) =>
  spawnSync("git", a, { cwd, encoding: "utf8" }).stdout.trim();

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "oraknid-needs-"));
  sh(dir, "init", "-q", "-b", "master");
  sh(dir, "config", "user.email", "me@example.com");
  sh(dir, "config", "user.name", "Me");
  writeFileSync(join(dir, "README.md"), "# keys\n");
  sh(dir, "add", ".");
  sh(dir, "commit", "-qm", "start");
  return dir;
}

const PLAN: WebPlan = {
  summary: "One task.",
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
  ],
  jobVerify: [],
};

const good = (_t: TurnContext): Action[] => [
  { write: "hello.sh", content: "echo hi\n" },
  { say: "DONE" },
];

const PIANO =
  "Keys: a piano in the browser with a hardware-synth look, knobs I can hear, a phone layout and its own logo.";
const BACKEND = "Add a REST API endpoint that exports invoices as CSV, with a test.";

const PIANO_EXPERIENCE = {
  feel: "Like a hardware synth: dark panel, knobs that turn.",
  layouts: [
    { device: "phone", layout: "Keyboard across the bottom, two rows of knobs above." },
    { device: "desktop", layout: "Full keyboard, a panel of knobs and a sound designer." },
  ],
  controls: ["knobs", "faders", "a keyboard"],
  references: ["Teenage Engineering OP-1"],
  criteria: [
    "On the phone, the keyboard spans the width.",
    "The sound designer uses knobs, not number fields.",
  ],
};

async function world(o: {
  goal: string;
  propose?: (i: NeedsInput) => NeedsProposal;
  draft?: (i: DraftSkillInput) => string;
  interview?: (input: InterviewInput) => InterviewRound;
}) {
  const dir = mkdtempSync(join(tmpdir(), "oraknid-needsd-"));
  const leg = scriptedLeg(good);
  const seen: { interviews: InterviewInput[]; plans: PlanInput[]; proposals: NeedsInput[] } = {
    interviews: [],
    plans: [],
    proposals: [],
  };
  const brain: EyeBrain = {
    plan: async (i) => {
      seen.plans.push(i);
      return PLAN;
    },
    replan: async () => PLAN,
    summarize: async () => ({ title: "s", body: "s" }),
    helperTurn: async () => ({ reply: "ok", actions: [] }),
    serverState: async () => ({ document: "# s" }),
    pickSkill: async ({ skills }) => ({ skillId: skills[0]?.id ?? "", reason: "first" }),
    repairCheck: async ({ command }) => ({ broken: false, command, reason: "the work" }),
    evaluate: async () => ({ accepted: true, reason: "ok", missing: [] }),
    triage: async () => {
      throw new Error("no triage");
    },
    judgeAction: fakeJudge(() => ({ decision: "allow", reason: "fine" })),
    interviewRound: async (i) => {
      seen.interviews.push(i);
      return o.interview?.(i) ?? { done: true, playback: "Clear.", questions: [], open: [] };
    },
    ...(o.propose
      ? {
          proposeNeeds: async (i: NeedsInput) => {
            seen.proposals.push(i);
            return (o.propose as (i: NeedsInput) => NeedsProposal)(i);
          },
        }
      : {}),
    ...(o.draft
      ? {
          draftSkill: async (i: DraftSkillInput) => ({
            markdown: (o.draft as (i: DraftSkillInput) => string)(i),
          }),
        }
      : {}),
  };
  daemon = await startDaemon({
    paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
    port: 0,
    dbFile: ":memory:",
    os: fakeOs({ keychain: true }).os,
    adapters: { "claude-code": leg.adapter },
    brain,
    metricsIntervalMs: 50,
    guardIntervalMs: 3_600_000,
    stallCheckMs: 100,
  });
  const api = createORPCClient<RouterClient<Router>>(
    new RPCLink({
      url: `${daemon.url}/api`,
      headers: { authorization: `Bearer ${daemon.cliToken}` },
    }),
  );
  await api.legs.create({ kind: "claude-code", name: "Claude A", config: {} });
  const workspace = repo();
  const project = await api.projects.create({ name: "keys", workspacePath: workspace });
  const { id } = await api.jobs.create({
    projectId: project.id,
    goal: o.goal,
    verify: [],
    autonomy: "auto",
    inputs: [],
    allowedLegIds: [],
    unsandboxed: false,
  });
  await api.jobs.start({ id });
  return { d: daemon, api, id, workspace, projectId: project.id, seen };
}

async function until(
  api: { jobs: { get(i: { id: string }): Promise<JobView> } },
  id: string,
  states: string[],
  ms = 10_000,
) {
  const end = Date.now() + ms;
  for (;;) {
    const j = await api.jobs.get({ id });
    if (states.includes(j.state)) return j;
    if (Date.now() > end) throw new Error(`job stayed ${j.state} (${j.blockedReason ?? ""})`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function openItem(api: RouterClient<Router>, title: string, ms = 10_000) {
  const end = Date.now() + ms;
  for (;;) {
    const item = (await api.inbox.list({ state: "open" })).find((i) => i.title === title);
    if (item) return item;
    if (Date.now() > end) throw new Error(`no open "${title}"`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const PIANO_PROPOSAL: NeedsProposal = {
  skills: [
    { name: "canon-driven-development", why: "the method: a spec, then phases" },
    { name: "ui-design", why: "an instrument people play: a design before feature code" },
    { name: "logo-design", why: "Keys has its own logo" },
  ],
  missingSkills: [],
  tools: [],
  servers: [],
  legs: [],
  ui: true,
};

describe("The Eye picks what the work needs (ADR-064 §6)", () => {
  it("proposes canon-driven, ui-design and logo-design for the piano, in one approval; approved, the job has them", async () => {
    const { api, id, d, seen } = await world({
      goal: PIANO,
      propose: () => PIANO_PROPOSAL,
      interview: () => ({
        done: true,
        playback: "A synth-like piano.",
        questions: [],
        open: [],
        experience: PIANO_EXPERIENCE,
      }),
    });
    const item = await openItem(api, "What this job needs");
    // It was given the library, its new built-in skills among them.
    expect(seen.proposals[0]?.skills.map((s) => s.name)).toEqual(
      expect.arrayContaining(["ui-design", "logo-design", "ux-review"]),
    );
    // One approval: the two skills new to the job, ticked, each with why; "Approve all" as its button.
    expect(item.options).toEqual(["Approve all"]);
    const q = item.questions?.[0];
    expect(q).toMatchObject({ id: "use", shape: "multi" });
    expect(q?.options.map((x) => [x.label, x.detail])).toEqual([
      ["Skill: ui-design", "an instrument people play: a design before feature code"],
      ["Skill: logo-design", "Keys has its own logo"],
    ]);
    expect(q?.preselected).toEqual(q?.options.map((x) => x.id));
    expect((await api.jobs.get({ id })).state).toBe("waiting");

    await api.inbox.answer({ id: item.id, answer: "Approve all" });
    const job = await until(api, id, ["completed", "blocked"]);
    expect(job.state, job.blockedReason ?? "").toBe("completed");
    // The job has them, besides its method.
    expect(readNeeds(d.db, id).skills).toEqual([stableId("ui-design"), stableId("logo-design")]);
    const silk = await api.silk.list({ jobId: id });
    expect(silk.find((e) => e.title === "What this job uses")?.body).toMatch(
      /Skill: \*\*ui-design\*\*[\s\S]*Skill: \*\*logo-design\*\*/,
    );
    // The plan is told of them; the interview asked for the experience.
    expect(seen.plans[0]?.skill).toMatch(
      /This job's other skills[\s\S]*## ui-design[\s\S]*## logo-design/,
    );
    expect(seen.interviews[0]?.experience).toBe(true);
  });

  it("leaves out what I untick", async () => {
    const { api, id, d } = await world({ goal: PIANO, propose: () => PIANO_PROPOSAL });
    const item = await openItem(api, "What this job needs");
    const ui = item.questions?.[0]?.options.find((o) => o.label === "Skill: ui-design")?.id ?? "";
    await api.inbox.answer({
      id: item.id,
      answers: [{ questionId: "use", options: [ui], text: "" }],
    });
    await until(api, id, ["completed", "blocked"]);
    expect(readNeeds(d.db, id).skills).toEqual([stableId("ui-design")]);
    const uses = (await api.silk.list({ jobId: id })).find((e) => e.title === "What this job uses");
    expect(uses?.body).toMatch(/Left out:\n- Skill: \*\*logo-design\*\*/);
  });

  it("says when a skill is missing, makes it on my word, and adds the draft I approve", async () => {
    const { api, id, d, workspace, projectId } = await world({
      goal: "A level editor for my platformer game, with a level-design method.",
      propose: () => ({
        ...PIANO_PROPOSAL,
        skills: [{ name: "ui-design", why: "an editor with screens" }],
        missingSkills: [
          {
            name: "level-design",
            description: "How to design platformer levels: pacing, difficulty, teaching by play.",
            why: "the editor's sample levels need a method",
          },
        ],
      }),
      draft: (i) =>
        `---\nname: ${i.name}\ndescription: ${i.description}\ninterview: false\nrequires:\n  tools: []\nverify: []\n---\n\n# Level design\n\nTeach by play.\n\n## Checks\n\n- Each level teaches one thing.\n`,
    });
    const item = await openItem(api, "What this job needs");
    const make = item.questions?.find((q) => q.id === "make:level-design");
    expect(make).toMatchObject({ shape: "single", recommended: "make" });
    expect(make?.options.map((o) => o.label)).toEqual(["Make it", "Go on without"]);
    expect(item.detail).toMatch(/Oraknid has no skill for:[\s\S]*level-design/);
    await api.inbox.answer({ id: item.id, answer: "Approve all" });

    // The draft is written into the project, for me to read (and edit) before I approve it.
    const approval = await openItem(api, 'Add the skill "level-design"?');
    const file = join(workspace, ".oraknid", "skills", "level-design.md");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toMatch(/^---\nname: level-design\n/);
    expect(approval.options).toEqual(["Add it to Oraknid's skills", "Go on without"]);
    // My edit before approving is what gets added.
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace("Teach by play.", "Teach by play, always."),
    );
    await api.inbox.answer({ id: approval.id, answer: "Add it to Oraknid's skills" });
    await until(api, id, ["completed", "blocked"]);

    const made = (await api.skills.list()).find((s) => s.name === "level-design");
    expect(made).toMatchObject({ source: "uploaded" });
    const row = d.db
      .select()
      .from(skills)
      .where(eq(skills.id, made?.id ?? ""))
      .get();
    expect(row?.body).toContain("Teach by play, always.");
    expect(readNeeds(d.db, id).skills).toEqual([stableId("ui-design"), made?.id]);
    const p = d.db.select().from(projects).where(eq(projects.id, projectId)).get();
    expect(p?.skillIds).toContain(made?.id);
    expect((await api.silk.list({ jobId: id })).map((e) => e.title)).toContain(
      "Skill made: level-design",
    );
  });

  it("goes on without a missing skill when I say so, and drafts nothing", async () => {
    const { api, id, workspace } = await world({
      goal: "A level editor for my platformer game.",
      propose: () => ({
        ...PIANO_PROPOSAL,
        skills: [],
        missingSkills: [{ name: "level-design", description: "Levels.", why: "levels" }],
      }),
    });
    const item = await openItem(api, "What this job needs");
    await api.inbox.answer({
      id: item.id,
      answers: [{ questionId: "make:level-design", options: ["without"], text: "" }],
    });
    const job = await until(api, id, ["completed", "blocked"]);
    expect(job.state).toBe("completed");
    expect(existsSync(join(workspace, ".oraknid", "skills", "level-design.md"))).toBe(false);
    expect((await api.skills.list()).some((s) => s.name === "level-design")).toBe(false);
  });

  it("asks nothing when the work needs only its method", async () => {
    const { api, id, d } = await world({
      goal: BACKEND,
      propose: () => ({
        ...PIANO_PROPOSAL,
        skills: [{ name: "canon-driven-development", why: "the method" }],
        ui: false,
      }),
    });
    const job = await until(api, id, ["completed", "blocked"]);
    expect(job.state).toBe("completed");
    expect((await api.inbox.list({})).some((i) => i.title === "What this job needs")).toBe(false);
    expect(readNeeds(d.db, id)).toEqual({ skills: [], ui: false });
    const j = d.db.select().from(jobs).where(eq(jobs.id, id)).get();
    expect(j?.skillChoices).toEqual([]);
  });
});

describe("Experience in the spec (ADR-064 §4)", () => {
  it("asks for an experience section for a UI goal and keeps it on the job and in Silk", async () => {
    const { api, id, d, seen } = await world({
      goal: PIANO,
      interview: (i) => ({
        done: true,
        playback: "A piano.",
        questions: [],
        open: [],
        ...(i.experience ? { experience: PIANO_EXPERIENCE } : {}),
      }),
    });
    await until(api, id, ["completed", "blocked"]);
    expect(seen.interviews[0]?.experience).toBe(true);
    expect(readExperience(d.db, id)?.criteria).toEqual(PIANO_EXPERIENCE.criteria);
    const entry = (await api.silk.list({ jobId: id })).find((e) => e.title === "Experience");
    expect(entry?.body).toMatch(/\*\*Experience acceptance criteria\*\*\n- On the phone/);
    expect(entry?.body).toContain("oraknid visual-check --target design --devices phone,desktop");
    // The plan reads it with the other decisions: its acceptance criteria include them.
    expect(seen.plans[0]?.silk).toContain("The sound designer uses knobs, not number fields.");
  });

  it("asks for none for a backend job, and keeps none even if a round gives one", async () => {
    const { api, id, d, seen } = await world({
      goal: BACKEND,
      interview: () => ({
        done: true,
        playback: "A CSV export.",
        questions: [],
        open: [],
        experience: PIANO_EXPERIENCE,
      }),
    });
    await until(api, id, ["completed", "blocked"]);
    expect(seen.interviews[0]?.experience).toBeUndefined();
    expect(readExperience(d.db, id)).toBeNull();
    expect((await api.silk.list({ jobId: id })).some((e) => e.title === "Experience")).toBe(false);
  });
});
