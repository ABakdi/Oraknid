import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InterviewRound } from "@oraknid/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { type Daemon, startDaemon } from "../daemon.ts";
import { resolvePaths } from "../paths.ts";
import { fakeOs } from "../testing/fake-os.ts";
import { type Action, scriptedLeg } from "../testing/scripted-leg.ts";
import { type EyePins, EyeTriage, type PlanRecord, PoolLegBrain, parseJson } from "./brain.ts";

let daemon: Daemon | undefined;
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
});

const task = (key: string, deps: string[] = []) => ({
  key,
  title: key,
  instructions: "x",
  kind: "implement",
  dependsOn: deps,
  scope: ["a"],
  verify: ["true"],
  requiredCapabilities: ["implementation"],
  difficulty: "low",
});
const answer = (tasks: unknown[]) =>
  `\`\`\`json\n${JSON.stringify({ summary: "s", tasks, jobVerify: [] })}\n\`\`\``;

async function brainWith(
  replies: string[],
  o: { pins?: (ids: Record<string, string>) => EyePins } = {},
) {
  const sent: string[] = [];
  const models: string[] = [];
  const records: PlanRecord[] = [];
  const leg = scriptedLeg((t): Action[] => {
    sent.push(t.message);
    models.push(t.model);
    return [{ say: replies[t.turn - 1] ?? replies[0] ?? "" }];
  });
  const dir = mkdtempSync(join(tmpdir(), "oraknid-brain-"));
  daemon = await startDaemon({
    paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
    port: 0,
    dbFile: ":memory:",
    os: fakeOs({ keychain: true }).os,
    adapters: { "claude-code": leg.adapter },
  });
  const created = await daemon.registry.create({
    kind: "claude-code",
    name: "Claude",
    config: { binary: "claude" },
  });
  await daemon.health.checkAll();
  const ids = Object.fromEntries(
    daemon.registry.view(daemon.registry.require(created.id)).models.map((m) => [m.model, m.id]),
  );
  const brain = new PoolLegBrain({
    registry: daemon.registry,
    supervisor: daemon.supervisor,
    pinnedModelId: () => null,
    pins: () => o.pins?.(ids) ?? {},
    record: (r) => records.push(r),
  });
  const input = {
    jobId: "01J9Z3K8W2Q4V6X8Y0A1B2C3D4",
    cwd: dir,
    goal: "g",
    skill: "",
    silk: "",
    digest: "",
    verify: [],
  };
  return { brain, input, sent, models, records };
}

