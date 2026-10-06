import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EyeMessage } from "@oraknid/contracts";
import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/open.ts";
import { eyeMessages, jobs, projects } from "../db/schema.ts";
import type { ServerTalk } from "../eye/brain.ts";
import {
  addMessage,
  addProjectMessage,
  projectConversation,
  type TalkDeps,
  talk,
} from "../eye/talk.ts";
import { JobServer, jobServerKey, writeSetting } from "../settings.ts";
import { stableId } from "../skills/store.ts";
import type { Projects } from "../workspace/projects.ts";
import { insightSummary } from "./insight.ts";
import type { JobServerRef } from "./remote.ts";
import { aliasOf, type Servers } from "./service.ts";

// Server chat and server jobs (ADR-049): each server has a project of its
// own, hidden from the Projects list, whose folder is a scratch folder of
// Oraknid's and whose one server is the server. Its conversation is the
// server's Chat tab; its jobs are the server's, run by the same Eye, Silk,
// Workflow and approvals as any job.

/** Where the servers' own projects have their folders: under Oraknid's data folder. */
export const serverJobsDir = (dataDir: string) => join(dataDir, "server-jobs");

/** The method of a server's jobs: skills/server-work.md. */
export const SERVER_SKILL = stableId("server-work");

const ENDED = new Set(["completed", "cancelled"]);

/** A server's own project, if it has one yet. */
export function serverProjectOf(db: Db, serverId: string) {
  return db.select().from(projects).where(eq(projects.serverId, serverId)).get() ?? null;
}

/** The server whose own project this is, or null for a project of mine. */
export function serverOf(db: Db, projectId: string): string | null {
  return (
    db.select({ s: projects.serverId }).from(projects).where(eq(projects.id, projectId)).get()?.s ??
    null
  );
}

/**
 * The server's own project, made the first time: its folder under
 * Oraknid's data folder (a shadow repo keeps its checkpoints), the server
 * its one server, the server-work method its skill.
 */
export function ensureServerProject(
  d: { db: Db; projects: Projects; servers: Servers; dir: string },
  serverId: string,
): string {
  const existing = serverProjectOf(d.db, serverId);
  if (existing) return existing.id;
  const s = d.servers.row(serverId);
  const folder = join(d.dir, serverId);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const p = d.projects.create({ name: s.name, workspacePath: folder, initGit: false });
  d.db
    .update(projects)
    .set({
      serverId,
      serverIds: [serverId],
      serverRoles: { [serverId]: { role: "", production: null } },
      skillIds: [SERVER_SKILL],
    })
    .where(eq(projects.id, p.id))
    .run();
  return p.id;
}

/**
 * The servers a job may reach, as its commands name them: each alias, and
 * whether it is production (its role in the project, or my mark on it).
 */
export function jobServers(d: { db: Db; servers?: Servers }, jobId: string): JobServerRef[] {
  if (!d.servers) return [];
  const servers = d.servers;
  const job = d.db.select({ p: jobs.projectId }).from(jobs).where(eq(jobs.id, jobId)).get();
  const p = job ? d.db.select().from(projects).where(eq(projects.id, job.p)).get() : undefined;
  if (!p) return [];
  return p.serverIds.flatMap((id) => {
    try {
      const r = servers.row(id);
      return [
        {
          id,
          name: r.name,
          alias: aliasOf(r),
          production: servers.isProduction(id, p.serverRoles[id]),
        },
      ];
    } catch {
      return [];
    }
  });
}

/**
 * What a server job's plan must know (ADR-049): the work is on the server,
 * reached by its alias; its checks run there; its state document.
 */
export function serverDigest(d: { servers: Servers }, serverId: string): string {
  const r = d.servers.row(serverId);
  const alias = aliasOf(r);
  const production = d.servers.isProduction(serverId);
  return `This job's place is the server **${r.name}** (\`${r.user}@${r.host}\`)${production ? ", which is PRODUCTION: what runs there is live" : ""}, not a repo. The workspace is a scratch folder of Oraknid's, for notes and scripts; the work is done on the server through \`ssh ${alias} <command>\`. A small job is one task. A task that only looks (logs, configuration, why something fails) is "research", changes nothing and writes its findings to findings.md. A task that changes the server has "verify" checks that run on the server, written \`ssh ${alias} <a command that only reads>\` (\`ssh ${alias} systemctl is-active fail2ban\`, \`ssh ${alias} nginx -t\`): Oraknid runs them there itself. Its "scope" is the notes it writes in the workspace (findings.md, notes/**), never the server's paths.

# The server's state document
${d.servers.state(serverId)?.body ?? "(none yet)"}`;
}

