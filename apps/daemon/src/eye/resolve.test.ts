import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EyeMessage, WebPlan } from "@oraknid/contracts";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { afterEach, describe, expect, it } from "vitest";
import type { Router } from "../api/router.ts";
import { type Daemon, startDaemon } from "../daemon.ts";
import { resolvePaths } from "../paths.ts";
import { fakeOs } from "../testing/fake-os.ts";
import { fakeServerTools } from "../testing/fake-server-tools.ts";
import { fakeSsh } from "../testing/fake-ssh.ts";
import { scriptedLeg } from "../testing/scripted-leg.ts";
import type { EyeBrain, EyeTriage, ServerTalk, ServerTalkInput, TriageInput } from "./brain.ts";
import { earlierJob, namesIn } from "./lookup.ts";

// Resolving what The Eye doesn't know, and cancelling from the chat (after
// the piano chat of 2026-10-07): "start another job to stop and remove
// misahaty…" in the piano project, where misahaty runs on a server.

let daemon: Daemon | undefined;
const closing: (() => Promise<void>)[] = [];
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  for (const c of closing.splice(0)) await c();
});

const REMOVE: WebPlan = {
  summary: "Back up misahaty's data, then remove its compose project.",
  tasks: [
    {
      key: "t1",
      title: "Remove the misahaty compose project",
      instructions: "Back up its volumes, then docker compose down -v.",
      kind: "implement",
      dependsOn: [],
      scope: ["notes/**"],
      verify: ["ssh oraknid-vps-one true"],
      requiredCapabilities: ["implementation"],
      difficulty: "low",
    },
  ],
  jobVerify: [],
};

const PIANO: WebPlan = {
  summary: "The keys.",
  tasks: [
    {
      key: "t1",
      title: "Build the keys",
      instructions: "Build the keyboard.",
      kind: "implement",
      dependsOn: [],
      scope: ["keys.txt"],
      verify: ["test -s keys.txt"],
      requiredCapabilities: ["implementation"],
      difficulty: "low",
    },
  ],
  jobVerify: [],
};

/** What The Eye said when it didn't know (the piano chat, 2026-10-07). */
const PUZZLED: EyeTriage = {
  intent: "question",
  reply:
    "I need clarification on what misahaty is, where it's deployed, and which containers and data you mean.",
  silk: null,
  tasks: [],
};

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "oraknid-resolve-"));
  const sh = (...a: string[]) => spawnSync("git", a, { cwd: dir });
  sh("init", "-q", "-b", "master");
  sh("config", "user.email", "me@example.com");
  sh("config", "user.name", "Me");
  writeFileSync(join(dir, "README.md"), "# piano\n");
  sh("add", ".");
  sh("commit", "-qm", "start");
  return dir;
}

