import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobView, WebPlan } from "@oraknid/contracts";
import { createOpenCodeAdapter, startFakeModel } from "@oraknid/leg-opencode";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { afterEach, describe, expect, it } from "vitest";
import type { Router } from "../api/router.ts";
import { type Daemon, startDaemon } from "../daemon.ts";
import { resolvePaths } from "../paths.ts";
import { fakeOs } from "../testing/fake-os.ts";
import { scriptedLeg } from "../testing/scripted-leg.ts";
import type { EyeBrain } from "./brain.ts";

// Phase 2: a job on an OpenCode Leg, and a task handed from a Claude Code
// Leg to an OpenCode one through Silk only. OpenCode really runs; its model
// is a stand-in (ADR-015).
const HAVE = spawnSync("opencode", ["--version"], { encoding: "utf8" }).status === 0;

const PLAN: WebPlan = {
  summary: "A greeting script.",
  tasks: [
    {
      key: "a",
      title: "Write hello.sh",
      instructions: "Create hello.sh, which prints hi.",
      kind: "implement",
      dependsOn: [],
      scope: ["hello.sh"],
      verify: ["sh hello.sh | grep -q hi"],
      requiredCapabilities: ["implementation"],
      difficulty: "low",
    },
  ],
  jobVerify: [],
};

const brain = {
  plan: async () => PLAN,
  replan: async () => PLAN,
  summarize: async () => ({ title: "s", body: "s" }),
  repairCheck: async ({ command }) => ({ broken: false, command, reason: "kept" }),
  evaluate: async () => ({ accepted: true, reason: "ok", missing: [] }),
  triage: async () => {
    throw new Error("unused");
  },
  classifyCommand: async () => ({ decision: "allow" as const, reason: "ok" }),
  interviewRound: async () => ({ done: true, playback: "", questions: [], open: [] }),
} satisfies EyeBrain;

let daemon: Daemon | undefined;
let fake: Awaited<ReturnType<typeof startFakeModel>> | undefined;
afterEach(async () => {
  await daemon?.close();
  await fake?.close();
  daemon = undefined;
});

const sh = (cwd: string, ...a: string[]) => spawnSync("git", a, { cwd, encoding: "utf8" });

async function setup(claudeScript: Parameters<typeof scriptedLeg>[0]) {
  fake = await startFakeModel();
  fake.setMode("tool");
  fake.setCommand("printf 'echo hi\\n' > hello.sh");
  const dir = mkdtempSync(join(tmpdir(), "oraknid-oc-"));
  const claude = scriptedLeg(claudeScript);
  daemon = await startDaemon({
    paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
    port: 0,
    dbFile: ":memory:",
    os: fakeOs({ keychain: true }).os,
    adapters: { "claude-code": claude.adapter, opencode: createOpenCodeAdapter() },
    brain,
    stallCheckMs: 200,
  });
  const api = createORPCClient<RouterClient<Router>>(
    new RPCLink({
      url: `${daemon.url}/api`,
      headers: { authorization: `Bearer ${daemon.cliToken}` },
    }),
  );
  const ws = mkdtempSync(join(tmpdir(), "oraknid-oc-ws-"));
  sh(ws, "init", "-q", "-b", "master");
  sh(ws, "config", "user.email", "me@example.com");
  sh(ws, "config", "user.name", "Me");
  writeFileSync(join(ws, "README.md"), "# demo\n");
  sh(ws, "add", ".");
  sh(ws, "commit", "-qm", "start");
  const project = await api.projects.create({ name: "demo", workspacePath: ws });
  const oc = await api.legs.create({
    kind: "opencode",
    name: "OpenCode — fake",
    config: {
      binary: "opencode",
      providerID: "fake",
      package: "@opencode/ai/providers/openai-compatible",
      baseURL: fake.url,
      models: ["fake-model"],
    },
    secret: "test-key",
  });
  return { api, project, oc, claude, ws, d: daemon };
}

async function until(
  api: { jobs: { get(i: { id: string }): Promise<JobView> } },
  id: string,
  states: string[],
  ms = 30_000,
) {
  const end = Date.now() + ms;
  for (;;) {
    const j = await api.jobs.get({ id });
    if (states.includes(j.state) || Date.now() > end) return j;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(!HAVE)("OpenCode Legs in a job (Phase 2)", () => {
  it("runs a job's task on an OpenCode Leg, verified", async () => {
    const { api, project, oc, ws } = await setup(() => [{ say: "unused" }]);
    expect(oc.health, oc.healthDetail ?? "").toBe("healthy");
    const { id } = await api.jobs.create({
      projectId: project.id,
      goal: "Say hi",
      verify: [],
      autonomy: "standard",
      inputs: [],
      allowedLegIds: [oc.id],
      unsandboxed: false,
    });
    await api.jobs.start({ id });
    const done = await until(api, id, ["completed", "blocked"]);
    expect(done.state, done.blockedReason ?? "").toBe("completed");
    expect(done.tasks[0]?.routing?.leg).toBe("OpenCode — fake");
    const r = await api.jobs.result({ id });
    expect(
      spawnSync("git", ["show", `${r.branch}:hello.sh`], { cwd: ws, encoding: "utf8" }).stdout,
    ).toBe("echo hi\n");
  }, 60_000);

  it("hands a task from a Claude Code Leg to an OpenCode Leg through Silk only (M2.2)", async () => {
    const { api, project, oc, d } = await setup(() => [
      { run: "echo started-by-claude >/dev/null" },
      {
        rateLimit: {
          window: "five_hour",
          scope: "account",
          status: "rejected",
          utilization: 1,
          resetsAt: Date.now() + 3_600_000,
        },
      },
    ]);
    const claude = await api.legs.create({ kind: "claude-code", name: "Claude A", config: {} });
    // Claude Code goes first: OpenCode waits paused until the usage limit.
    await api.legs.pause({ id: oc.id });
    const { id } = await api.jobs.create({
      projectId: project.id,
      goal: "Say hi",
      verify: [],
      autonomy: "standard",
      inputs: [],
      allowedLegIds: [oc.id, claude.id],
      unsandboxed: false,
    });
    await api.jobs.start({ id });
    const blocked = await until(api, id, ["blocked", "completed"]);
    expect(blocked.state).toBe("blocked");
    const handoff = (await api.silk.list({ jobId: id })).find((e) => e.kind === "handoff");
    expect(handoff?.body).toContain("started-by-claude");
    await api.legs.resume({ id: oc.id });
    await api.jobs.resume({ id });
    const done = await until(api, id, ["completed", "blocked"]);
    expect(done.state, done.blockedReason ?? "").toBe("completed");
    expect(done.tasks[0]?.routing?.leg).toBe("OpenCode — fake");
    // The OpenCode Leg started from Silk's handoff, nothing else.
    expect(fake?.requests.some((r) => r.text.includes("started-by-claude"))).toBe(true);
    void d;
    void readFileSync;
  }, 90_000);
});
