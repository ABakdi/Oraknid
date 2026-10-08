/**
 * A daemon for measuring the web UI (scripts/ui-perf.mjs): its own data
 * folder and port, a database seeded with a busy owner's volume (thousands
 * of events, a few huge old rows, many jobs, inbox items, Silk), and a job
 * that looks like it runs: what its agent says every 250 ms, a tool call
 * every 2 s, The Eye now and then, mail syncing. No agent runs: every Leg
 * is a stand-in, the job's program waits, The Eye's brain refuses.
 *
 *   pnpm --filter @oraknid/daemon exec tsx scripts/ui-perf-daemon.ts [--port 7517] [--dir <folder>] [--web <built UI>] [--keep-oversized] [--quiet]
 *
 * Prints one JSON line on stdout once it listens: { url, token, projectId,
 * jobId, legId, serverId }. Never point it at ~/.local/share/oraknid or 7417.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LegKind } from "@oraknid/contracts";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { ulid } from "ulid";
import type { Router } from "../src/api/router.ts";
import { startDaemon } from "../src/daemon.ts";
import { closeDatabase, openDatabase } from "../src/db/open.ts";
import { CLIP_OVERSIZED } from "../src/db/upkeep.ts";
import { resolvePaths } from "../src/paths.ts";
import { fakeLeg } from "../src/testing/fake-leg.ts";
import { fakeOs } from "../src/testing/fake-os.ts";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};
const port = Number(arg("port", "7517"));
const quiet = process.argv.includes("--quiet");
const keepOversized = process.argv.includes("--keep-oversized");
if (port === 7417) throw new Error("7417 is the owner's own Oraknid: pick another port.");
const dir = arg("dir", "") || mkdtempSync(join(tmpdir(), "oraknid-ui-perf-"));
if (dir.includes(".local/share/oraknid")) throw new Error("Not the owner's data folder.");
const paths = resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir });

const words =
  "the build passed and the next step reads the router before it changes the handler so the tests keep their names".split(
    " ",
  );
const sentence = (n: number, seed: number) =>
  Array.from({ length: n }, (_, i) => words[(seed * 7 + i * 3) % words.length]).join(" ");
const big = (chars: number, label: string) =>
  `${label}\n${"x"
    .repeat(80)
    .concat("\n")
    .repeat(Math.ceil(chars / 81))}`.slice(0, chars);

/** The busy owner's database, written before the daemon opens it. */
async function seed() {
  const db = await openDatabase({ file: paths.db, backupsDir: paths.backups });
  const c = db.$client;
  const now = Date.now();
  const ids = {
    legs: [ulid(), ulid(), ulid()],
    projects: [ulid(), ulid(), ulid(), ulid()],
    skill: ulid(),
    jobs: [] as { id: string; projectId: string; state: string }[],
    tasks: [] as string[],
    servers: [] as string[],
  };
  c.transaction(() => {
    const kinds = ["claude-code", "codex", "opencode"];
    ids.legs.forEach((id, i) => {
      c.prepare(
        "insert into legs (id, name, kind, config, enabled, health, quota, created_at) values (?, ?, ?, '{}', 1, 'healthy', '[]', ?)",
      ).run(id, `Leg ${i + 1}`, kinds[i], now - 86_400_000);
      for (const [j, model] of ["opus", "haiku"].entries())
        c.prepare(
          "insert into leg_models (id, leg_id, model, display_name, hidden, effort_levels, quota, profile) values (?, ?, ?, ?, 0, '[]', '[]', '{}')",
        ).run(ulid(), id, model, model === "opus" ? "Opus" : `Haiku ${j}`);
    });
    c.prepare(
      "insert into skills (id, version, name, description, source, body, interview, required_tools, verify, created_at) values (?, 1, 'Build', '', 'built-in', '', 0, '[]', '[]', 0)",
    ).run(ids.skill);
    ids.projects.forEach((id, i) => {
      c.prepare(
        "insert into projects (id, name, workspace_path, is_git_repo, release_branch, work_branch, created_at) values (?, ?, ?, 1, 'main', 'dev', ?)",
      ).run(id, ["keys", "site", "api", "tools"][i], join(dir, `p${i}`), now - 30 * 86_400_000);
    });
    // 120 jobs: one running in "keys", the rest ended or waiting.
    const states = ["completed", "completed", "cancelled", "completed", "blocked", "paused"];
    for (let i = 0; i < 120; i++) {
      const projectId = ids.projects[i % 4] as string;
      const state = i === 0 ? "running" : (states[i % states.length] as string);
      const id = ulid();
      ids.jobs.push({ id, projectId, state });
      c.prepare(
        `insert into jobs (id, project_id, title, description, goal, inputs, skill_id, skill_version, autonomy, allowed_leg_ids, budget, state, blocked_reason, created_at, started_at, finished_at)
         values (?, ?, ?, ?, ?, '[]', ?, 1, 'auto', '[]', '{"tokens":null,"quotaShare":null,"wallClockMs":null,"money":{"limit":0,"hard":true}}', ?, ?, ?, ?, ?)`,
      ).run(
        id,
        projectId,
        `Job ${i}: ${sentence(5, i)}`,
        sentence(20, i),
        sentence(40, i),
        ids.skill,
        state,
        state === "blocked" ? sentence(30, i) : null,
        now - (120 - i) * 3600_000,
        now - (120 - i) * 3600_000,
        state === "running" ? null : now - (119 - i) * 3600_000,
      );
    }
    const running = ids.jobs[0] as { id: string; projectId: string };
    // The running job's plan: 24 tasks in a web.
    for (let i = 0; i < 24; i++) {
      const id = ulid();
      ids.tasks.push(id);
      c.prepare(
        `insert into tasks (id, job_id, title, instructions, kind, scope, verify, required_capabilities, difficulty, state, position, assigned_leg_id)
         values (?, ?, ?, ?, 'implement', '[]', '[]', '[]', 'medium', ?, ?, ?)`,
      ).run(
        id,
        running.id,
        `Task ${i}: ${sentence(4, i)}`,
        sentence(60, i),
        i < 10 ? "done" : i < 13 ? "running" : "pending",
        i,
        ids.legs[i % 3],
      );
      if (i > 0)
        c.prepare("insert into task_edges (task_id, depends_on) values (?, ?)").run(
          id,
          ids.tasks[Math.floor((i - 1) / 2)],
        );
    }
    for (let i = 0; i < 40; i++)
      c.prepare(
        `insert into sessions (id, job_id, task_id, leg_id, leg_model_id, log_file, started_at, ended_at, end_reason, input_tokens, output_tokens)
         values (?, ?, ?, ?, 'm', '/dev/null', ?, ?, ?, 12000, 3000)`,
      ).run(
        ulid(),
        running.id,
        ids.tasks[i % 24],
        ids.legs[i % 3],
        now - (40 - i) * 600_000,
        now - (40 - i) * 600_000 + 300_000,
        "completed",
      );
    // The Eye's conversations: 400 messages in "keys" and one dump of 3.2 MB (an old blocked reason).
    for (const [p, projectId] of ids.projects.entries()) {
      const jobsOf = ids.jobs.filter((j) => j.projectId === projectId);
      const n = p === 0 ? 400 : 60;
      for (let i = 0; i < n; i++) {
        const job = jobsOf[i % jobsOf.length] as { id: string };
        const eye = i % 2 === 1;
        const text =
          p === 0 && i === 201
            ? big(3_200_000, "Blocked: the command failed with")
            : eye
              ? `**Done.** ${sentence(60, i)}\n\n- ${sentence(10, i + 1)}\n- ${sentence(10, i + 2)}\n\n\`\`\`ts\nconst x = ${i};\n\`\`\``
              : sentence(25, i);
        c.prepare(
          "insert into eye_messages (id, job_id, project_id, author, text, action, created_at) values (?, ?, ?, ?, ?, ?, ?)",
        ).run(
          ulid(),
          job.id,
          projectId,
          eye ? "eye" : "owner",
          text,
          eye
            ? JSON.stringify({
                intent: "question",
                did: ["Answered"],
                silkIds: [],
                taskIds: [],
                jobId: null,
              })
            : null,
          now - (n - i) * 60_000,
        );
      }
    }
    // Silk: 300 entries, one of 1.5 MB.
    for (let i = 0; i < 300; i++) {
      const job = ids.jobs[i % 12] as { id: string };
      c.prepare(
        "insert into silk_entries (id, job_id, kind, title, body, covers, authored_by, created_at) values (?, ?, ?, ?, ?, '[]', '\"eye\"', ?)",
      ).run(
        ulid(),
        job.id,
        ["decision", "progress", "issue"][i % 3],
        `Entry ${i}`,
        i === 12 ? big(1_500_000, "Progress: output") : sentence(80, i),
        now - (300 - i) * 60_000,
      );
    }
    // The inbox: 150 items, 20 open.
    for (let i = 0; i < 150; i++) {
      const job = ids.jobs[i % 120] as { id: string };
      c.prepare(
        `insert into inbox_items (id, kind, job_id, raised_by, title, detail, options, state, created_at)
         values (?, ?, ?, '"eye"', ?, ?, '["Yes","No"]', ?, ?)`,
      ).run(
        ulid(),
        i % 2 ? "approval" : "question",
        job.id,
        `Question ${i}: ${sentence(6, i)}`,
        sentence(120, i),
        i < 20 ? "open" : "answered",
        now - (150 - i) * 120_000,
      );
    }
    // Four servers, each with a day of oraknid-monitor readings every 15 s (5,760, as the owner's).
    for (let s = 0; s < 4; s++) {
      const id = ulid();
      ids.servers.push(id);
      c.prepare(
        `insert into servers (id, name, host, port, user, description, auth, setup, last_seen_at, created_at)
         values (?, ?, '127.0.0.1', 1, 'root', 'A test box', 'my-key', 'ready', ?, ?)`,
      ).run(id, `box-${s}`, now, now - 7 * 86_400_000);
      const sample = c.prepare(
        "insert into server_samples (server_id, at, sample) values (?, ?, ?)",
      );
      const services = Array.from({ length: 60 }, (_, i) => `service-${i}.service`);
      const ports = Array.from({ length: 30 }, (_, i) => `0.0.0.0:${3000 + i} (node)`);
      for (let i = 0; i < 5760; i++) {
        const at = now - (5760 - i) * 15_000;
        sample.run(
          id,
          at,
          JSON.stringify({
            at,
            cpuPercent: (i * 7) % 100,
            load1: ((i * 3) % 40) / 10,
            memUsed: 2e9 + ((i * 13) % 100) * 1e7,
            memTotal: 8e9,
            diskUsed: 4e10,
            diskTotal: 1e11,
            rxBytes: i * 1e5,
            txBytes: i * 5e4,
            connections: i % 90,
            uptimeSec: 86_400 + i * 15,
            services,
            ports,
          }),
        );
      }
    }
    // The event log: 18,000 events, with two of 3.2 MB (a job's state and error, the old dump).
    const ins = c.prepare(
      "insert into events (at, type, topic, job_id, payload, actor) values (?, ?, ?, ?, ?, ?)",
    );
    const mix: [string, number][] = [
      ["session.text", 5160],
      ["mail.synced", 3823],
      ["session.tool.result", 1340],
      ["permission.requested", 962],
      ["session.tool.called", 1340],
      ["task.state", 2000],
      ["job.state", 1500],
      ["session.started", 1000],
      ["session.ended", 875],
    ];
    let k = 0;
    for (const [type, count] of mix)
      for (let i = 0; i < count; i++, k++) {
        const job = ids.jobs[k % 120] as { id: string };
        const leg = ids.legs[k % 3] as string;
        const topic = type.startsWith("mail.")
          ? "mail"
          : type.startsWith("session.")
            ? k % 2
              ? `leg:${leg}`
              : `job:${job.id}`
            : `job:${job.id}`;
        const payload =
          type === "session.text"
            ? { sessionId: "s", text: sentence(40, k) }
            : type === "session.tool.result"
              ? { sessionId: "s", ok: true, output: sentence(400, k) }
              : type === "session.tool.called"
                ? { sessionId: "s", tool: "Bash", input: { command: `pnpm test ${k}` } }
                : type === "mail.synced"
                  ? { accountId: "a", folder: "INBOX", count: k % 7 }
                  : type === "job.state"
                    ? { from: "running", to: "blocked", reason: sentence(20, k) }
                    : { k };
        ins.run(
          now - (18_000 - k) * 20_000,
          type,
          topic,
          topic === "mail" ? null : job.id,
          JSON.stringify(payload),
          type.startsWith("session.") ? `leg:${leg}` : "oraknid",
        );
      }
    const keysJob = running.id;
    ins.run(
      now - 3600_000,
      "job.state",
      `job:${keysJob}`,
      keysJob,
      JSON.stringify({ from: "running", to: "blocked", reason: big(3_200_000, "git failed") }),
      "oraknid",
    );
    ins.run(
      now - 3500_000,
      "job.error",
      `job:${keysJob}`,
      keysJob,
      JSON.stringify({ message: big(3_200_000, "git failed") }),
      "oraknid",
    );
  })();
  // The oversized rows left as they are (migration 0043 not run): the screens against old data.
  if (keepOversized) c.prepare("delete from settings where key = ?").run(CLIP_OVERSIZED);
  closeDatabase(db);
  return { ...ids, running: ids.jobs[0] as { id: string; projectId: string } };
}

