import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EyeMessage, WebPlan } from "@oraknid/contracts";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { afterEach, describe, expect, it } from "vitest";
import type { Router } from "../api/router.ts";
import { type Daemon, startDaemon } from "../daemon.ts";
import type { EyeBrain, ServerTalk } from "../eye/brain.ts";
import { resolvePaths } from "../paths.ts";
import { fakeOs } from "../testing/fake-os.ts";
import { fakeServerTools } from "../testing/fake-server-tools.ts";
import { fakeSsh } from "../testing/fake-ssh.ts";
import { type Action, scriptedLeg, type TurnContext } from "../testing/scripted-leg.ts";

// Server chat and server jobs (ADR-049), end to end: a scripted Leg, a
// scripted Eye, the stand-in SSH server with stand-in tools.

let daemon: Daemon | undefined;
const closing: (() => Promise<void>)[] = [];
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  for (const c of closing.splice(0)) await c();
});

/** A systemctl that knows fail2ban once `$HOME/fail2ban` exists (the Leg "installed" it). */
function fail2banTools(): string {
  const bin = mkdtempSync(join(tmpdir(), "oraknid-f2b-tools-"));
  writeFileSync(
    join(bin, "systemctl"),
    `#!/bin/sh
case "$*" in
  "is-active fail2ban") if [ -f "$HOME/fail2ban" ]; then echo active; else echo inactive; exit 3; fi ;;
  *--state=running*) echo nginx.service; [ -f "$HOME/fail2ban" ] && echo fail2ban.service ;;
  "is-active "*) echo active ;;
esac
`,
  );
  chmodSync(join(bin, "systemctl"), 0o755);
  return bin;
}

const INSTALL: WebPlan = {
  summary: "Install fail2ban and enable its sshd jail.",
  tasks: [
    {
      key: "t1",
      title: "Install fail2ban",
      instructions: "Install fail2ban with apt, enable the sshd jail, start it.",
      kind: "implement",
      dependsOn: [],
      scope: ["notes/**"],
      verify: ["ssh oraknid-vps-one systemctl is-active fail2ban"],
      requiredCapabilities: ["implementation"],
      difficulty: "low",
    },
  ],
  jobVerify: [],
};

/** A docker in front of the stand-in's that has two Harvest containers up. */
function harvestTools(fakes: string): string {
  const bin = mkdtempSync(join(tmpdir(), "oraknid-harvest-tools-"));
  writeFileSync(
    join(bin, "docker"),
    `#!/bin/sh
case "$*" in
  "ps -q --filter name=harvest-") echo h1h1h1h1h1h1; echo h2h2h2h2h2h2 ;;
  *) exec "${fakes}/docker" "$@" ;;
esac
`,
  );
  chmodSync(join(bin, "docker"), 0o755);
  return bin;
}

