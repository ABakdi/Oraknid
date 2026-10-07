import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { QuotaWindow, WebPlan } from "@oraknid/contracts";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { attempts, legModels, legs, sessions } from "../db/schema.ts";
import { type Harness, harness } from "../testing/harness-rig.ts";
import { type Action, scriptedLeg, type TurnContext } from "../testing/scripted-leg.ts";

// The task harness's behaviour pinned by my real jobs, replayed end to end
// with stand-in agents (ADR-056 stage 1, M15.8): what each job ends as, and
// what I was asked, how many times and in which words.

let rig: Harness | undefined;
afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

const taskOf = (t: TurnContext) => t.system.match(/# Your task: (.*)/)?.[1] ?? "";
const one = (
  title: string,
  instructions: string,
  verify: string[],
  scope = ["notes/**"],
): WebPlan["tasks"][number] => ({
  key: title.toLowerCase().replace(/\W+/g, "-"),
  title,
  instructions,
  kind: "implement",
  dependsOn: [],
  scope,
  verify,
  requiredCapabilities: ["implementation"],
  difficulty: "low",
});
/** An ssh to VPS One as an agent writes it, with the job's own ssh config. */
const agentSsh = (t: TurnContext, remote: string) =>
  `ssh -F ${t.home ?? "/x"}/.ssh/config oraknid-vps-one '${remote}'`;
const removalTalk = () => ({
  intent: "work" as const,
  reply: "I'll remove it.",
  goal: "Remove Misahaty",
});

describe("my server jobs, replayed (2026-10-06/07)", () => {
  it("the misahaty removal: one plan approval, the removal its plan names blocked by layer 1 through Claude Code's hook, asked of me specifically, allowed, done", async () => {
    let home = "";
    const leg = scriptedLeg(
      (t) =>
        taskOf(t) === "Remove Misahaty" && t.turn === 1
          ? [
              {
                run: agentSsh(t, "rm -rf /root/misahaty"),
                instead: () => {
                  rmSync(join(home, "misahaty"), { recursive: true, force: true });
                  return "";
                },
              },
              { say: "DONE: removed /root/misahaty." },
            ]
          : [{ say: "DONE" }],
      { autoModeHooks: true },
    );
    rig = await harness({
      legs: [{ kind: "claude-code", name: "Claude A", leg }],
      server: true,
      talk: removalTalk,
      plan: {
        summary: "Remove Misahaty.",
        tasks: [
          one(
            "Remove Misahaty",
            "Stop Misahaty's containers, then delete /root/misahaty (its code and config).",
            ["ssh oraknid-vps-one test ! -e misahaty"],
          ),
        ],
        jobVerify: [],
      },
    });
    home = rig.ssh?.home as string;
    mkdirSync(join(home, "misahaty"));
    const job = await rig.serverJob("remove misahaty");
    const ask = await rig.openItem(/wants to run `rm -rf \/root\/misahaty` on VPS One/);
    await rig.api.inbox.answer({ id: ask.id, answer: "Allow" });
    const done = await rig.ended(job.id);
    expect(done.state, done.blockedReason ?? "").toBe("completed");
    // What I was asked: the plan, then the one removal, in so many words; nothing else.
    const asked = await rig.asked(job.id);
    expect(asked.map((i) => i.title)).toEqual([
      "Approve what will change on VPS One",
      "Claude A wants to run `rm -rf /root/misahaty` on VPS One, as the plan says",
    ]);
    expect(asked[1]?.questions?.[0]?.prompt).toBe(
      "Claude A wants to run `rm -rf /root/misahaty` on VPS One (in the plan you approved: “Stop Misahaty's containers, then delete /root/misahaty (its code and config).”). Run it?",
    );
    expect(asked[1]?.options).toEqual(["Allow", "Keep it blocked"]);
    // One attempt, on one session; the check ran on the server.
    expect(done.tasks.map((t) => [t.state, t.attemptCount])).toEqual([["done", 1]]);
    expect(rig.ssh?.commands).toContain("test ! -e misahaty");
  }, 60_000);

  it("a check written with the job's private ssh setup (-F, HOME=) runs in its plain form on the server, asked nothing but the plan", async () => {
    const home = "/home/me/.local/share/oraknid/legs/01K6ZLEG/jobs/01K70JOBJOBJOB/home";
    const seen = `n=$(HOME=${home} ssh -o BatchMode=yes -F ${home}/.ssh/config oraknid-vps-one docker ps -q --filter name=harvest- | wc -l); [ "$n" -eq 2 ]`;
    rig = await harness({
      legs: [
        {
          kind: "claude-code",
          name: "Claude A",
          leg: scriptedLeg(() => [{ say: "DONE: nothing to change." }]),
        },
      ],
      server: true,
      talk: removalTalk,
      plan: {
        summary: "Remove Misahaty.",
        tasks: [one("Remove Misahaty", "Remove Misahaty; Harvest keeps running.", [seen])],
        jobVerify: [],
      },
    });
    const job = await rig.serverJob("remove misahaty");
    const done = await rig.ended(job.id);
    expect(done.state, done.blockedReason ?? "").toBe("completed");
    expect(rig.ssh?.commands).toContain(
      `n=$(docker ps -q --filter name=harvest- | wc -l); [ "$n" -eq 2 ]`,
    );
    expect(rig.ssh?.commands.some((c) => c.includes("-F") || c.includes("/jobs/"))).toBe(false);
    expect((await rig.asked(job.id)).map((i) => i.title)).toEqual([
      "Approve what will change on VPS One",
    ]);
    expect(done.tasks[0]?.verify).toEqual([
      `n=$(ssh oraknid-vps-one docker ps -q --filter name=harvest- | wc -l); [ "$n" -eq 2 ]`,
    ]);
  }, 60_000);

  it("a plan of crumbs is one task: the misahaty removal's five steps, one approval, one session", async () => {
    const step = (key: string, title: string, over: Partial<WebPlan["tasks"][number]> = {}) => ({
      ...one(title, `${title}.`, []),
      key,
      kind: "mechanical" as const,
      requiredCapabilities: ["mechanical" as const],
      ...over,
    });
    const leg = scriptedLeg((t) => [{ say: `DONE: ${taskOf(t)}` }]);
    rig = await harness({
      legs: [{ kind: "claude-code", name: "Claude A", leg }],
      server: true,
      talk: removalTalk,
      plan: {
        summary: "Remove the misahaty compose project.",
        jobVerify: [],
        tasks: [
          step("look", "Inspect the misahaty compose project", { kind: "research" }),
          step("backup", "Back up its volumes", {
            dependsOn: ["look"],
            verify: ["ssh oraknid-vps-one true"],
          }),
          step("down", "Run docker compose down", { dependsOn: ["backup"] }),
          step("rm", "Remove the project's folder", { dependsOn: ["down"] }),
          step("check", "Verify nothing of it runs", {
            kind: "test",
            dependsOn: ["rm"],
            verify: ["ssh oraknid-vps-one test ! -e misahaty"],
          }),
        ],
      },
    });
    const job = await rig.serverJob("remove misahaty");
    const done = await rig.ended(job.id);
    expect(done.state, done.blockedReason ?? "").toBe("completed");
    expect(done.tasks).toHaveLength(1);
    expect(done.tasks[0]?.title).toMatch(/^Inspect the misahaty compose project/);
    expect(done.tasks[0]?.verify).toEqual([
      "ssh oraknid-vps-one true",
      "ssh oraknid-vps-one test ! -e misahaty",
    ]);
    expect((await rig.asked(job.id)).map((i) => i.title)).toEqual([
      "Approve what will change on VPS One",
    ]);
    const s = rig.d.db.select().from(sessions).where(eq(sessions.jobId, job.id)).all();
    expect(s).toHaveLength(1);
  }, 60_000);
});

// The research task of 2026-10-04 and the free models of 2026-10-06.
const DOC = "docs/audio-libraries-recommendation.md";
const RESEARCH: WebPlan = {
  summary: "Pick the audio library.",
  tasks: [
    {
      ...one(
        "Research audio helper libraries",
        "Compare Tone.js and raw Web Audio for low latency.",
        [`test -s ${DOC}`],
        ["research"],
      ),
      kind: "research",
      requiredCapabilities: ["summarize", "classify"],
      difficulty: "medium",
    },
  ],
  jobVerify: [],
};

/** A free OpenCode Leg that goes first, beside a Claude Leg that writes the document. */
async function withFree(free: ReturnType<typeof scriptedLeg>, model: string) {
  const claude = scriptedLeg(() => [
    { write: DOC, content: "# Audio libraries\n\n| [Tone.js] |\n" },
    { say: "DONE: wrote the recommendation." },
  ]);
  const r = await harness({
    legs: [
      { kind: "opencode", name: "Opencode", leg: free },
      { kind: "claude-code", name: "Claude", leg: claude },
    ],
    plan: RESEARCH,
  });
  const week: QuotaWindow[] = [
    {
      name: "seven_day",
      utilization: 0.7,
      resetsAt: Date.now() + 86_400_000,
      estimated: false,
      observedAt: Date.now(),
      source: "usage",
    },
  ];
  r.d.db
    .update(legs)
    .set({ quota: week })
    .where(eq(legs.id, r.legIds.Claude as string))
    .run();
  const m = r.d.db
    .select()
    .from(legModels)
    .where(and(eq(legModels.legId, r.legIds.Opencode as string), eq(legModels.model, model)))
    .get();
  if (!m) throw new Error(`no ${model}`);
  r.d.registry.saveProfile(m.id, {
    overrides: {},
    observed: { research: { attempts: 6, successes: 6, tokens: 0, ms: 0, escalations: 0 } },
  });
  return r;
}

const tried = (r: Harness, jobId: string) =>
  r.d.db
    .select()
    .from(attempts)
    .where(eq(attempts.jobId, jobId))
    .orderBy(attempts.startedAt)
    .all()
    .map((a) => [r.d.registry.model(a.legModelId)?.model, a.outcome]);

describe("agents that aren't available (ADR-052 §4)", () => {
  it("an agent out of quota (“Resets in 51h49m11s”) is kept out until then, never routed to again, not counted, nothing asked", async () => {
    const said = "Individual quota reached for big-pickle. Resets in 51h49m11s.";
    const free = scriptedLeg(() => [{ fail: said }], { kind: "opencode", models: ["big-pickle"] });
    rig = await withFree(free, "big-pickle");
    const before = Date.now();
    const { id } = await rig.repoJob("Pick the audio library");
    const done = await rig.ended(id);
    expect(done.state, done.blockedReason ?? "").toBe("completed");
    expect(tried(rig, id)).toEqual([
      ["big-pickle", "unavailable"],
      ["sonnet", "succeeded"],
    ]);
    const oc = rig.d.registry.require(rig.legIds.Opencode as string);
    expect(oc.health).toBe("rate-limited");
    expect(oc.limitedUntil ?? 0).toBeGreaterThanOrEqual(before + (51 * 3600 + 49 * 60 + 11) * 1000);
    // Its second routing didn't consider it.
    const running = rig
      .events(id, "task.state")
      .filter((p) => p.to === "running")
      .map((p) => p.routing as { excluded: { why: string }[] });
    expect(running[1]?.excluded.map((e) => e.why).join(" ")).toMatch(
      /Opencode · big-pickle: rate-limited/,
    );
    expect(free.log).toHaveLength(1);
    expect(await rig.asked(id)).toEqual([]);
  }, 60_000);

  it("a model its provider deprecated is hidden and replaced by the one it names, not counted, nothing asked", async () => {
    const free = scriptedLeg(
      (t) =>
        t.model === "mimo-v2.5-free"
          ? [
              {
                fail: "Model mimo-v2.5-free has been deprecated. Use mimo-v2.6-flash-free instead.",
              },
            ]
          : [{ write: DOC, content: "# Audio libraries\n" }, { say: "DONE" }],
      { kind: "opencode", models: ["mimo-v2.5-free"] },
    );
    rig = await withFree(free, "mimo-v2.5-free");
    const { id } = await rig.repoJob("Pick the audio library");
    const done = await rig.ended(id);
    expect(done.state, done.blockedReason ?? "").toBe("completed");
    const all = tried(rig, id);
    expect(all[0]).toEqual(["mimo-v2.5-free", "unavailable"]);
    expect(all.slice(1).map((a) => a[0])).not.toContain("mimo-v2.5-free");
    expect(all.at(-1)?.[1]).toBe("succeeded");
    expect(
      rig.d.registry.models(rig.legIds.Opencode as string).map((m) => [m.model, m.hidden]),
    ).toEqual([
      ["mimo-v2.5-free", true],
      ["mimo-v2.6-flash-free", false],
    ]);
    expect(await rig.asked(id)).toEqual([]);
  }, 60_000);
});

describe("checks and plans (ADR-052 §2, ADR-050)", () => {
  it("a broken check is repaired before any agent works, and nobody is charged for it", async () => {
    const broken = 'test "$(sh hello.sh)" = "hi';
    const fixed = 'test "$(sh hello.sh)" = hi';
    const leg = scriptedLeg(() => [
      { write: "hello.sh", content: "echo hi\n" },
      { say: "DONE: wrote hello.sh" },
    ]);
    const repairs: string[] = [];
    rig = await harness({
      legs: [{ kind: "claude-code", name: "Claude A", leg }],
      plan: {
        summary: "A script that says hi.",
        tasks: [one("Write hello.sh", "Create hello.sh that prints hi.", [broken], ["hello.sh"])],
        jobVerify: [],
      },
      brain: {
        repairCheck: async ({ command }) => {
          repairs.push(command);
          return { broken: true, command: fixed, reason: "its last quote is never closed" };
        },
      },
    });
    const { id } = await rig.repoJob("Say hi");
    const done = await rig.ended(id);
    expect(done.state, done.blockedReason ?? "").toBe("completed");
    expect(repairs).toEqual([broken]);
    expect(done.tasks[0]?.verify).toEqual([fixed]);
    expect(tried(rig, id).map((a) => a[1])).toEqual(["succeeded"]);
    expect(rig.events(id, "task.checks-tried")[0]?.checks).toEqual([
      { command: broken, state: `broken, repaired as \`${fixed}\`` },
    ]);
    expect(rig.events(id, "task.drift")).toEqual([]);
    expect(await rig.asked(id)).toEqual([]);
  }, 60_000);

  it("a small web app (the piano), its independent parts side by side: all done, all merged, nothing asked", async () => {
    const parts = [
      ["Build the keyboard", "src/keyboard.js"],
      ["Build the sounds", "src/sounds.js"],
      ["Style the page", "src/style.css"],
      ["Write the page", "index.html"],
    ] as const;
    const plan: WebPlan = {
      summary: "A piano in the browser.",
      tasks: [
        ...parts.map(([title, file]) => one(title, `Write ${file}.`, [`test -s ${file}`], [file])),
        {
          ...one(
            "Test the piano",
            "Write test.sh that checks every part.",
            ["sh test.sh"],
            ["test.sh"],
          ),
          kind: "test",
          dependsOn: parts.map(([title]) => title.toLowerCase().replace(/\W+/g, "-")),
        },
      ],
      jobVerify: ["sh test.sh"],
    };
    const leg = scriptedLeg((t): Action[] => {
      const part = parts.find(([title]) => title === taskOf(t));
      if (part) return [{ run: "sleep 1" }, { write: part[1], content: "x\n" }, { say: "DONE" }];
      return [
        {
          write: "test.sh",
          content: parts
            .map(([, f]) => `test -s ${f}`)
            .join(" && ")
            .concat("\n"),
        },
        { say: "DONE" },
      ];
    });
    rig = await harness({ legs: [{ kind: "claude-code", name: "Claude A", leg }], plan });
    await rig.api.legs.update({ id: rig.legIds["Claude A"] as string, maxSessions: 4 });
    const { id, workspace } = await rig.repoJob("A piano");
    const done = await rig.ended(id, 60_000);
    expect(done.state, done.blockedReason ?? "").toBe("completed");
    expect(done.tasks.map((t) => t.state)).toEqual(["done", "done", "done", "done", "done"]);
    // Merged into the job's branch, every part.
    const r = await rig.api.jobs.result({ id });
    for (const [, f] of parts)
      expect(
        spawnSync("git", ["show", `${r.branch}:${f}`], { cwd: workspace, encoding: "utf8" }).stdout,
      ).toBe("x\n");
    // Side by side: some of the parts' sessions overlapped.
    const s = rig.d.db.select().from(sessions).where(eq(sessions.jobId, id)).all();
    const overlapped = s.some((a) =>
      s.some(
        (b) =>
          a.id !== b.id &&
          a.startedAt < (b.endedAt ?? Number.MAX_SAFE_INTEGER) &&
          b.startedAt < (a.endedAt ?? Number.MAX_SAFE_INTEGER),
      ),
    );
    expect(overlapped).toBe(true);
    expect(await rig.asked(id)).toEqual([]);
  }, 90_000);
});