const seeded = await seed();
const legs = fakeLeg();
const daemon = await startDaemon({
  paths,
  port,
  host: "127.0.0.1",
  os: fakeOs().os,
  adapters: Object.fromEntries(LegKind.options.map((k) => [k, legs.adapter])),
  // The running job waits: nothing is planned, nothing runs.
  program: (ctx) =>
    new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve())),
  naming: { backfillDelayMs: -1 },
  ciWatch: false,
  // The seeded servers are not there: no reading is tried but the first.
  serverSampleSec: 3600,
  // Another build of the UI than apps/web/dist, to compare two (scripts/ui-perf.mjs --web).
  ...(arg("web", "") ? { webDir: arg("web", "") } : {}),
});

// A PIN, so the browser can unlock (ADR-029): it uses the same token.
const api = createORPCClient<RouterClient<Router>>(
  new RPCLink({
    url: `${daemon.url}/api`,
    headers: { authorization: `Bearer ${daemon.cliToken}` },
  }),
);
const { session } = await api.lock.setPin({ current: null, pin: "246810" });

const job = seeded.running.id;
const leg = seeded.legs[0] as string;
const publish = (type: string, payload: Record<string, unknown>, both = true) => {
  daemon.bus.publish({ type, topic: `job:${job}`, jobId: job, payload, actor: `leg:${leg}` });
  if (both)
    daemon.bus.publish({ type, topic: `leg:${leg}`, jobId: job, payload, actor: `leg:${leg}` });
};
let n = 0;
const timers = [
  // What the agent says, coalesced at 250 ms as the supervisor does.
  setInterval(() => publish("session.text", { sessionId: "live", text: sentence(30, n++) }), 250),
  setInterval(() => {
    publish("session.tool.called", {
      sessionId: "live",
      tool: "Bash",
      input: { command: `pnpm test ${n}` },
    });
    publish("session.tool.result", { sessionId: "live", ok: true, output: sentence(300, n) });
  }, 2000),
  setInterval(
    () =>
      publish("session.usage", { sessionId: "live", inputTokens: 1000 * n, outputTokens: 100 * n }),
    5000,
  ),
  setInterval(() => {
    const task = seeded.tasks[10 + (n % 3)];
    daemon.bus.publish({
      type: "task.state",
      topic: `job:${job}`,
      jobId: job,
      payload: { taskId: task, from: "running", to: "running" },
    });
  }, 10_000),
  setInterval(() => {
    daemon.bus.publish({ type: "mail.synced", topic: "mail", jobId: null, payload: { count: 1 } });
  }, 20_000),
  setInterval(() => {
    daemon.bus.publish({
      type: "eye.message",
      topic: `job:${job}`,
      jobId: job,
      payload: { text: sentence(10, n) },
    });
  }, 30_000),
];

console.log(
  JSON.stringify({
    url: daemon.url,
    token: daemon.cliToken,
    session,
    dir,
    projectId: seeded.running.projectId,
    jobId: job,
    legId: leg,
    serverId: seeded.servers[0],
  }),
);
if (!quiet) console.error(`ui-perf daemon on ${daemon.url}, data in ${dir}`);

const stop = async () => {
  for (const t of timers) clearInterval(t);
  legs.cleanup();
  await daemon.close();
  process.exit(0);
};
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