async function rig(o: {
  triage?: (message: string, input: TriageInput) => EyeTriage;
  talk?: (message: string, input: ServerTalkInput) => ServerTalk;
}) {
  const ssh = await fakeSsh({ password: "pw", path: fakeServerTools() });
  closing.push(ssh.close);
  const leg = scriptedLeg(() => [{ run: "sleep 5" }, { say: "DONE" }]);
  const dir = mkdtempSync(join(tmpdir(), "oraknid-resolve-data-"));
  const triaged: TriageInput[] = [];
  const talked: ServerTalkInput[] = [];
  const brain: EyeBrain = {
    // The piano's jobs plan piano work: what they learn names no server's things.
    plan: async ({ goal }) => (/misahaty/i.test(goal) ? REMOVE : PIANO),
    replan: async ({ goal }) => (/misahaty/i.test(goal) ? REMOVE : PIANO),
    summarize: async () => ({ title: "s", body: "s" }),
    helperTurn: async () => ({ reply: "ok", actions: [] }),
    serverState: async ({ name }) => ({
      document: `# ${name}\n\nCompose projects: misahaty (app, postgres), with volumes misahaty_db and misahaty_media.`,
    }),
    pickSkill: async ({ skills }) => ({ skillId: skills[0]?.id ?? "", reason: "first" }),
    repairCheck: async ({ command }) => ({ broken: false, command, reason: "the work" }),
    evaluate: async () => ({ accepted: true, reason: "there", missing: [] }),
    triage: async (input) => {
      triaged.push(input);
      return (o.triage ?? (() => PUZZLED))(input.message, input);
    },
    judgeAction: async () => ({ decision: "allow" as const, category: null, reason: "fine" }),
    interviewRound: async () => ({ done: true, playback: "", questions: [], open: [] }),
    serverTalk: async (input) => {
      talked.push(input);
      return (
        o.talk ??
        (() => ({
          intent: "work" as const,
          reply: "I'll do that on the server.",
          goal: "Stop and remove the misahaty containers and their data",
        }))
      )(input.message, input);
    },
  };
  daemon = await startDaemon({
    paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
    port: 0,
    dbFile: ":memory:",
    os: fakeOs({ keychain: true }).os,
    adapters: { "claude-code": leg.adapter },
    brain,
    metricsIntervalMs: 50,
    stallCheckMs: 100,
    serverSampleSec: 3600,
  });
  const api = createORPCClient<RouterClient<Router>>(
    new RPCLink({
      url: `${daemon.url}/api`,
      headers: { authorization: `Bearer ${daemon.cliToken}` },
    }),
  );
  await api.legs.create({ kind: "claude-code", name: "Claude A", config: {} });
  const addServer = (name: string) =>
    api.servers.add({
      name,
      host: "127.0.0.1",
      port: ssh.port,
      user: "me",
      description: "",
      password: "pw",
    });
  const piano = await api.projects.create({ name: "piano", workspacePath: repo() });
  return { api, addServer, piano, triaged, talked, d: daemon };
}

type Api = Awaited<ReturnType<typeof rig>>["api"];

