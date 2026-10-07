import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HelperAction } from "@oraknid/contracts";
import type { LegAdapter } from "@oraknid/leg-sdk";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Router } from "../api/router.ts";
import { type Daemon, startDaemon } from "../daemon.ts";
import { jobs } from "../db/schema.ts";
import type { EyeBrain, HelperTurn } from "../eye/brain.ts";
import { resolvePaths } from "../paths.ts";
import { type FakeGitHub, startFakeGitHub } from "../testing/fake-github.ts";
import { fakeOs } from "../testing/fake-os.ts";
import { seedJob } from "../testing/fixtures.ts";
import { scriptedLeg } from "../testing/scripted-leg.ts";

// The helper's actions that are the UI's own procedures (ADR-024, M8.7):
// settings by name, a draft, waivers, the inbox, chats, GitHub repos,
// finding agents, deleting; home only where the UI is (ADR-030).

// Finding agents looks at this machine: a stand-in here, never my real programs.
vi.mock("../legs/discover.ts", async (original) => ({
  ...(await original<typeof import("../legs/discover.ts")>()),
  discoverAgents: async () => [
    {
      kind: "claude-code",
      label: "Claude Code 9.9.9",
      where: "/opt/claude",
      detail: "logged out",
      suggestedName: "Claude Code",
      config: { binary: "/opt/claude" },
      usedBy: [],
    },
  ],
}));

let daemon: Daemon | undefined;
let gh: FakeGitHub | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  await gh?.close();
  gh = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const temp = (name: string) => {
  const d = mkdtempSync(join(tmpdir(), `oraknid-helper-${name}-`));
  dirs.push(d);
  return d;
};

type Turn = (prompt: string, n: number) => HelperTurn;
type Planned = { name: string; input: unknown };
const AWAY = { device: "01J9Z3K8W2Q4V6X8Y0A1B2C3DV", remote: true, full: false };
const AWAY_FULL = { ...AWAY, full: true };

async function boot(o: { adapters?: Record<string, LegAdapter>; github?: boolean } = {}) {
  const dir = temp("data");
  let script: Turn = () => ({ reply: "Nothing.", actions: [] });
  let n = 0;
  const brain = {
    helperTurn: async ({ prompt }: { prompt: string }) => script(prompt, ++n),
  } as unknown as EyeBrain;
  if (o.github) gh = await startFakeGitHub();
  daemon = await startDaemon({
    paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
    port: 0,
    dbFile: ":memory:",
    os: fakeOs({ keychain: true }).os,
    adapters: o.adapters ?? {},
    brain,
    ...(gh ? { github: { api: gh.api } } : {}),
  });
  const d = daemon;
  const api = createORPCClient<RouterClient<Router>>(
    new RPCLink({ url: `${d.url}/api`, headers: { authorization: `Bearer ${d.cliToken}` } }),
  );
  /** One request: these actions in the first round, then nothing; what the helper made of them. */
  const ask = async (
    actions: Planned[],
    who?: { device: string | null; remote: boolean; full: boolean },
  ): Promise<{ id: string; actions: HelperAction[] }> => {
    n = 0;
    script = (_p, k) =>
      k === 1
        ? {
            reply: "On it.",
            actions: actions.map((a) => ({ ...a, summary: a.name })) as HelperTurn["actions"],
          }
        : { reply: "Done.", actions: [] };
    const before = d.helper.conversation().length;
    d.helper.send("Please.", {}, who);
    const end = Date.now() + 10_000;
    while (d.helper.thinking() || d.helper.conversation().length < before + 2) {
      if (Date.now() > end) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 20));
    }
    const m = d.helper.conversation()[before + 1];
    return { id: m?.id as string, actions: m?.actions ?? [] };
  };
  return { d, api, ask };
}

const states = (a: HelperAction[]) => a.map((x) => x.state);

