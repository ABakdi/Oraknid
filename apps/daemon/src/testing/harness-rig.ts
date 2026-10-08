import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxItem, JobView, LegKind, WebPlan } from "@oraknid/contracts";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { Router } from "../api/router.ts";
import { type Daemon, startDaemon } from "../daemon.ts";
import type { EyeBrain, ServerTalk } from "../eye/brain.ts";
import { resolvePaths } from "../paths.ts";
import { fakeOs } from "./fake-os.ts";
import { fakeServerTools } from "./fake-server-tools.ts";
import { fakeSsh } from "./fake-ssh.ts";
import { fakeJudge } from "./judge.ts";
import type { scriptedLeg } from "./scripted-leg.ts";

// One rig for the task harness's scenario tests (ADR-056 stage 1): a whole
// daemon with stand-in Legs of any kind, a scripted Eye, and, when asked, the
// stand-in SSH server with one server set up. Never a real agent, never my
// data folder or port.

export type Api = RouterClient<Router>;
export type Scripted = ReturnType<typeof scriptedLeg>;

export interface RigOptions {
  /** The Legs, in order: their kind, name and stand-in. */
  legs: { kind: LegKind; name: string; leg: Scripted }[];
  /** The plan The Eye makes. */
  plan?: WebPlan;
  /** Any of The Eye's other answers. */
  brain?: Partial<EyeBrain>;
  /** The judge, by command; it allows when not told. */
  judge?: (command: string) => { decision: "allow" | "block"; reason: string };
  /** A stand-in server, set up as "VPS One" (ADR-049). */
  server?: boolean;
  /** How The Eye answers my words in a server's chat. */
  talk?: (message: string) => ServerTalk;
  /** The daemon's database file; in memory when left out. */
  dbFile?: string;
  /** The daemon's data folder; a fresh one when left out. */
  dataDir?: string;
  /** How long the drift judge may take (ADR-056). */
  driftJudgeMs?: number;
  /** Started again on a database that has its Legs already (a restart). */
  again?: boolean;
}

const sh = (cwd: string, ...a: string[]) => spawnSync("git", a, { cwd, encoding: "utf8" });

/** A git repository with one commit, and these files in it. */
export function repo(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "oraknid-harness-ws-"));
  sh(dir, "init", "-q", "-b", "master");
  sh(dir, "config", "user.email", "me@example.com");
  sh(dir, "config", "user.name", "Me");
  writeFileSync(join(dir, "README.md"), "# demo\n");
  writeFileSync(join(dir, "package.json"), "{}\n");
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  sh(dir, "add", ".");
  sh(dir, "commit", "-qm", "start");
  return dir;
}