async function waitFor<T>(
  what: string,
  fn: () => Promise<T | undefined | null | false>,
  ms = 15_000,
) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`no ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const ended = (api: Api, id: string) =>
  waitFor(`the end of ${id}`, async () => {
    const j = await api.jobs.get({ id });
    return ["cancelled", "completed"].includes(j.state) ? j : null;
  });

/** The Eye's `n`th reply to me in the project (not its own reports; its first is the first job's start). */
const replyAfter = (api: Api, projectId: string, n: number) =>
  waitFor("a reply", async () => {
    const list = (await api.projects.conversation({ id: projectId })).filter(
      (m) => m.author === "eye" && m.action?.intent !== "report",
    );
    return list.length >= n ? (list.at(-1) as EyeMessage) : null;
  });

/** The piano project with a job that ended: the conversation goes to it, as the owner's did. */
async function pianoWithEndedJob(api: Api, projectId: string) {
  const first = await api.projects.talk({ id: projectId, text: "Build the piano keys" });
  await api.jobs.cancel({ id: first.jobId });
  await ended(api, first.jobId);
  return first.jobId;
}

describe("cancelling from the chat", () => {
  it("cancels a server job waiting for its plan approval: the approval is withdrawn, the chat says so", async () => {
    const { api, addServer } = await rig({});
    const server = await addServer("spinet-staging");
    await api.servers.setup({ id: server.id });
    const sent = await api.servers.talk({ id: server.id, text: "back up and remove misahaty" });
    const job = await waitFor(
      "a server job",
      async () => (await api.jobs.list({ projectId: sent.projectId }))[0],
    );
    const approval = await waitFor("the plan approval", async () =>
      (await api.inbox.list({ state: "open" })).find((i) => i.jobId === job.id),
    );
    expect(approval.title).toBe("Approve what will change on spinet-staging");
    // Cancel, without answering it.
    await api.jobs.cancel({ id: job.id, reason: "Cancelled from the chat." });
    expect((await ended(api, job.id)).state).toBe("cancelled");
    await waitFor("the approval withdrawn", async () =>
      (await api.inbox.list({ state: "withdrawn" })).some((i) => i.id === approval.id),
    );
    expect((await api.inbox.list({ state: "open" })).filter((i) => i.jobId === job.id)).toEqual([]);
    await expect(api.inbox.answer({ id: approval.id, answer: "Approve" })).rejects.toThrow(
      /withdrawn/,
    );
    // The line in the server's chat.
    const line = await waitFor("the cancelled line", async () =>
      (await api.servers.conversation({ id: server.id })).find(
        (m) => m.action?.report?.kind === "cancelled",
      ),
    );
    expect(line.text).toBe(
      "The job is stopped: Cancelled from the chat. The work so far stays in its folder.",
    );
  }, 60_000);
});

describe("resolving what The Eye doesn't know", () => {
  it("takes “remove misahaty” from the piano chat to the server it runs on, as a new try at the cancelled job there", async () => {
    const { api, addServer, piano, triaged, talked } = await rig({});
    const server = await addServer("spinet-staging");
    await api.servers.setup({ id: server.id });
    // The earlier job, in the server's chat: cancelled before its plan was approved.
    const sent = await api.servers.talk({
      id: server.id,
      text: "Back up and remove misahaty compose project",
    });
    const earlier = await waitFor(
      "the earlier job",
      async () => (await api.jobs.list({ projectId: sent.projectId }))[0],
    );
    await api.jobs.cancel({ id: earlier.id });
    await ended(api, earlier.id);
    expect(earlier.goal).toBe("Stop and remove the misahaty containers and their data");

    await pianoWithEndedJob(api, piano.id);
    await api.projects.talk({
      id: piano.id,
      text: "start another job to stop and remove misahaty related container and data",
    });
    const reply = await replyAfter(api, piano.id, 2);
    // The triage was told where misahaty is, and the piano's own recent jobs.
    const asked = triaged.at(-1) as TriageInput;
    expect(asked.elsewhere).toContain(`[server:${server.id}] the server spinet-staging`);
    expect(asked.elsewhere).toContain("its state document");
    expect(asked.recent).toContain("“Build the piano keys” (cancelled");
    // It said where, and took it there.
    expect(reply.text).toContain("**misahaty** runs on spinet-staging (its state document");
    expect(reply.text).toContain("I've taken this to spinet-staging's chat");
    expect(reply.action?.did).toEqual(["Taken to spinet-staging's chat"]);
    expect(reply.action?.place).toMatchObject({
      kind: "server",
      id: server.id,
      name: "spinet-staging",
      projectId: sent.projectId,
    });
    // A server job there, a new try that carries the cancelled one's goal, waiting for my approval.
    const job = await api.jobs.get({ id: reply.action?.jobId as string });
    expect(job.projectId).toBe(sent.projectId);
    expect(job.id).not.toBe(earlier.id);
    expect(job.goal).toContain("This is another try at an earlier job");
    expect(job.goal).toContain("> Stop and remove the misahaty containers and their data");
    expect(job.goal).toContain("(cancelled");
    const approval = await waitFor("its plan approval", async () =>
      (await api.inbox.list({ state: "open" })).find((i) => i.jobId === job.id),
    );
    expect(approval.title).toBe("Approve what will change on spinet-staging");
    // The server's Eye read it there, knowing the jobs of its chat; it says where it came from.
    expect(talked.at(-1)?.recent).toContain("(cancelled");
    const there = await api.servers.conversation({ id: server.id });
    expect(there.find((m) => m.author === "owner" && m.jobId === job.id)?.text).toBe(
      "start another job to stop and remove misahaty related container and data",
    );
    expect(
      there.find((m) => m.author === "eye" && m.jobId === job.id && m.action?.intent === "task")
        ?.text,
    ).toContain("(You asked in piano's chat; I brought it here.)");
  }, 60_000);

  it("still asks when nothing in Oraknid knows the name", async () => {
    const { api, piano } = await rig({
      triage: () => ({ ...PUZZLED, reply: "What is zorblax, and where does it run?" }),
    });
    await pianoWithEndedJob(api, piano.id);
    await api.projects.talk({ id: piano.id, text: "remove the zorblax container" });
    const reply = await replyAfter(api, piano.id, 2);
    expect(reply.text).toBe("What is zorblax, and where does it run?");
    expect(reply.action?.place).toBeUndefined();
  }, 60_000);

  it("asks which one when the name is on two servers, those servers as options, then takes it to the one I chose", async () => {
    const { api, addServer, piano, triaged } = await rig({});
    const a = await addServer("spinet-staging");
    const b = await addServer("spinet-prod");
    await api.servers.editState({ id: a.id, body: "# spinet-staging\n\nmisahaty (compose)." });
    await api.servers.editState({ id: b.id, body: "# spinet-prod\n\nmisahaty (compose)." });
    await pianoWithEndedJob(api, piano.id);
    await api.projects.talk({ id: piano.id, text: "remove misahaty and its data" });
    const reply = await replyAfter(api, piano.id, 2);
    expect(triaged.at(-1)?.elsewhere?.split("\n")).toHaveLength(2);
    expect(reply.text).toContain("I found **misahaty** in more than one place");
    const q = reply.questions?.[0];
    expect(q?.id).toBe("where");
    expect(q?.options.map((x) => [x.id, x.label])).toEqual([
      [`server:${b.id}`, "spinet-prod"],
      [`server:${a.id}`, "spinet-staging"],
      ["here", "Here, in piano"],
    ]);
    await api.projects.answer({
      id: piano.id,
      messageId: reply.id,
      answers: [{ questionId: "where", options: [`server:${a.id}`], text: "" }],
    });
    const taken = await replyAfter(api, piano.id, 3);
    expect(taken.action?.place).toMatchObject({ kind: "server", id: a.id });
    expect(taken.text).toContain("I've taken this to spinet-staging's chat");
    // spinet-staging isn't set up: its chat says so, the request is there.
    const there = await waitFor("the server's reply", async () => {
      const l = await api.servers.conversation({ id: a.id });
      return l.some((m) => m.author === "eye") ? l : null;
    });
    expect(there.map((m) => [m.author, m.text.slice(0, 40)])).toEqual([
      ["owner", "remove misahaty and its data"],
      ["eye", "spinet-staging isn't set up yet, so no j"],
    ]);
  }, 60_000);

  it("carries an earlier job's goal into “start another job” in a project", async () => {
    const { api, piano } = await rig({
      triage: (m) =>
        /metronome/.test(m)
          ? { intent: "task", reply: "Another go at it.", silk: null, tasks: [] }
          : PUZZLED,
    });
    const first = await api.projects.talk({
      id: piano.id,
      text: "Add a metronome with a tap tempo",
    });
    await api.jobs.cancel({ id: first.jobId, reason: "Not now." });
    await ended(api, first.jobId);
    await api.projects.talk({ id: piano.id, text: "start another job for the metronome" });
    const reply = await replyAfter(api, piano.id, 2);
    expect(reply.action?.did).toEqual(["Started a follow-up job"]);
    const next = await api.jobs.get({ id: reply.action?.jobId as string });
    expect(next.goal).toContain("This is another try at an earlier job");
    expect(next.goal).toContain("> Add a metronome with a tap tempo");
    expect(next.goal).toContain("(cancelled: Not now)");
  }, 60_000);
});

describe("the pieces", () => {
  it("reads names, not everyday words", () => {
    expect(
      namesIn("start another job to stop and remove misahaty related container and data"),
    ).toEqual(["misahaty"]);
    expect(namesIn("Deploy spinet-web to staging, and nginx too")).toEqual(["spinet-web", "nginx"]);
  });

  it("refers back only when the words say so", () => {
    // Without a database, nothing to find: the words alone decide whether it looks.
    const db = { select: () => ({}) } as never;
    expect(earlierJob(db, "p", "add a dark theme")).toBeNull();
  });
});
