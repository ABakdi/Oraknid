import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebPlan } from "@oraknid/contracts";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { describe, expect, it } from "vitest";
import type { Router } from "../api/router.ts";
import { startDaemon } from "../daemon.ts";
import type { EyeBrain } from "../eye/brain.ts";
import { resolvePaths } from "../paths.ts";
import { fakeOs } from "../testing/fake-os.ts";
import { scriptedLeg } from "../testing/scripted-leg.ts";

const sh = (cwd: string, ...a: string[]) =>
  spawnSync("git", a, { cwd, encoding: "utf8" }).stdout.trim();

const PLAN: WebPlan = {
  summary: "s",
  tasks: [
    {
      key: "t1",
      title: "Write hello.sh",
      instructions: "x",
      kind: "implement",
      dependsOn: [],
      scope: ["hello.sh"],
      verify: ["true"],
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
  pickSkill: async ({ skills }) => ({ skillId: skills[0]?.id ?? "", reason: "first" }),
  evaluate: async () => ({ accepted: true, reason: "ok", missing: [] }),
  triage: async () => {
    throw new Error("unused");
  },
  classifyCommand: async () => ({ decision: "allow" as const, reason: "ok" }),
  interviewRound: async () => ({ done: true, playback: "", questions: [], open: [] }),
} satisfies EyeBrain;

describe("after a restart (Audit 1 → D1-03)", () => {
  it("tells me Oraknid recovered, through the notification router", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oraknid-restart-"));
    const ws = mkdtempSync(join(tmpdir(), "oraknid-restart-ws-"));
    sh(ws, "init", "-q", "-b", "master");
    sh(ws, "config", "user.email", "a@b");
    sh(ws, "config", "user.name", "A");
    writeFileSync(join(ws, "README.md"), "x\n");
    sh(ws, "add", ".");
    sh(ws, "commit", "-qm", "s");
    const leg = scriptedLeg(() => [{ hang: true }]);
    const start = (os = fakeOs({ keychain: true })) =>
      startDaemon({
        paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
        port: 0,
        dbFile: join(dir, "o.db"),
        os: os.os,
        adapters: { "claude-code": leg.adapter },
        brain,
        stallCheckMs: 100,
      }).then((d) => ({ d, os }));
    const { d } = await start();
    const api = createORPCClient<RouterClient<Router>>(
      new RPCLink({ url: `${d.url}/api`, headers: { authorization: `Bearer ${d.cliToken}` } }),
    );
    await api.legs.create({ kind: "claude-code", name: "A", config: {} });
    const project = await api.projects.create({ name: "demo", workspacePath: ws });
    const { id } = await api.jobs.create({
      projectId: project.id,
      goal: "g",
      verify: [],
      autonomy: "standard",
      inputs: [],
      allowedLegIds: [],
      unsandboxed: false,
    });
    await api.jobs.start({ id });
    const end = Date.now() + 5000;
    while ((await api.jobs.get({ id })).tasks[0]?.state !== "running" && Date.now() < end)
      await new Promise((r) => setTimeout(r, 20));
    await d.close();

    const again = await start();
    const until = Date.now() + 3000;
    while (!again.os.sent.length && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    expect(again.os.sent.map((s) => s.n.title)).toContain("Oraknid recovered");
    await again.d.close();
  });
});
