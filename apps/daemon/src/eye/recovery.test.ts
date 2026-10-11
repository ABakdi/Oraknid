import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { WebPlan } from "@oraknid/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { HYGIENE, writeSetting } from "../settings.ts";
import { type Harness, harness, waitFor } from "../testing/harness-rig.ts";
import { scriptedLeg, type TurnContext } from "../testing/scripted-leg.ts";
import { noThinkerSaid } from "./brain.ts";
import { blockedAfterRecovery, ownersToDecide, RecoveryFailed, WaitsForLegs } from "./recovery.ts";
import { cantThinkSaid, conversation, GO_ON, honestReply, PROMISES } from "./talk.ts";

// Self-recovery and the repository steward (ADR-067), from the Keys job of
// 2026-10-11: blocked by "couldn't be merged … 9 times: … ()" because a
// test run dirtied a node_modules Oraknid itself had committed; my "fix
// it" added a task nothing ran. Never a real agent, never my data or port.

let rig: Harness | undefined;
afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

const taskOf = (t: TurnContext) => t.system.match(/# Your task: (.*)/)?.[1] ?? "";
const sh = (cwd: string, ...a: string[]) =>
  spawnSync("git", a, { cwd, encoding: "utf8" }).stdout.trim();

const task = (
  key: string,
  title: string,
  verify: string[],
  scope: string[],
): WebPlan["tasks"][number] => ({
  key,
  title,
  instructions: `${title}.`,
  kind: "implement",
  dependsOn: [],
  scope,
  verify,
  requiredCapabilities: ["implementation"],
  difficulty: "low",
});

/** A repository whose first commit took everything, node_modules and dist with it: Keys. */
function keysRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "oraknid-keys-"));
  sh(dir, "init", "-q", "-b", "master");
  sh(dir, "config", "user.email", "me@example.com");
  sh(dir, "config", "user.name", "Me");
  const files: Record<string, string> = {
    "package.json": "{}\n",
    "src/main.ts": "export {};\n",
    "node_modules/react/index.js": "module.exports = 1;\n",
    "node_modules/.vite/deps/_metadata.json": '{"hash":"first"}\n',
    "dist/index.html": "<html></html>\n",
  };
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "feat: scaffold the Keys frontend");
  return dir;
}

/** A job on a project at `workspace`, started in auto mode. */
async function startJob(r: Harness, workspace: string, goal: string) {
  const project = await r.api.projects.create({ name: "keys", workspacePath: workspace });
  const { id } = await r.api.jobs.create({
    projectId: project.id,
    goal,
    verify: [],
    autonomy: "auto",
    inputs: [],
    allowedLegIds: [],
    unsandboxed: false,
  });
  await r.api.jobs.start({ id });
  return id;
}

/** The job's branch in the project, as it ended. */
const jobBranch = async (r: Harness, id: string) => (await r.api.jobs.get({ id })).branch as string;

/** Two tasks side by side whose checks rewrite Vite's cache, as a test run does. */
const vitePlan: WebPlan = {
  summary: "Two parts, each tested.",
  tasks: [
    task(
      "a",
      "Build the parser",
      ["echo parser > node_modules/.vite/deps/_metadata.json; test -f parser.js"],
      ["parser.js"],
    ),
    task(
      "b",
      "Draw the logo",
      ["echo logo > node_modules/.vite/deps/_metadata.json; test -f logo.svg"],
      ["logo.svg"],
    ),
  ],
  jobVerify: [],
};

const writes = (t: TurnContext) =>
  taskOf(t) === "Build the parser"
    ? [{ run: "sleep 1" }, { write: "parser.js", content: "x\n" }, { say: "DONE" }]
    : [{ run: "sleep 1" }, { write: "logo.svg", content: "<svg/>\n" }, { say: "DONE" }];