/** A docker in front of the stand-in's that has two Harvest containers up (the misahaty server). */
function harvestTools(fakes: string): string {
  const bin = mkdtempSync(join(tmpdir(), "oraknid-harness-tools-"));
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

export async function waitFor<T>(
  what: string,
  fn: () => Promise<T | undefined | null | false> | T | undefined | null | false,
  ms = 20_000,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`no ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

export async function harness(o: RigOptions) {
  const closing: (() => Promise<void>)[] = [];
  const ssh = o.server
    ? await fakeSsh({ password: "pw", path: `${harvestTools(fakeServerTools())}` })
    : null;
  if (ssh) closing.push(ssh.close);
  const dir = o.dataDir ?? mkdtempSync(join(tmpdir(), "oraknid-harness-"));
  const brain: EyeBrain = {
    plan: async () => {
      if (!o.plan) throw new Error("no plan scripted");
      return o.plan;
    },
    replan: async () => {
      throw new Error("no replan scripted");
    },
    summarize: async () => ({ title: "s", body: "s" }),
    helperTurn: async () => ({ reply: "ok", actions: [] }),
    serverState: async ({ name }) => ({ document: `# ${name}\n\nServices: nginx.` }),
    pickSkill: async ({ skills }) => ({ skillId: skills[0]?.id ?? "", reason: "first" }),
    repairCheck: async ({ command }) => ({
      broken: false,
      command,
      reason: "the work is at fault",
    }),
    evaluate: async () => ({ accepted: true, reason: "it is there", missing: [] }),
    triage: async () => {
      throw new Error("no triage scripted");
    },
    judgeAction: fakeJudge(
      (command) => o.judge?.(command) ?? { decision: "allow", reason: "it only serves the task" },
    ),
    interviewRound: async () => ({ done: true, playback: "", questions: [], open: [] }),
    ...(o.talk
      ? {
          serverTalk: async ({ message }: { message: string }) =>
            (o.talk as RigOptions["talk"] & {})(message),
        }
      : {}),
    ...o.brain,
  };
  const fake = fakeOs({ keychain: true });
  const d: Daemon = await startDaemon({
    paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
    port: 0,
    dbFile: o.dbFile ?? ":memory:",
    os: fake.os,
    adapters: Object.fromEntries(o.legs.map((l) => [l.kind, l.leg.adapter])),
    brain,
    metricsIntervalMs: 50,
    guardIntervalMs: 3_600_000,
    stallCheckMs: 100,
    ...(o.driftJudgeMs ? { driftJudgeMs: o.driftJudgeMs } : {}),
    serverSampleSec: 3600,
  });
  closing.unshift(() => d.close());
  const api: Api = createORPCClient<Api>(
    new RPCLink({ url: `${d.url}/api`, headers: { authorization: `Bearer ${d.cliToken}` } }),
  );
  const legIds: Record<string, string> = {};
  if (o.again) for (const l of await api.legs.list()) legIds[l.name] = l.id;
  else
    for (const l of o.legs)
      legIds[l.name] = (
        await api.legs.create({ kind: l.kind, name: l.name, config: {} } as Parameters<
          Api["legs"]["create"]
        >[0])
      ).id;
  let server: { id: string } | null = null;
  if (ssh) {
    server = await api.servers.add({
      name: "VPS One",
      host: "127.0.0.1",
      port: ssh.port,
      user: "me",
      description: "My sites: nginx, Harvest.",
      password: "pw",
    });
    await api.servers.setup({ id: server.id });
  }

  /** A job on a new project of a repo, started; careful asks for the plan first. */
  const repoJob = async (
    goal: string,
    x: {
      files?: Record<string, string>;
      autonomy?: "careful" | "auto" | "full";
      /** The rig's server given to the project (ADR-026). */
      withServer?: boolean;
    } = {},
  ) => {
    const workspace = repo(x.files);
    const project = await api.projects.create({ name: "demo", workspacePath: workspace });
    if (x.withServer && server)
      await api.projects.setServers({ id: project.id, serverIds: [server.id] });
    const { id } = await api.jobs.create({
      projectId: project.id,
      goal,
      verify: [],
      autonomy: x.autonomy ?? "auto",
      inputs: [],
      allowedLegIds: [],
      unsandboxed: false,
    });
    await api.jobs.start({ id });
    return { id, workspace, projectId: project.id };
  };

  /** A server job from my words in its chat; its plan approved when asked. */
  const serverJob = async (text: string) => {
    if (!server) throw new Error("no server in this rig");
    const sent = await api.servers.talk({ id: server.id, text });
    const job = await waitFor(
      "a server job",
      async () => (await api.jobs.list({ projectId: sent.projectId }))[0],
    );
    const plan = await openItem(/^Approve what will change on VPS One/);
    await api.inbox.answer({ id: plan.id, answer: "Approve" });
    return job;
  };

  const openItem = (title: RegExp, ms?: number) =>
    waitFor(
      title.source,
      async () => (await api.inbox.list({ state: "open" })).find((i) => title.test(i.title)),
      ms,
    );

  /** The job once it ends: completed, blocked, cancelled or failed. */
  const ended = (id: string, ms = 40_000): Promise<JobView> =>
    waitFor(
      "the job's end",
      async () => {
        const j = await api.jobs.get({ id });
        return ["completed", "blocked", "cancelled", "failed"].includes(j.state) ? j : null;
      },
      ms,
    );

  /** Everything the job asked me, in order: the inbox's items of the job. */
  const asked = async (jobId: string): Promise<InboxItem[]> =>
    (await api.inbox.list({})).filter((i) => i.jobId === jobId).reverse();

  /** The job's events of one type, their payloads. */
  const events = (jobId: string, type: string) =>
    d.bus
      .since(0, [`job:${jobId}`], 10_000)
      .filter((e) => e.type === type)
      .map((e) => e.payload as Record<string, unknown>);

  const close = async () => {
    for (const c of closing.splice(0)) await c();
  };
  return { d, api, ssh, server, legIds, repoJob, serverJob, openItem, ended, asked, events, close };
}

export type Harness = Awaited<ReturnType<typeof harness>>;