/**
 * A server job states what it will change before it starts (ADR-049): the
 * plan waits for my approval when any task changes the server, unless the
 * job runs at Full autonomy on a server that isn't production. A job that
 * only looks starts at once.
 */
export function serverPlanApproval(
  d: { db: Db; servers?: Servers },
  job: { projectId: string; autonomy: string },
  pending: { kind: string }[],
): string | null {
  const serverId = serverOf(d.db, job.projectId);
  if (!serverId || !d.servers) return null;
  const changes = pending.some((t) => t.kind !== "research" && t.kind !== "plan");
  if (!changes) return null;
  if (job.autonomy === "full" && !d.servers.isProduction(serverId)) return null;
  try {
    return d.servers.row(serverId).name;
  } catch {
    return null;
  }
}

/** Server chat: the deps of talking, and the server's own. */
export interface ServerTalkDeps extends TalkDeps {
  servers: Servers;
  projects: Projects;
  /** Where the servers' own projects have their folders. */
  dir: string;
}

/** The server's conversation: its project's, from every job and none (ADR-049). */
export function serverConversation(db: Db, serverId: string): EyeMessage[] {
  const p = serverProjectOf(db, serverId);
  return p ? projectConversation(db, p.id) : [];
}

/** The job going on the server now, if any. */
function goingJob(db: Db, projectId: string) {
  return (
    db
      .select()
      .from(jobs)
      .where(eq(jobs.projectId, projectId))
      .orderBy(desc(jobs.createdAt), desc(jobs.id))
      .all()
      .find((j) => j.state !== "draft" && !ENDED.has(j.state)) ?? null
  );
}

/**
 * My message in a server's conversation (ADR-049): to the job going on it,
 * as in a project; with none, The Eye answers a question from the state
 * document and the readings, or starts a server job for work. The reply
 * arrives as an `eye.replied` event.
 */
export function talkToServer(
  d: ServerTalkDeps,
  serverId: string,
  text: string,
): { id: string; jobId: string | null } {
  const pid = ensureServerProject(d, serverId);
  const going = goingJob(d.db, pid);
  if (going) return { id: talk(d, going.id, text), jobId: going.id };
  const id = addProjectMessage(d, pid, "owner", text, null);
  respond(d, serverId, pid, text, id);
  return { id, jobId: null };
}

/**
 * On start: a message of mine in a server's conversation that no job took
 * and The Eye hadn't answered is handled now (as in a project's).
 */
export function resumeServerConversations(d: ServerTalkDeps): number {
  let n = 0;
  for (const p of d.db.select().from(projects).all()) {
    if (!p.serverId || p.archivedAt) continue;
    const last = projectConversation(d.db, p.id).at(-1);
    if (last?.author !== "owner" || last.jobId) continue;
    respond(d, p.serverId, p.id, last.text, last.id);
    n++;
  }
  return n;
}

function respond(d: ServerTalkDeps, serverId: string, pid: string, text: string, id: string) {
  void handle(d, serverId, pid, text, id).catch((error) => {
    addProjectMessage(
      d,
      pid,
      "eye",
      `I couldn't think about it just now (${error instanceof Error ? error.message : String(error)}). Ask me again in a moment.`,
      { intent: "question", did: [], silkIds: [], taskIds: [], jobId: null },
    );
  });
}

