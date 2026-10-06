import { spawnSync } from "node:child_process";
import {
  choiceQuestion,
  type Event,
  type EyeReport,
  normalizeQuestions,
  type Question,
} from "@oraknid/contracts";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db/open.ts";
import { eyeMessages, jobs, tasks } from "../db/schema.ts";
import type { EventBus } from "../events/bus.ts";
import type { InboxStore } from "../inbox/store.ts";
import { serverOf, stateDiff } from "../servers/server-jobs.ts";
import type { Servers } from "../servers/service.ts";
import { jobResult } from "../workspace/result.ts";
import type { EyeBrain } from "./brain.ts";
import { readEnding } from "./ending.ts";
import { addMessage } from "./talk.ts";

// The Eye speaks up (ADR-045): one moderate message in the project's
// conversation per event that matters to me — a task done, a task left out,
// the job done, blocked, waiting for me — and nothing while things go to
// plan. A request I denied is said where it is denied (attempt.ts). Only the
// job's summary asks the brain (a quick model); the rest is written here.

export interface ReportDeps {
  db: Db;
  bus: EventBus;
  inbox: InboxStore;
  brain?: EyeBrain;
  now: () => number;
  /** My servers: a server job's report shows what changed in its state document (ADR-049). */
  servers?: Servers;
  /** The backup plans of a server, named in a server job's report when its data changed. */
  backupPlans?: (serverId: string) => Promise<{ name: string }[]>;
}

type Payload = Record<string, unknown>;

/** Starts listening; returns the way to stop. */
export function startEyeReports(d: ReportDeps): () => void {
  return d.bus.subscribe((e) => {
    if (!e.jobId) return;
    try {
      handle(d, e);
    } catch (error) {
      console.error("The Eye's report failed", error);
    }
  });
}

function handle(d: ReportDeps, e: Event) {
  const p = (e.payload ?? {}) as Payload;
  const jobId = e.jobId as string;
  if (e.type === "task.state" && p.to === "done") return taskDone(d, jobId, p);
  if (e.type === "task.state" && p.to === "skipped") return leftOut(d, jobId, p);
  if (e.type === "task.folder-restored") return folderRestored(d, jobId, p);
  if (e.type !== "job.state") return;
  if (p.to === "blocked") return blocked(d, jobId, String(p.reason ?? ""));
  if (p.to === "waiting") return waiting(d, jobId);
  if (p.to === "cancelled") return cancelled(d, jobId, String(p.reason ?? ""));
  if (p.to === "completed") void jobDone(d, jobId);
}

const say = (
  d: ReportDeps,
  jobId: string,
  text: string,
  report: EyeReport,
  extras: { questions?: Question[]; itemId?: string } = {},
) =>
  addMessage(
    d,
    jobId,
    "eye",
    text,
    {
      intent: "report",
      did: [],
      silkIds: [],
      taskIds: report.taskId ? [report.taskId] : [],
      jobId: null,
      report,
    },
    extras,
  );

const report = (kind: EyeReport["kind"], o: Partial<EyeReport> = {}): EyeReport => ({
  kind,
  taskId: null,
  facts: [],
  todo: [],
  ...o,
});

/** The Eye's last report in this job, to say nothing twice. */
function lastReport(db: Db, jobId: string) {
  const m = db
    .select()
    .from(eyeMessages)
    .where(and(eq(eyeMessages.jobId, jobId), eq(eyeMessages.author, "eye")))
    .orderBy(desc(eyeMessages.createdAt), desc(eyeMessages.id))
    .get();
  return m
    ? { text: m.text, kind: (m.action as { report?: EyeReport } | null)?.report?.kind }
    : null;
}

const code = (s: string) => `\`${s.replace(/`/g, "'")}\``;
const short = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** "Done: <task> — 2 files changed; its checks pass." */
function taskDone(d: ReportDeps, jobId: string, p: Payload) {
  // I finished it myself: nothing to tell me.
  if (p.reason === "I finished it.") return;
  const t = d.db
    .select()
    .from(tasks)
    .where(eq(tasks.id, String(p.taskId)))
    .get();
  if (!t) return;
  // The files its commits changed, read from git (Oraknid's own folder left out).
  const job = d.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  const shas = t.commits?.length ? t.commits : t.commit ? [{ repo: "", sha: t.commit }] : [];
  const files = shas.flatMap((c) => filesOf(job?.worktree ?? null, c.sha));
  const changed = !files.length
    ? "no file changed"
    : files.length <= 3
      ? `changed ${files.map((f) => code(f)).join(", ")}`
      : `changed ${files.length} files`;
  const checks = t.verify.length
    ? `its checks pass (${t.verify
        .slice(0, 2)
        .map((v) => code(short(v, 60)))
        .join(", ")}${t.verify.length > 2 ? `, +${t.verify.length - 2}` : ""})`
    : "reviewed by The Eye";
  const commits = (t.commits?.length ? t.commits : t.commit ? [{ repo: "", sha: t.commit }] : [])
    .map((c) => `${c.repo ? `${c.repo} ` : ""}${c.sha.slice(0, 7)}`)
    .join(", ");
  say(
    d,
    jobId,
    `Done: **${t.title}** — ${changed}; ${checks}.`,
    report("task-done", {
      taskId: t.id,
      facts: commits ? [{ label: "Commit", value: commits, href: null }] : [],
    }),
  );
}