describe("the Keys block: tracked node_modules dirtied by a test run (ADR-067 §1, §2, §7)", () => {
  it("is prevented by the repository's care alone: untracked on the job's branch, merged, no recovery", async () => {
    const leg = scriptedLeg((t) => writes(t));
    rig = await harness({ legs: [{ kind: "claude-code", name: "Claude A", leg }], plan: vitePlan });
    await rig.api.legs.update({ id: rig.legIds["Claude A"] as string, maxSessions: 2 });
    const workspace = keysRepo();
    const id = await startJob(rig, workspace, "Two parts");
    const done = await rig.ended(id, 45_000);
    expect(done.state, done.blockedReason ?? "").toBe("completed");
    const branch = await jobBranch(rig, id);
    const files = sh(workspace, "ls-tree", "-r", "--name-only", branch).split("\n");
    expect(files.some((f) => f.startsWith("node_modules/"))).toBe(false);
    expect(files.some((f) => f.startsWith("dist/"))).toBe(false);
    expect(files).toEqual(expect.arrayContaining([".gitignore", "parser.js", "logo.svg"]));
    expect(sh(workspace, "log", "--format=%s", branch)).toContain(
      "chore: stop tracking generated files",
    );
    expect(leg.log.some((t) => taskOf(t).startsWith("Recover:"))).toBe(false);
    const silk = await rig.api.silk.list({ jobId: id });
    expect(silk.some((e) => e.title === "Stopped tracking generated files")).toBe(true);
  }, 90_000);

  it("without that care, the steward fixes the folder git refused and the merge goes through", async () => {
    const leg = scriptedLeg((t) =>
      !taskOf(t).startsWith("Recover:")
        ? writes(t)
        : /Conflicted files:/.test(t.system)
          ? [
              // Vite writes its cache again: either side will do.
              { write: "node_modules/.vite/deps/_metadata.json", content: '{"hash":"rebuilt"}\n' },
              { say: "Both sides changed Vite's cache; I wrote it once, as Vite would." },
            ]
          : [
              { run: "git checkout -- node_modules" },
              {
                say: "The job's folder had changes to node_modules/.vite, a cache Vite rewrites; I restored it.",
              },
            ],
    );
    // Each test run writes where it ran: the job's folder and each task's differ, as a real cache does.
    const plan: WebPlan = {
      ...vitePlan,
      tasks: vitePlan.tasks.map((t) => ({
        ...t,
        verify: t.verify.map((v) => v.replace(/^echo \w+/, "pwd")),
      })),
    };
    rig = await harness({ legs: [{ kind: "claude-code", name: "Claude A", leg }], plan });
    writeSetting(rig.d.db, HYGIENE, z.boolean(), false);
    await rig.api.legs.update({ id: rig.legIds["Claude A"] as string, maxSessions: 2 });
    const id = await startJob(rig, keysRepo(), "Two parts");
    const done = await rig.ended(id, 60_000);
    expect(done.state, done.blockedReason ?? "").toBe("completed");
    // The first try fixed the folder; the merge then met a real conflict in the cache, and the
    // second, told what the first found, resolved it.
    const steward = leg.log.filter((t) => taskOf(t).startsWith("Recover:"));
    expect(steward.length).toBe(2);
    // It was told git's real reason, never "conflicted ()".
    expect(steward[0]?.system).toMatch(/uncommitted changes git won't overwrite/);
    expect(steward[0]?.system).toContain("node_modules/.vite/deps/_metadata.json");
    expect(steward[1]?.system).toMatch(/Tried before, and it wasn't enough/);
    const silk = await rig.api.silk.list({ jobId: id });
    expect(silk.some((e) => e.title === "Recovered")).toBe(true);
  }, 90_000);
});

/** Two tasks side by side that both write `file`, each checked for its own line. */
const twoSides = (file: string, scope: string[]): WebPlan => ({
  summary: "Two sides.",
  tasks: [
    task("a", "Write alpha", [`grep -q a1 ${file}`], scope),
    task("b", "Write beta", [`grep -q b1 ${file}`], scope),
  ],
  jobVerify: [],
});

const side = (t: TurnContext, file: string) =>
  taskOf(t) === "Write alpha"
    ? [{ run: "sleep 1" }, { write: file, content: "a1\n" }, { say: "DONE" }]
    : [{ run: "sleep 1" }, { write: file, content: "b1\n" }, { say: "DONE" }];

describe("a real conflict goes to the steward, and the checks decide (ADR-067 §7)", () => {
  it("resolves a two-sided conflict with both intents, gated by the task's checks", async () => {
    const leg = scriptedLeg((t) =>
      taskOf(t).startsWith("Recover:")
        ? [
            { write: "src/shared.txt", content: "a1\nb1\n" },
            { say: "Both tasks wrote src/shared.txt; I kept both lines." },
          ]
        : side(t, "src/shared.txt"),
    );
    rig = await harness({
      legs: [{ kind: "claude-code", name: "Claude A", leg }],
      plan: twoSides("src/shared.txt", ["src/**"]),
    });
    await rig.api.legs.update({ id: rig.legIds["Claude A"] as string, maxSessions: 2 });
    const { id, workspace } = await rig.repoJob("Two sides");
    const done = await rig.ended(id, 60_000);
    expect(done.state, done.blockedReason ?? "").toBe("completed");
    const steward = leg.log.find((t) => taskOf(t).startsWith("Recover:"));
    expect(steward?.system).toMatch(/Conflicted files:\nsrc\/shared\.txt/);
    expect(steward?.system).toMatch(/The job's side: work merged meanwhile/);
    const branch = await jobBranch(rig, id);
    expect(sh(workspace, "show", `${branch}:src/shared.txt`)).toBe("a1\nb1");
    // The merge is a merge: both tasks' commits are in the job's history.
    expect(sh(workspace, "log", "--format=%p", "-1", branch).split(" ").length).toBe(2);
  }, 90_000);

  it("regenerates a lockfile in conflict rather than merging it by hand", async () => {
    const leg = scriptedLeg((t) =>
      taskOf(t).startsWith("Recover:")
        ? [
            // What `pnpm install --lockfile-only` writes from both sides' package.json.
            { write: "pnpm-lock.yaml", content: "a1\nb1\n" },
            { say: "pnpm-lock.yaml conflicted; I took one side and let pnpm write it again." },
          ]
        : side(t, "pnpm-lock.yaml"),
    );
    rig = await harness({
      legs: [{ kind: "claude-code", name: "Claude A", leg }],
      plan: twoSides("pnpm-lock.yaml", ["**"]),
    });
    await rig.api.legs.update({ id: rig.legIds["Claude A"] as string, maxSessions: 2 });
    const { id } = await rig.repoJob("Two lockfiles");
    const done = await rig.ended(id, 60_000);
    expect(done.state, done.blockedReason ?? "").toBe("completed");
    const steward = leg.log.find((t) => taskOf(t).startsWith("Recover:"));
    expect(steward?.system).toContain("pnpm install --lockfile-only");
    expect(steward?.system).toMatch(/Conflicted files:\npnpm-lock\.yaml/);
  }, 90_000);

  it("blocks with one plain question after two tries that fail the checks; my “fix it” recovers at once", async () => {
    let good = false;
    const leg = scriptedLeg((t) =>
      taskOf(t).startsWith("Recover:")
        ? good
          ? [{ say: "Looked again: nothing in the folder is in the way now." }]
          : [
              // Drops beta's work: its check fails on the merge, which is taken back.
              { write: "src/shared.txt", content: "a1\n" },
              {
                say: "I kept alpha's version. FOR THE OWNER: Should src/shared.txt keep alpha's line, beta's, or both?",
              },
            ]
        : side(t, "src/shared.txt"),
    );
    rig = await harness({
      legs: [{ kind: "claude-code", name: "Claude A", leg }],
      plan: twoSides("src/shared.txt", ["src/**"]),
    });
    await rig.api.legs.update({ id: rig.legIds["Claude A"] as string, maxSessions: 2 });
    const { id, workspace } = await rig.repoJob("Two sides");
    const blocked = await rig.ended(id, 60_000);
    expect(blocked.state).toBe("blocked");
    expect(blocked.blockedReason).toMatch(
      /^Merging “Write (alpha|beta)” into the job's branch failed: it conflicted with work merged meanwhile \(`src\/shared\.txt`\)\. I tried to fix it 2 times and couldn't: first, .*; then, .*\. Should src\/shared\.txt keep alpha's line, beta's, or both\?$/,
    );
    expect(blocked.blockedReason).not.toMatch(/\(\)/);
    // Two steward tries, the second a rung higher; the task itself never blindly redone.
    expect(leg.log.filter((t) => taskOf(t).startsWith("Recover:")).length).toBe(2);
    expect(leg.log.filter((t) => taskOf(t) === "Write beta").length).toBe(1);
    // Nothing half-merged was kept on the job's branch.
    const branch = await jobBranch(rig, id);
    expect(sh(workspace, "status", "--porcelain")).toBe("");
    expect(sh(workspace, "log", "--format=%s", branch)).not.toMatch(/recover/i);
    expect(["a1", "b1"]).toContain(sh(workspace, "show", `${branch}:src/shared.txt`));

    // My "fix it" needs no model to understand: a recovery starts now, and the work goes on.
    good = true;
    const before = leg.log.length;
    await rig.api.jobs.talk({ id, text: "fix the merge conflicts and continue" });
    const reply = await waitFor("The Eye's reply", () =>
      conversation(rig?.d.db as never, id).find(
        (m) => m.author === "eye" && /looking into what blocked the job now/.test(m.text),
      ),
    );
    expect(reply.text).not.toMatch(/I'll resolve/);
    await waitFor("a recovery session", () =>
      leg.log.slice(before).some((t) => taskOf(t).startsWith("Recover:")),
    );
    const done = await waitFor(
      "the job's end",
      async () => {
        const j = await rig?.api.jobs.get({ id });
        return j && ["completed", "blocked"].includes(j.state) && j.state !== blocked.state
          ? j
          : j?.state === "completed"
            ? j
            : null;
      },
      60_000,
    );
    expect(done.state, done.blockedReason ?? "").toBe("completed");
    expect(
      conversation(rig.d.db as never, id).some(
        (m) => m.author === "eye" && /^I looked into what blocked the job/.test(m.text),
      ),
    ).toBe(true);
  }, 150_000);
});

describe("what is mine to decide, and what is recovered (ADR-067 §3)", () => {
  it("never recovers what waits for me or for a Leg", () => {
    expect(ownersToDecide(new WaitsForLegs("Claude is out of quota until 14:00."))).toBe(true);
    expect(ownersToDecide(new RecoveryFailed("x"))).toBe(true);
    expect(ownersToDecide(new Error("No Leg can think for The Eye right now: …"))).toBe(true);
    expect(ownersToDecide(new Error("git worktree add failed: …"))).toBe(false);
    expect(ownersToDecide(new Error('"X" failed 8 attempts. Look at it, then resume.'))).toBe(
      false,
    );
  });

  it("blocks in plain words, never with a counter", () => {
    const said = blockedAfterRecovery(
      { step: "the job's work", error: "git said no." },
      { ok: false, findings: ["a lock file was left; removed", "it came back"], forOwner: null },
    );
    expect(said).toMatch(
      /^The job's work failed: git said no\.\. I tried to fix it 2 times and couldn't: first, a lock file was left; removed; then, it came back\. Tell me here/,
    );
  });
});

describe("replies keep their word (ADR-067 §4)", () => {
  it("reads “fix it” and its kin on a blocked job without a model", () => {
    for (const m of [
      "fix it",
      "fix the merge conflicts and continue",
      "please unblock this",
      "resolve this",
      "try again",
      "go on",
    ])
      expect(GO_ON.test(m), m).toBe(true);
    expect(GO_ON.test("what is blocking it?")).toBe(false);
  });

  it("never promises work that won't run now", () => {
    const blocked = honestReply("I'll resolve the merge conflicts and resume the work.", {
      jobState: "blocked",
      started: false,
      did: ["Added a task"],
      blockedReason: "Merging failed.",
    });
    expect(PROMISES.test(blocked)).toBe(false);
    expect(blocked).toBe(
      "Added a task. The job is blocked (Merging failed), so nothing runs until it goes on: say “fix it” to start a recovery now, or resume it.",
    );
    // Running, or started by the message: the promise stands.
    expect(
      honestReply("I'll add it now.", {
        jobState: "running",
        started: false,
        did: ["Added a task"],
      }),
    ).toBe("I'll add it now.");
    expect(
      honestReply("I'll look now.", {
        jobState: "blocked",
        started: true,
        did: ["Started a recovery"],
      }),
    ).toBe("I'll look now.");
    expect(
      PROMISES.test(
        honestReply("Let me do that.", { jobState: "paused", started: false, did: [] }),
      ),
    ).toBe(false);
  });

  it("says it can't think in plain words, never the list of every model", () => {
    const fifteen = ["opus", "sonnet", "haiku", "opus-4", "sonnet-4"].flatMap((m) =>
      ["Claude", "Claude", "Claude"].map((leg, i) => ({ why: `${leg} · ${m}-${i}: paused.` })),
    );
    const said = noThinkerSaid(fifteen);
    expect(said).toBe(
      "every agent that can think is paused or out of quota (Claude is paused). Unpause Claude on the Legs page, or add a model.",
    );
    const chat = cantThinkSaid(new Error(`No Leg can think for The Eye right now: ${said}`));
    expect(chat).toMatch(/^I can't think about this right now: every agent/);
    expect(chat).not.toContain("·");
    expect(
      noThinkerSaid([
        { why: "Claude · opus: paused." },
        { why: "Codex · gpt: the five_hour window is used up." },
      ]),
    ).toBe(
      "every agent that can think is paused or out of quota (Claude is paused; Codex is out of quota). Unpause Claude on the Legs page, or add a model.",
    );
  });
});