async function rig(o: {
  script: (t: TurnContext, home: string) => Action[];
  talk: (message: string) => ServerTalk;
  plan?: WebPlan;
  /** Commands go through the PreToolUse hook first, as Claude Code's in auto mode (ADR-053). */
  hooks?: boolean;
  repairCheck?: EyeBrain["repairCheck"];
}) {
  const fakes = fakeServerTools();
  const ssh = await fakeSsh({
    password: "pw",
    path: `${harvestTools(fakes)}:${fail2banTools()}:${fakes}`,
  });
  closing.push(ssh.close);
  const leg = scriptedLeg((t) => o.script(t, ssh.home), { autoModeHooks: !!o.hooks });
  const dir = mkdtempSync(join(tmpdir(), "oraknid-server-jobs-"));
  const sinces: string[] = [];
  const brain: EyeBrain = {
    plan: async () => o.plan ?? INSTALL,
    replan: async () => {
      throw new Error("no replan");
    },
    summarize: async () => ({ title: "s", body: "s" }),
    helperTurn: async () => ({ reply: "ok", actions: [] }),
    serverState: async ({ name, discovery, since }) => {
      if (since) sinces.push(since);
      return {
        document: `# ${name}\n\nServices: nginx${/fail2ban/.test(discovery) ? ", fail2ban" : ""}.`,
      };
    },
    pickSkill: async ({ skills }) => ({ skillId: skills[0]?.id ?? "", reason: "first" }),
    repairCheck:
      o.repairCheck ?? (async ({ command }) => ({ broken: false, command, reason: "the work" })),
    evaluate: async () => ({ accepted: true, reason: "there", missing: [] }),
    triage: async () => {
      throw new Error("no triage scripted");
    },
    judgeAction: async () => ({
      decision: "allow" as const,
      category: null,
      reason: "it serves the task",
    }),
    interviewRound: async () => ({ done: true, playback: "", questions: [], open: [] }),
    serverTalk: async ({ message }) => o.talk(message),
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
  const server = await api.servers.add({
    name: "VPS One",
    host: "127.0.0.1",
    port: ssh.port,
    user: "me",
    description: "My sites: nginx.",
    password: "pw",
  });
  await api.servers.setup({ id: server.id });
  return { api, ssh, leg, server, sinces, dataDir: dir };
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

const eyeSaid = (list: EyeMessage[]) => list.filter((m) => m.author === "eye");
const openItem = (api: Api, title: RegExp) =>
  waitFor(title.source, async () =>
    (await api.inbox.list({ state: "open" })).find((i) => title.test(i.title)),
  );

describe("server chat and server jobs (ADR-049)", () => {
  it("answers a question about the server from its state document, with no job", async () => {
    const { api, server } = await rig({
      script: () => [{ say: "?" }],
      talk: (m) => ({
        intent: "question",
        reply: `Nginx runs there (you asked: ${m}).`,
        goal: null,
      }),
    });
    const sent = await api.servers.talk({ id: server.id, text: "What runs on it?" });
    expect(sent.jobId).toBeNull();
    const list = await waitFor("an answer", async () => {
      const l = await api.servers.conversation({ id: server.id });
      return eyeSaid(l).length ? l : null;
    });
    expect(list.map((m) => [m.author, m.jobId, m.text])).toEqual([
      ["owner", null, "What runs on it?"],
      ["eye", null, "Nginx runs there (you asked: What runs on it?)."],
    ]);
    expect(await api.jobs.list({ projectId: sent.projectId })).toEqual([]);
    // Its own project is hidden from mine, and named on the server.
    expect((await api.projects.list()).find((p) => p.id === sent.projectId)).toBeUndefined();
    expect((await api.projects.get({ id: sent.projectId })).serverId).toBe(server.id);
    const [view] = await api.servers.list();
    expect(view).toMatchObject({ projectId: sent.projectId, projectIds: [], production: false });
  });

  it("sends an agent into the server: a server job, its checks there, a new state document naming its changes, and the report in the chat", async () => {
    const { api, ssh, leg, server, sinces } = await rig({
      script: (t, home) => {
        if (!t.system.includes("# Your task: Install fail2ban")) return [{ say: "?" }];
        // What the Leg's `ssh … 'sudo -n apt-get install -y fail2ban'` did on the server.
        writeFileSync(join(home, "fail2ban"), "");
        return [{ say: "DONE: installed fail2ban 1.1.0 and enabled the sshd jail." }];
      },
      talk: () => ({
        intent: "work",
        reply: "I'll install fail2ban.",
        goal: "Install fail2ban and enable its sshd jail",
      }),
    });
    const sent = await api.servers.talk({ id: server.id, text: "install fail2ban" });
    const job = await waitFor(
      "a server job",
      async () => (await api.jobs.list({ projectId: sent.projectId }))[0],
    );
    expect(job.goal).toBe("Install fail2ban and enable its sshd jail");
    // A job of the server's own project: no repo, the server its one server.
    const project = await api.projects.get({ id: sent.projectId });
    expect(project).toMatchObject({ serverId: server.id, serverIds: [server.id], repos: [] });
    // It says what will change before anything does.
    const approval = await openItem(api, /^Approve what will change on VPS One$/);
    expect(approval.detail).toContain("Install fail2ban");
    expect(approval.jobId).toBe(job.id);
    await api.inbox.answer({ id: approval.id, answer: "Approve" });
    const done = await waitFor(
      "the job's end",
      async () => {
        const j = await api.jobs.get({ id: job.id });
        return ["completed", "blocked", "cancelled"].includes(j.state) ? j : null;
      },
      30_000,
    );
    expect(done.state, done.blockedReason ?? "").toBe("completed");
    // The session had the state document, the alias and its place.
    const turn = leg.log.find((t) => t.system.includes("# Servers this job may use"));
    expect(turn?.system).toContain(
      "## VPS One — **the server for this job's work** — `ssh oraknid-vps-one`",
    );
    expect(turn?.system).toContain("Services: nginx.");
    expect(turn?.system).toContain("**This job's place is the server VPS One**");
    expect(turn?.system).toMatch(/The aliases are in `\S+\/\.ssh\/config`/);
    // No repo, no GitHub: its place is the server.
    expect(turn?.system).not.toContain("# GitHub");
    // Its check ran on the server, over Oraknid's own connection.
    expect(ssh.commands).toContain("systemctl is-active fail2ban");
    // A new discovery: a new version naming the job and what it changed.
    const history = await api.servers.history({ id: server.id });
    expect(history[0]).toMatchObject({ source: "eye", jobId: job.id, jobTitle: done.title });
    const state = await api.servers.state({ id: server.id });
    expect(state?.body).toContain("Services: nginx, fail2ban.");
    expect(state?.body).toContain(`## Changes by job “${done.title}”`);
    expect(state?.body).toContain(
      "- Install fail2ban (checked: `ssh oraknid-vps-one systemctl is-active fail2ban`)",
    );
    expect(sinces.at(-1)).toContain("- Install fail2ban");
    // The Eye's report in the server's conversation, with the document's diff.
    const report = await waitFor("the report", async () =>
      (await api.servers.conversation({ id: server.id })).find(
        (m) => m.action?.report?.kind === "job-done",
      ),
    );
    expect(report.text).toContain("What changed in VPS One's state document");
    expect(report.text).toMatch(/```diff\n[\s\S]*\+Services: nginx, fail2ban\./);
    expect(report.action?.report?.facts).toContainEqual({
      label: "State document",
      value: `VPS One · version ${state?.version}`,
      href: `/servers/${server.id}/state`,
    });
    // My message belongs to the job it started.
    const mine = (await api.servers.conversation({ id: server.id })).find(
      (m) => m.author === "owner",
    );
    expect(mine?.jobId).toBe(job.id);
  }, 60_000);

  it("asks before any change on a production server, even at Full autonomy", async () => {
    const { api, server } = await rig({
      script: (t) =>
        t.system.includes("# Your task: Restart nginx") && t.turn === 1
          ? [{ run: "ssh oraknid-vps-one 'sudo -n systemctl restart nginx'" }, { say: "DONE" }]
          : [{ say: "DONE" }],
      talk: () => ({ intent: "work", reply: "I'll restart it.", goal: "Restart nginx" }),
      plan: {
        summary: "Restart nginx.",
        tasks: [
          {
            key: "t1",
            title: "Restart nginx",
            instructions: "Restart nginx.",
            kind: "implement",
            dependsOn: [],
            scope: ["notes/**"],
            verify: [],
            requiredCapabilities: ["implementation"],
            difficulty: "low",
          },
        ],
        jobVerify: [],
      },
    });
    const marked = await api.servers.setProduction({ id: server.id, production: true });
    expect(marked.production).toBe(true);
    const sent = await api.servers.talk({ id: server.id, text: "restart nginx" });
    const job = await waitFor(
      "a server job",
      async () => (await api.jobs.list({ projectId: sent.projectId }))[0],
    );
    await api.jobs.setAutonomy({ id: job.id, autonomy: "full" });
    // The plan asks even at Full: the server is production.
    const plan = await openItem(api, /^Approve what will change on VPS One/);
    await api.inbox.answer({ id: plan.id, answer: "Approve" });
    // And the command that changes it asks, saying why.
    const ask = await openItem(api, /wants to run `ssh oraknid-vps-one/);
    expect(ask.detail).toContain("it may change VPS One, which is production");
    await api.inbox.answer({ id: ask.id, answer: "Deny" });
  }, 60_000);

  it("auto mode: after the plan, reading the server and checking ports asks nothing (ADR-053)", async () => {
    const { api, server } = await rig({
      script: (t) =>
        t.system.includes("# Your task: Look at the stack") && t.turn === 1
          ? [
              {
                run: "ssh -o ConnectTimeout=1 oraknid-vps-one 'cd /root/spinet-deploy && docker compose -p spinet-deploy ps -a' 2>/dev/null; true",
              },
              {
                run: "ssh -o ConnectTimeout=1 oraknid-vps-one 'docker logs --tail 50 api' 2>/dev/null; true",
              },
              { run: "test -s notes/change-plan.md; true" },
              { run: "nc -z -w1 127.0.0.1 9; true" },
              { say: "DONE" },
            ]
          : [{ say: "DONE" }],
      talk: () => ({ intent: "work", reply: "I'll look.", goal: "Look at the stack" }),
      plan: {
        summary: "Look at the stack.",
        tasks: [
          {
            key: "t1",
            title: "Look at the stack",
            instructions: "Read what runs.",
            kind: "implement",
            dependsOn: [],
            scope: ["notes/**"],
            verify: [],
            requiredCapabilities: ["implementation"],
            difficulty: "low",
          },
        ],
        jobVerify: [],
      },
    });
    const sent = await api.servers.talk({ id: server.id, text: "look at the stack" });
    const job = await waitFor(
      "a server job",
      async () => (await api.jobs.list({ projectId: sent.projectId }))[0],
    );
    expect(job.autonomy).toBe("auto");
    const plan = await openItem(api, /^Approve what will change on VPS One/);
    await api.inbox.answer({ id: plan.id, answer: "Approve" });
    await waitFor("the job's end", async () => {
      const j = await api.jobs.get({ id: job.id });
      return j.state === "completed" || j.state === "blocked" ? j : null;
    });
    // One approval: the plan's. Every command was settled by the rules, none by the judge.
    expect((await api.inbox.list({})).filter((i) => i.kind === "approval")).toHaveLength(1);
    const decisions = (
      await api.audit.search({ jobId: job.id, type: "policy.decision", limit: 100 })
    )
      .map((e) => e.payload as { action: string; layer: string; verdict: string })
      .filter((p) => p.layer !== "owner");
    expect(decisions.length).toBeGreaterThanOrEqual(4);
    for (const p of decisions)
      expect(p, JSON.stringify(p)).toMatchObject({ layer: "rules", verdict: "allow" });
  }, 60_000);

  it("refuses work on a server away from home on a standard device (lock.ts)", async () => {
    const { HOME_ONLY } = await import("../auth/lock.ts");
    for (const p of ["/servers/talk", "/servers/answer", "/servers/setProduction"])
      expect(HOME_ONLY).toContain(p);
  });
});

// 2026-10-07: two server jobs of mine ended in "keeps going wrong", the real
// reason hidden. A plan's own change blocked by layer 1, the stuck rule silent
// through Claude Code's hook, a check with the job's own ssh setup.

/** A one-task plan for a removal on VPS One, its words and checks given. */
const removal = (instructions: string, verify: string[], title = "Remove Misahaty"): WebPlan => ({
  summary: `${title}.`,
  tasks: [
    {
      key: "t1",
      title,
      instructions,
      kind: "implement",
      dependsOn: [],
      scope: ["notes/**"],
      verify,
      requiredCapabilities: ["implementation"],
      difficulty: "low",
    },
  ],
  jobVerify: [],
});

/** An ssh to VPS One as the agent writes it, with its own ssh config. */
const agentSsh = (t: TurnContext, remote: string) =>
  `ssh -F ${t.home ?? "/x"}/.ssh/config oraknid-vps-one '${remote}'`;

/** Starts the job from the chat, approves its plan, and gives the job. */
async function startRemoval(api: Api, serverId: string) {
  const sent = await api.servers.talk({ id: serverId, text: "remove misahaty" });
  const job = await waitFor(
    "a server job",
    async () => (await api.jobs.list({ projectId: sent.projectId }))[0],
  );
  const plan = await openItem(api, /^Approve what will change on VPS One/);
  await api.inbox.answer({ id: plan.id, answer: "Approve" });
  return job;
}

const ended = (api: Api, jobId: string) =>
  waitFor(
    "the job's end",
    async () => {
      const j = await api.jobs.get({ id: jobId });
      return ["completed", "blocked", "cancelled"].includes(j.state) ? j : null;
    },
    40_000,
  );

const gone = "ssh oraknid-vps-one test ! -e misahaty";

describe("what blocks a server job is asked of me, specifically (2026-10-07)", () => {
  it("a change the approved plan names, blocked by layer 1 through Claude Code's hook, is one approval and runs once; one it doesn't name stays blocked", async () => {
    const { api, server, ssh } = await rig({
      hooks: true,
      script: (t, home) =>
        t.system.includes("# Your task: Remove Misahaty") && t.turn === 1
          ? [
              { run: agentSsh(t, "rm -rf /root/other-app"), instead: () => "removed?!" },
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
      talk: () => ({ intent: "work", reply: "I'll remove it.", goal: "Remove Misahaty" }),
      plan: removal(
        "Stop Misahaty's containers, then delete /root/misahaty (its code and config).",
        [gone],
      ),
    });
    mkdirSync(join(ssh.home, "misahaty"));
    const job = await startRemoval(api, server.id);
    const ask = await openItem(api, /wants to run `rm -rf \/root\/misahaty` on VPS One/);
    expect(ask.title).toBe(
      "Claude A wants to run `rm -rf /root/misahaty` on VPS One, as the plan says",
    );
    expect(ask.questions?.[0]?.prompt).toBe(
      "Claude A wants to run `rm -rf /root/misahaty` on VPS One (in the plan you approved: “Stop Misahaty's containers, then delete /root/misahaty (its code and config).”). Run it?",
    );
    expect(ask.options).toEqual(["Allow", "Keep it blocked"]);
    await api.inbox.answer({ id: ask.id, answer: "Allow" });
    const done = await ended(api, job.id);
    expect(done.state, done.blockedReason ?? "").toBe("completed");
    // The one the plan doesn't name was blocked, never asked.
    const items = await api.inbox.list({});
    expect(items.filter((i) => /other-app/.test(i.title))).toEqual([]);
    const decisions = (
      await api.audit.search({ jobId: job.id, type: "policy.decision", limit: 100 })
    ).map((e) => e.payload as { action: string; layer: string; verdict: string; reason: string });
    expect(decisions.find((p) => p.action.includes("other-app"))).toMatchObject({
      layer: "rules",
      verdict: "block",
    });
    expect(
      decisions.find((p) => p.action.includes("/root/misahaty") && p.layer === "owner"),
    ).toMatchObject({ verdict: "allow", reason: "allowed once: in the plan you approved" });
  }, 60_000);

  it("blocks through Claude Code's hook count toward the stuck rule, and I'm asked with them", async () => {
    const { api, server, ssh } = await rig({
      hooks: true,
      script: (t, home) =>
        t.system.includes("# Your task: Clean up") && t.turn === 1
          ? [
              { run: agentSsh(t, "rm -rf /srv/a") },
              { run: agentSsh(t, "rm -rf /srv/b") },
              {
                run: agentSsh(t, "rm -rf /srv/misahaty"),
                instead: () => {
                  rmSync(join(home, "misahaty"), { recursive: true, force: true });
                  return "";
                },
              },
              { say: "DONE" },
            ]
          : [{ say: "DONE" }],
      talk: () => ({ intent: "work", reply: "I'll clean up.", goal: "Clean up" }),
      plan: removal("Clean up what is left over.", [gone], "Clean up"),
    });
    mkdirSync(join(ssh.home, "misahaty"));
    const job = await startRemoval(api, server.id);
    const stuck = await openItem(api, /is stuck on blocked actions in “Clean up”/);
    expect(stuck.detail).toContain("3 actions in a row were blocked");
    for (const path of ["/srv/a", "/srv/b", "/srv/misahaty"]) expect(stuck.detail).toContain(path);
    expect(stuck.options).toEqual(["Let it run this one", "Keep it blocked"]);
    await api.inbox.answer({ id: stuck.id, answer: "Let it run this one" });
    const done = await ended(api, job.id);
    expect(done.state, done.blockedReason ?? "").toBe("completed");
  }, 60_000);

  it("an agent that says it can't finish without me gets that asked, not “keeps going wrong”", async () => {
    let allowed = false;
    const { api, server, ssh } = await rig({
      hooks: true,
      script: (t, home) => {
        if (!t.system.includes("# Your task: Remove Misahaty")) return [{ say: "DONE" }];
        const rm: Action = {
          run: agentSsh(t, "rm -rf /root/misahaty"),
          instead: () => {
            allowed = true;
            rmSync(join(home, "misahaty"), { recursive: true, force: true });
            return "";
          },
        };
        if (/The owner allows `/.test(t.message)) return [rm, { say: "DONE" }];
        return [
          rm,
          {
            say: "Removed its containers and volumes. The check is right and the fix is blocked by a guardrail that only the owner can lift. Owner action required: rm -rf /root/misahaty",
          },
        ];
      },
      talk: () => ({ intent: "work", reply: "I'll remove it.", goal: "Remove Misahaty" }),
      // The plan doesn't name the folder: no approval of it at once.
      plan: removal("Remove Misahaty's containers, volumes, data and config.", [gone]),
    });
    mkdirSync(join(ssh.home, "misahaty"));
    const job = await startRemoval(api, server.id);
    const asked = await openItem(api, /needs `rm -rf \/root\/misahaty` on VPS One/);
    expect(asked.questions?.[0]?.prompt).toMatch(
      /^Claude A says it can't finish “Remove Misahaty” without `rm -rf \/root\/misahaty` on VPS One, which Oraknid's rules blocked \(.+\)\. What should I do\?$/,
    );
    expect(asked.options).toEqual(["Allow", "I'll do it", "Leave it out", "Stop the job"]);
    expect(asked.detail).toContain("only the owner can lift");
    await api.inbox.answer({ id: asked.id, answer: "Allow" });
    const done = await ended(api, job.id);
    expect(done.state, done.blockedReason ?? "").toBe("completed");
    expect(allowed).toBe(true);
    expect((await api.inbox.list({})).filter((i) => /keeps going wrong/.test(i.title))).toEqual([]);
  }, 60_000);

  it("runs a check written with the job's own ssh setup in its plain form, on the server (the -F path ssh cut at 100 characters)", async () => {
    const home = "/home/me/.local/share/oraknid/legs/01K6ZLEG/jobs/01K70JOBJOBJOB/home";
    const seen = `n=$(HOME=${home} ssh -o BatchMode=yes -F ${home}/.ssh/config oraknid-vps-one docker ps -q --filter name=harvest- | wc -l); [ "$n" -eq 2 ]`;
    const { api, server, ssh } = await rig({
      script: () => [{ say: "DONE: nothing to change." }],
      talk: () => ({ intent: "work", reply: "I'll check.", goal: "Remove Misahaty" }),
      plan: removal("Remove Misahaty; Harvest keeps running.", [seen]),
    });
    const job = await startRemoval(api, server.id);
    const done = await ended(api, job.id);
    expect(done.state, done.blockedReason ?? "").toBe("completed");
    // Run whole on the server, over Oraknid's connection: no -F, no HOME=, no job path.
    expect(ssh.commands).toContain(
      `n=$(docker ps -q --filter name=harvest- | wc -l); [ "$n" -eq 2 ]`,
    );
    expect(ssh.commands.some((c) => c.includes("-F") || c.includes("/jobs/"))).toBe(false);
  }, 60_000);

  it("before the work: a check whose ssh can't set up is broken, and a guard that fails is wrong; both repaired, never charged to the agent", async () => {
    const repairs: { command: string; hint: string; guard: boolean; servers: string[] }[] = [];
    const guard = `ssh oraknid-vps-one '[ "$(docker ps -q --filter name=harvest- | wc -l)" -eq 3 ]' # guard: Harvest still runs`;
    const setup =
      "ssh -F /nowhere/.local/share/oraknid/legs/l/jobs/j/home/.ssh/config elsewhere-host true";
    const { api, server } = await rig({
      script: () => [{ say: "DONE" }],
      talk: () => ({ intent: "work", reply: "I'll do it.", goal: "Remove Misahaty" }),
      plan: removal("Remove Misahaty; Harvest keeps running.", [setup, guard]),
      repairCheck: async (i) => {
        repairs.push({
          command: i.command,
          hint: i.hint,
          guard: !!i.guard,
          servers: (i.servers ?? []).map((s) => s.alias),
        });
        return i.command === setup
          ? { broken: true, command: "ssh oraknid-vps-one true", reason: "its ssh setup" }
          : {
              broken: true,
              command: `ssh oraknid-vps-one '[ "$(docker ps -q --filter name=harvest- | wc -l)" -ge 1 ]' # guard: Harvest still runs`,
              reason: "two run; still running is what it guards",
            };
      },
    });
    const job = await startRemoval(api, server.id);
    const done = await ended(api, job.id);
    expect(done.state, done.blockedReason ?? "").toBe("completed");
    expect(repairs).toEqual([
      {
        command: setup,
        hint: expect.stringMatching(/ssh can't set up/),
        guard: false,
        servers: ["oraknid-vps-one"],
      },
      {
        command: guard,
        hint: "it guards what the work must keep true, yet fails before any work",
        guard: true,
        servers: ["oraknid-vps-one"],
      },
    ]);
    const tried = (
      await api.audit.search({ jobId: job.id, type: "task.checks-tried", limit: 5 })
    ).flatMap((e) => (e.payload as { checks: { state: string }[] }).checks.map((c) => c.state));
    expect(tried).toEqual([
      "broken, repaired as `ssh oraknid-vps-one true`",
      expect.stringMatching(/^broken, repaired as `ssh oraknid-vps-one '\[ .* -ge 1 \]' # guard/),
    ]);
  }, 60_000);
});