describe("the helper's actions through Oraknid's API (ADR-024)", () => {
  it("changes a setting by its name, with the Settings page's validation", async () => {
    const { api, ask } = await boot();
    const r = await ask([
      { name: "set_setting", input: { name: "jobs_at_once", value: 4 } },
      { name: "set_setting", input: { name: "jobs_at_once", value: 99 } },
      { name: "set_setting", input: { name: "no_such_setting", value: 1 } },
      { name: "set_setting", input: { name: "terminal", value: "yes" } },
      { name: "set_setting", input: { name: "interview_rounds", value: 5 } },
      { name: "set_setting", input: { name: "approvals_policy", value: { allow: [], deny: [] } } },
    ]);
    expect(states(r.actions)).toEqual(["done", "failed", "failed", "failed", "done", "proposed"]);
    expect(r.actions[1]?.result).toMatch(/^Its input was wrong: max: /);
    expect(r.actions[2]?.result).toMatch(/^Its input was wrong: name/);
    expect(r.actions[3]?.result).toMatch(/value was wrong for terminal/);
    expect(await api.settings.maxRunningJobs()).toBe(4);
    expect(await api.settings.interviewRounds()).toBe(5);
    // The page's own audit: the same event as a change from the page.
    const audit = await api.audit.search({ type: "settings.updated" });
    expect(audit.map((e) => e.payload)).toContainEqual({ maxRunningJobs: 4 });
  }, 30_000);

  it("edits a draft at once, and waives a gate or deletes only on my Confirm", async () => {
    const { d, api, ask } = await boot();
    const jobId = seedJob(d.db, "draft");
    const r = await ask([
      {
        name: "edit_draft",
        input: { id: jobId, goal: "Make the piano louder", autonomy: "careful" },
      },
      { name: "waive_gate", input: { jobId, waived: ["push"] } },
      { name: "delete_job", input: { jobId } },
    ]);
    expect(states(r.actions)).toEqual(["done", "proposed", "proposed"]);
    const job = () => d.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    expect(job()).toMatchObject({ goal: "Make the piano louder", autonomy: "careful" });
    expect(job()?.waived ?? []).toEqual([]);
    expect((await d.helper.decide(r.id, 1, true)).state).toBe("done");
    expect(job()?.waived).toEqual(["push"]);
    expect((await api.audit.search({ type: "policy.waived" })).length).toBe(1);
    expect((await d.helper.decide(r.id, 2, false)).state).toBe("cancelled");
    expect(job()).toBeDefined();
    await expect(d.helper.decide(r.id, 2, true)).rejects.toThrow(/already settled/);
  }, 30_000);

  it("answers a question at once, and an approval only on my Confirm", async () => {
    const { d, ask } = await boot();
    const jobId = seedJob(d.db, "running");
    const raise = (kind: "approval" | "question", options: string[]) =>
      d.inbox.open({ jobId, kind, title: `A ${kind}`, detail: "", options, raisedBy: "eye" });
    const question = raise("question", ["Blue", "Green"]);
    const approval = raise("approval", ["Approve", "Deny"]);
    const r = await ask([
      { name: "answer_inbox", input: { id: question, answer: "Blue" } },
      { name: "answer_inbox", input: { id: approval, answer: "Approve" } },
    ]);
    expect(states(r.actions)).toEqual(["done", "proposed"]);
    expect(d.inbox.get(question)).toMatchObject({ state: "answered", answer: "Blue" });
    expect(d.inbox.get(approval)?.state).toBe("open");
    expect((await d.helper.decide(r.id, 1, true)).state).toBe("done");
    expect(d.inbox.get(approval)).toMatchObject({ state: "answered", answer: "Approve" });
  }, 30_000);

  it("keeps home-only actions at home, unless the device has full rights, and audits that use", async () => {
    const { d, api, ask } = await boot();
    const folder = temp("project");
    const project = await api.projects.create({
      name: "Piano",
      workspacePath: folder,
      initGit: true,
    });
    const r = await ask(
      [
        { name: "delete_project", input: { id: project.id } },
        { name: "set_setting", input: { name: "terminal", value: true } },
        { name: "set_setting", input: { name: "jobs_at_once", value: 3 } },
      ],
      AWAY,
    );
    expect(states(r.actions)).toEqual(["proposed", "failed", "done"]);
    expect(r.actions[1]?.result).toMatch(/computer running Oraknid/);
    expect(await api.settings.terminal()).toBe(false);
    // A standard device away can't confirm it either.
    await expect(d.helper.decide(r.id, 0, true, AWAY)).rejects.toThrow(/computer running Oraknid/);
    expect((await api.projects.list()).map((p) => p.id)).toContain(project.id);
    // With full rights it can, and that use is in the audit log (ADR-030).
    expect((await d.helper.decide(r.id, 0, true, AWAY_FULL)).state).toBe("done");
    expect((await api.projects.list()).map((p) => p.id)).not.toContain(project.id);
    const used = await api.audit.search({ type: "device.awayUse" });
    expect(used.map((e) => e.payload)).toContainEqual({
      device: AWAY.device,
      path: "/projects/delete",
      via: "helper",
    });
    // A setting that is home only, from a full-rights device: done, and audited.
    const t = await ask(
      [{ name: "set_setting", input: { name: "terminal", value: true } }],
      AWAY_FULL,
    );
    expect(states(t.actions)).toEqual(["done"]);
    expect(await api.settings.terminal()).toBe(true);
    expect((await api.audit.search({ type: "device.awayUse" })).length).toBe(2);
  }, 30_000);

  it("finds agents, reads my GitHub repos, and opens, continues and deletes a chat", async () => {
    const leg = scriptedLeg((t) => [{ say: t.turn === 1 ? "Hello there." : "Again." }]);
    const { d, api, ask } = await boot({ adapters: { "claude-code": leg.adapter }, github: true });
    await api.github.addAccount({ token: "good-token" });
    await api.legs.create({ kind: "claude-code", name: "Claude", config: {} });
    await d.health.checkAll();
    const model = (await api.legs.list())[0]?.models.find((m) => m.model === "sonnet");
    const r = await ask([
      { name: "find_agents", input: {} },
      { name: "github_repos", input: {} },
      { name: "open_chat", input: { legModelId: model?.id, text: "Say hello" } },
    ]);
    expect(states(r.actions)).toEqual(["done", "done", "done"]);
    expect(r.actions[0]?.result).toBe("1 found.");
    expect(r.actions[1]?.result).toMatch(/^\d+ repos?\.$/);
    const chats = await api.chats.list();
    expect(chats).toHaveLength(1);
    const chatId = chats[0]?.id as string;
    expect(r.actions[2]?.link).toBe(`/chats/${chatId}`);
    const answered = async (n: number) => {
      const end = Date.now() + 5000;
      for (;;) {
        const c = await api.chats.get({ id: chatId });
        if (c.messages.length >= n && !c.chat.answering) return c.messages;
        if (Date.now() > end) throw new Error("no answer");
        await new Promise((ok) => setTimeout(ok, 20));
      }
    };
    expect((await answered(2)).at(-1)?.text).toBe("Hello there.");
    const more = await ask([
      { name: "continue_chat", input: { chatId, text: "Once more" } },
      { name: "list_chats", input: {} },
      { name: "delete_chat", input: { id: chatId } },
    ]);
    expect(states(more.actions)).toEqual(["done", "done", "proposed"]);
    expect((await answered(4)).at(-1)?.text).toBe("Again.");
    expect((await d.helper.decide(more.id, 2, true)).state).toBe("done");
    expect(await api.chats.list()).toEqual([]);
  }, 30_000);
});