/** The files a commit changed, as git names them (none when it can't tell). */
function filesOf(cwd: string | null, sha: string): string[] {
  if (!cwd) return [];
  const r = spawnSync("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", sha], {
    cwd,
    encoding: "utf8",
  });
  if (r.status !== 0) return [];
  return r.stdout.split("\n").filter((f) => f && !f.startsWith(".oraknid/"));
}

/** "Left out: <task>", and what it means for the job: the tasks that go with it. */
function leftOut(d: ReportDeps, jobId: string, p: Payload) {
  // Left out with another: said in that one's message.
  if (p.with) return;
  const t = d.db
    .select()
    .from(tasks)
    .where(eq(tasks.id, String(p.taskId)))
    .get();
  if (!t) return;
  const dropped = Array.isArray(p.dropped) ? (p.dropped as string[]) : [];
  const why = typeof p.reason === "string" && p.reason ? ` (${p.reason.replace(/\.$/, "")})` : "";
  const means = dropped.length
    ? `The tasks that need it are left out too: ${dropped.map((x) => `**${x}**`).join(", ")}. The job goes on without them.`
    : "The job goes on without it; the tasks that need it no longer wait for it.";
  say(
    d,
    jobId,
    `Left out: **${t.title}**${why}. ${means}`,
    report("task-left-out", {
      taskId: t.id,
      todo: ["Ask for it again here when you want it done."],
    }),
  );
}

function folderRestored(d: ReportDeps, jobId: string, p: Payload) {
  const problems = Array.isArray(p.problems)
    ? (p.problems as { problem: string }[]).map((x) => x.problem)
    : [];
  const restored = p.restored !== false;
  say(
    d,
    jobId,
    `The job's folder stopped belonging to the project (${problems.join("; ") || "its .git changed"}). ${
      restored
        ? "I put it back as a worktree of the project, keeping its files, and the task starts again."
        : "I couldn't put it back, so the job stops here: look at the folder, then resume it."
    }`,
    report("folder-restored", { taskId: typeof p.taskId === "string" ? p.taskId : null }),
  );
}

/** What a blocked job needs from me, in a line. */
function needs(reason: string): string {
  if (/failed \d+ attempts/.test(reason))
    return "Look at the task (its attempts and the inbox), then press Resume: its tasks get eight more tries.";
  if (/quota|usage limit|out of quota/i.test(reason))
    return "It resumes on its own when the limit resets; adding another Leg or allowing fallback starts it sooner.";
  if (/No Leg can take|no Legs/i.test(reason))
    return "Add or resume a Leg that can do it, then resume the job.";
  if (/took over/i.test(reason)) return "Mark the tasks you took over done, or hand them back.";
  if (/denied|refused/i.test(reason)) return "Tell me what to change here, then resume the job.";
  return "Resume it once that's sorted; tell me here if something should change.";
}

function blocked(d: ReportDeps, jobId: string, reason: string) {
  const text = `The job is blocked: ${reason.replace(/\.$/, "")}. ${needs(reason)}`;
  const last = lastReport(d.db, jobId);
  if (last?.kind === "blocked" && last.text === text) return;
  say(d, jobId, text, report("blocked", { todo: [needs(reason)] }));
}

/** Waiting for me: the question in the conversation too, once per item. */
function waiting(d: ReportDeps, jobId: string) {
  for (const item of d.inbox.list({ jobId, state: "open" })) {
    const asked = d.db.select().from(eyeMessages).where(eq(eyeMessages.itemId, item.id)).get();
    if (asked) continue;
    const questions = item.questions?.length
      ? item.questions
      : item.options.length
        ? normalizeQuestions([
            choiceQuestion(
              item.title,
              item.options.map((o) => ({ label: o, detail: "" })),
              item.defaultOption,
            ),
          ])
        : [];
    say(
      d,
      jobId,
      `I'm waiting for you: **${item.title}**${item.kind === "approval" ? " — nothing runs until you answer." : ""}`,
      report("waiting"),
      questions.length ? { questions, itemId: item.id } : {},
    );
  }
}