describe("The Eye's brain", () => {
  // After the piano job (2026-10-03): the repo's part is Oraknid's, never a task.
  it("plans no commit, merge or push task, and reads the end steps the goal asked for", async () => {
    const reply = `\`\`\`json\n${JSON.stringify({
      summary: "s",
      tasks: [task("t1")],
      jobVerify: [],
      ending: { merge: true, push: true },
    })}\n\`\`\``;
    const { brain, input, sent } = await brainWith([reply]);
    const plan = await brain.plan({ ...input, goal: "Commit it into dev and push it to GitHub" });
    expect(plan.ending).toEqual({ merge: true, push: true });
    for (const words of [
      "Committing, merging and pushing are Oraknid's own steps, never tasks",
      "never plan a task that commits into a branch, merges into dev or main, pushes",
      'set "ending"',
    ])
      expect(sent[0]).toContain(words);
    await brain.replan({ ...input, failure: "x", done: [] });
    expect(sent.at(-1)).toContain("never plan a task that commits into a branch");
    // A plan that says nothing of them asks for none.
    const { brain: b2, input: i2 } = await brainWith([answer([task("t1")])]);
    expect((await b2.plan(i2)).ending).toBeUndefined();
  });

  it("reads my request to push as an end step, not a task, and sums a finished job up", async () => {
    const triaged = `\`\`\`json\n${JSON.stringify({
      intent: "task",
      reply: "Oraknid pushes it when the job ends.",
      tasks: [],
      ending: { push: true },
    })}\n\`\`\``;
    const { brain, input, sent } = await brainWith([triaged]);
    const v = await brain.triage({
      jobId: input.jobId,
      cwd: input.cwd,
      goal: "g",
      state: "running",
      silk: "",
      conversation: "",
      message: "push it to GitHub",
    });
    expect(v.ending).toEqual({ merge: false, push: true });
    expect(sent[0]).toContain(
      "Committing into a branch, merging into the work branch and pushing to GitHub are never tasks",
    );
    const {
      brain: b2,
      input: i2,
      sent: s2,
    } = await brainWith([
      `\`\`\`json\n${JSON.stringify({ summary: "A piano you can play." })}\n\`\`\``,
    ]);
    const r = await b2.summarizeJob({
      jobId: i2.jobId,
      cwd: i2.cwd,
      goal: "a piano",
      facts: "2 tasks done",
    });
    expect(r.summary).toBe("A piano you can play.");
    expect(s2[0]).toContain("what was built");
  });

  it("returns a valid plan from a borrowed Leg, on the strongest model for planning", async () => {
    const { brain, input, sent } = await brainWith([answer([task("t1")])]);
    const plan = await brain.plan(input);
    expect(plan.tasks.map((t) => t.key)).toEqual(["t1"]);
    expect(sent[0]).toMatch(/^Plan this job as a graph of tasks/);
  });

  it("tells the Leg exactly what was wrong with its plan, and accepts the corrected one", async () => {
    const { brain, input, sent } = await brainWith([
      answer([task("a", ["b"]), task("b", ["a"])]),
      answer([task("a"), task("b", ["a"])]),
    ]);
    const plan = await brain.plan(input);
    expect(plan.tasks.map((t) => t.dependsOn)).toEqual([[], ["a"]]);
    expect(sent[1]).toMatch(
      /That answer was not valid: The tasks depend on each other in a circle: a → b → a/,
    );
  });

  it("gives up after a second bad answer, saying why", async () => {
    const { brain, input } = await brainWith(["not json", "still not"]);
    await expect(brain.plan(input)).rejects.toThrow(
      "The Eye's reasoning gave no valid answer twice (plan): it was not JSON.",
    );
  });

  it("asks each kind of decision of its own model (ADR-022)", async () => {
    const { brain, input, models } = await brainWith([answer([task("t1")])], {
      pins: (ids) => ({ planning: ids.haiku ?? null }),
    });
    await brain.plan(input);
    expect(models).toEqual(["haiku"]);
  });

  it("has the shadow plan the same job in the background, and keeps both (ADR-022)", async () => {
    const { brain, input, models, records } = await brainWith([answer([task("t1")])], {
      pins: (ids) => ({ planning: ids.opus ?? null, shadow: ids.sonnet ?? null }),
    });
    const plan = await brain.plan(input);
    expect(plan.tasks).toHaveLength(1);
    const end = Date.now() + 5000;
    while (records.length < 2 && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    expect(models).toEqual(["opus", "sonnet"]);
    expect(records.map((r) => [r.role, r.model, r.firstTry])).toEqual([
      ["primary", "Claude · opus", true],
      ["shadow", "Claude · sonnet", true],
    ]);
    expect(records[0]?.pairId).toBe(records[1]?.pairId);
  });

  it("asks the interview with shaped questions, and upgrades a round written the old way (ADR-037)", async () => {
    const shaped = {
      done: false,
      playback: "A piano app.",
      questions: [
        {
          id: "who",
          shape: "single",
          prompt: "Who plays it?",
          options: [
            { id: "me", label: "Me" },
            { id: "kids", label: "Children", detail: "Bigger keys" },
          ],
          recommended: "kids",
          allowOther: true,
        },
        { id: "notes", shape: "text", prompt: "Anything else?" },
      ],
      open: [],
    };
    const old = {
      done: false,
      playback: "",
      questions: [
        { question: "Which sound?", options: ["Grand", "Upright"], recommended: "Upright" },
      ],
      open: [],
    };
    const { brain, input, sent } = await brainWith([
      `\`\`\`json\n${JSON.stringify(shaped)}\n\`\`\``,
    ]);
    const round = await brain.interviewRound({ ...input, answers: [] });
    expect(sent[0]).toContain('"shape": "single" (choose one option)');
    expect(round.questions[0]).toMatchObject({ id: "who", shape: "single", recommended: "kids" });
    // Left out by the model: the defaults (no options, no recommendation, "Other" allowed).
    expect(round.questions[1]).toEqual({
      id: "notes",
      shape: "text",
      prompt: "Anything else?",
      options: [],
      recommended: null,
      allowOther: true,
    });
    const legacy = parseJson(JSON.stringify(old), InterviewRound);
    expect(legacy.ok && legacy.value.questions).toEqual([
      {
        id: "q1",
        shape: "single",
        prompt: "Which sound?",
        options: [
          { id: "o1", label: "Grand" },
          { id: "o2", label: "Upright" },
        ],
        recommended: "o2",
        allowOther: true,
      },
    ]);
  });

  it("lets The Eye's reply in its conversation carry questions, and none by default (ADR-037)", () => {
    const withQs = parseJson(
      JSON.stringify({
        intent: "question",
        reply: "Which one?",
        silk: null,
        tasks: [],
        questions: [
          {
            id: "size",
            shape: "multi",
            prompt: "Which sizes?",
            options: [
              { id: "s", label: "Small" },
              { id: "l", label: "Large" },
            ],
          },
        ],
      }),
      EyeTriage,
    );
    expect(withQs.ok && withQs.value.questions?.[0]).toMatchObject({ shape: "multi" });
    const plain = parseJson('{"intent":"question","reply":"Fine."}', EyeTriage);
    expect(plain.ok && plain.value.questions).toBeUndefined();
  });

  it("takes an answer given inside a copy of the schema, and says so when it's only a schema", () => {
    const S = z.object({ a: z.number() });
    expect(
      parseJson('```json\n{"$schema":"x","type":"object","properties":{"a":1}}\n```', S),
    ).toEqual({ ok: true, value: { a: 1 } });
    expect(parseJson('{"type":"object","properties":{"a":{"type":"number"}}}', S)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/JSON Schema, not an answer/),
    });
  });
});