async function handle(d: ServerTalkDeps, serverId: string, pid: string, text: string, id: string) {
  const r = d.servers.row(serverId);
  const project = d.db.select().from(projects).where(eq(projects.id, pid)).get();
  const production = d.servers.isProduction(serverId);
  let verdict: ServerTalk = { intent: "work", reply: "", goal: text };
  if (d.brain.serverTalk) {
    verdict = await d.brain.serverTalk({
      cwd: project?.workspacePath ?? d.tmpDir,
      name: r.name,
      description: r.description,
      role: `${production ? "Production: what runs there is live; every change asks the owner first." : "Not marked production."}${
        r.setup === "ready" ? "" : " Not set up yet: Oraknid can't reach it until it is."
      }`,
      state: d.servers.state(serverId)?.body ?? "",
      readings: await readings(d.servers, serverId),
      conversation: projectConversation(d.db, pid)
        .filter((m) => m.id !== id)
        .slice(-10)
        .map((m) => `${m.author === "owner" ? "Owner" : "You"}: ${m.text}`)
        .join("\n"),
      message: text,
    });
  }
  if (verdict.intent === "question") {
    addProjectMessage(d, pid, "eye", verdict.reply, {
      intent: "question",
      did: ["Answered from the state document"],
      silkIds: [],
      taskIds: [],
      jobId: null,
    });
    return;
  }
  if (r.setup !== "ready") {
    addProjectMessage(
      d,
      pid,
      "eye",
      `${r.name} isn't set up yet, so no job can work on it: press Set up on its page first, then ask me again.`,
      { intent: "task", did: ["Not started"], silkIds: [], taskIds: [], jobId: null },
    );
    return;
  }
  if (!d.newJob || !d.startJob) throw new Error("New work can't start from here.");
  const goal = verdict.goal?.trim() || text;
  const jobId = d.newJob(pid, goal);
  // My message belongs to the job it started; the server is its server, asked of no one.
  d.db.update(eyeMessages).set({ jobId }).where(eq(eyeMessages.id, id)).run();
  writeSetting(d.db, jobServerKey(jobId), JobServer, { serverId, declined: [] });
  const title = d.db.select({ t: jobs.title }).from(jobs).where(eq(jobs.id, jobId)).get()?.t;
  try {
    await d.startJob(jobId);
    addMessage(
      d,
      jobId,
      "eye",
      `${verdict.reply ? `${verdict.reply} ` : ""}I started a job on ${r.name} for it, “${title}”: I plan it, then tell you what it will change on the server before anything does${production ? ` (${r.name} is production: every change asks you first)` : ""}.`,
      { intent: "task", did: ["Started a job on the server"], silkIds: [], taskIds: [], jobId },
    );
  } catch (e) {
    // A draft isn't in the conversation: my message and the reason stay in it without the job.
    d.db.update(eyeMessages).set({ jobId: null }).where(eq(eyeMessages.id, id)).run();
    addProjectMessage(
      d,
      pid,
      "eye",
      `I made a job for this, “${title}”, but couldn't start it: ${e instanceof Error ? e.message : String(e)} It waits as a draft in New work.`,
      { intent: "task", did: ["Kept as a draft"], silkIds: [], taskIds: [], jobId },
    );
  }
}

/** oraknid-monitor's last reading and what runs there, in a few lines (best effort, briefly). */
async function readings(servers: Servers, serverId: string): Promise<string> {
  const l = servers.latest(serverId);
  const sample = l
    ? `CPU ${Math.round(l.cpuPercent)}%, load ${l.load1}, memory ${Math.round((l.memUsed / (l.memTotal || 1)) * 100)}%, disk ${Math.round((l.diskUsed / (l.diskTotal || 1)) * 100)}%, ${l.connections} connections, up ${Math.round(l.uptimeSec / 3600)} h.\nRunning services: ${l.services.join(", ") || "none seen"}.\nListening: ${l.ports.join(", ") || "none seen"}.`
    : "";
  let runs = "";
  if (servers.row(serverId).setup === "ready") {
    try {
      runs = await Promise.race([
        servers.monitor(serverId).then((c) => insightSummary(c)),
        new Promise<string>((resolve) => setTimeout(() => resolve(""), 15_000).unref()),
      ]);
    } catch {}
  }
  return [sample, runs].filter(Boolean).join("\n\n");
}

/** Where a server's state document changed between two versions, as a unified diff (git's). */
export function stateDiff(before: string, after: string): string {
  const dir = mkdtempSync(join(tmpdir(), "oraknid-state-"));
  try {
    writeFileSync(join(dir, "before.md"), before.endsWith("\n") ? before : `${before}\n`);
    writeFileSync(join(dir, "after.md"), after.endsWith("\n") ? after : `${after}\n`);
    const r = spawnSync(
      "git",
      ["diff", "--no-index", "--no-color", "-U1", "--", "before.md", "after.md"],
      { cwd: dir, encoding: "utf8" },
    );
    // The hunks only: the file names are always the same two.
    return r.stdout
      .split("\n")
      .filter((l) => !/^(diff --git|index |--- |\+\+\+ )/.test(l))
      .join("\n")
      .trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