function cancelled(d: ReportDeps, jobId: string, reason: string) {
  const job = d.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!job) return;
  const kept = job.branch
    ? `The work so far stays on its branch ${code(job.branch)}.`
    : "The work so far stays in its folder.";
  say(
    d,
    jobId,
    `The job is stopped${reason ? `: ${reason.replace(/\.$/, "")}` : ""}. ${kept}`,
    report("cancelled", {
      facts: job.branch ? [{ label: "Branch", value: job.branch, href: null }] : [],
    }),
  );
}

/** The job done: what was built, where it is, what's left to me (ADR-045). */
export async function jobDone(d: ReportDeps, jobId: string) {
  const job = d.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!job) return;
  const all = d.db.select().from(tasks).where(eq(tasks.jobId, jobId)).all();
  const done = all.filter((t) => t.state === "done");
  const left = all.filter((t) => t.state === "skipped");
  let result: ReturnType<typeof jobResult> | null = null;
  try {
    result = jobResult(d.db, jobId);
  } catch {}
  const ending = readEnding(d.db, jobId).done;
  const facts: EyeReport["facts"] = [];
  const todo: string[] = [];
  if (result?.branch)
    facts.push({
      label: "Branch",
      value: `${result.branch} · ${result.commits.length} commit${result.commits.length === 1 ? "" : "s"}`,
      href: null,
    });
  if (ending?.merged) facts.push({ label: "Merged into", value: ending.merged.into, href: null });
  for (const p of ending?.pushed ?? [])
    facts.push({ label: "Pushed", value: `${p.branch} → ${p.repo}`, href: p.url });
  // A server job's place is its server (ADR-049): nothing to merge, its state document to show.
  const serverId = serverOf(d.db, job.projectId);
  if (result && !result.merged && result.commits.length && !ending?.merged && !serverId)
    todo.push(`Merge it into ${result.into}: the Merge button on the result.`);
  for (const problem of ending?.problems ?? []) todo.push(problem);
  if (!job.verify.length) todo.push("No job-level check ran: try the result by hand.");
  if (left.length)
    todo.push(`Left out: ${left.map((t) => t.title).join(", ")}; ask again here to do them.`);
  const built = `${done.length} task${done.length === 1 ? "" : "s"} done: ${done
    .slice(0, 6)
    .map((t) => t.title)
    .join("; ")}${done.length > 6 ? "; …" : ""}.`;
  let summary = `The job is done: ${built}`;
  if (d.brain?.summarizeJob) {
    try {
      const facts = [
        built,
        result?.commits.length
          ? `Commits:\n${result.commits.map((c) => `- ${c.subject}`).join("\n")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      const r = await d.brain.summarizeJob({
        jobId,
        cwd: job.worktree ?? process.cwd(),
        goal: job.goal,
        facts,
      });
      if (r.summary.trim()) summary = `The job is done. ${r.summary.trim()}`;
    } catch {
      // The facts alone say it well enough.
    }
  }
  if (serverId && d.servers) summary += await serverChanges(d, serverId, jobId, facts, todo);
  say(d, jobId, summary, report("job-done", { facts, todo }));
}

/**
 * What a server job changed in its server's state document (ADR-049): the
 * version its end wrote, the diff from the one before, and the backup plans
 * to look at when the data changed. The text to add to the report.
 */
async function serverChanges(
  d: ReportDeps,
  serverId: string,
  jobId: string,
  facts: EyeReport["facts"],
  todo: string[],
): Promise<string> {
  const servers = d.servers as Servers;
  let name = "the server";
  try {
    name = servers.row(serverId).name;
  } catch {
    return "";
  }
  const v = servers.afterJob(serverId, jobId);
  if (!v) {
    todo.push(`${name}'s state document wasn't updated: press Discover again on its page.`);
    return "";
  }
  facts.push({
    label: "State document",
    value: `${name} · version ${v.after.version}`,
    href: `/servers/${serverId}/state`,
  });
  const diff = stateDiff(v.before?.body ?? "", v.after.body);
  if (!diff) return `\n\n${name}'s state document is the same as before.`;
  if (/\b(postgres|mysql|mariadb|mongo|redis|sqlite|database)/i.test(diff) && d.backupPlans) {
    const plans = await d.backupPlans(serverId).catch(() => []);
    if (plans.length)
      todo.push(
        `Its data changed: check the backup plans of ${name} still back up what they should (${plans.map((p) => p.name).join(", ")}).`,
      );
  }
  const shown = diff.length > 6000 ? `${diff.slice(0, 6000)}\n…` : diff;
  return `\n\nWhat changed in ${name}'s state document (version ${v.after.version}):\n\n\`\`\`diff\n${shown}\n\`\`\``;
}
