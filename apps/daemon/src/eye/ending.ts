import { join } from "node:path";
import type { JobEnding } from "@oraknid/contracts";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/open.ts";
import { jobs, projects } from "../db/schema.ts";
import type { JobContext } from "../engine/runner.ts";
import type { EventBus } from "../events/bus.ts";
import type { InboxStore } from "../inbox/store.ts";
import { readSetting, writeSetting } from "../settings.ts";
import { isMerged } from "../workspace/git.ts";
import type { GitHub } from "../workspace/github.ts";
import { githubCall } from "../workspace/github-tool.ts";
import { hostFor } from "../workspace/hosts/registry.ts";
import { type Projects, viewOf } from "../workspace/projects.ts";
import { isSeveral } from "../workspace/repos.ts";
import { mergeJob } from "../workspace/result.ts";
import { projectWork } from "./evaluations.ts";
import { ensureLinks } from "./links.ts";

// The repo's part is Oraknid's (Jobs-and-Projects → Ending a job, after the
// piano job, 2026-10-03): merging the job into the work branch and pushing
// to the project's linked GitHub repo are Oraknid's own steps when the job
// ends, never tasks for a Leg. The goal (through the plan) or my message
// asks for them; a merge asked for in so many words is my approval of it.

export const JobEndingState = z.object({
  merge: z.boolean().default(false),
  push: z.boolean().default(false),
  /** Who asked: "the goal", "my message". */
  from: z.array(z.string()).default([]),
  /** What was done, once it ran. */
  done: z
    .object({
      merged: z.object({ into: z.string(), commit: z.string() }).nullable().default(null),
      pushed: z
        .array(z.object({ repo: z.string(), branch: z.string(), url: z.string() }))
        .default([]),
      problems: z.array(z.string()).default([]),
    })
    .nullable()
    .default(null),
});
export type JobEndingState = z.infer<typeof JobEndingState>;
export type EndingDone = NonNullable<JobEndingState["done"]>;

const NONE: JobEndingState = { merge: false, push: false, from: [], done: null };
export const endingKey = (jobId: string) => `job.ending.${jobId}`;

export const readEnding = (db: Db, jobId: string): JobEndingState =>
  readSetting(db, endingKey(jobId), JobEndingState, NONE);

/** Asks for the end steps (added to what was asked before); a request after they ran asks again. */
export function requestEnding(
  db: Db,
  jobId: string,
  want: Partial<JobEnding> | undefined,
  from: string,
): boolean {
  if (!want?.merge && !want?.push) return false;
  const was = readEnding(db, jobId);
  writeSetting(db, endingKey(jobId), JobEndingState, {
    merge: was.merge || !!want.merge,
    push: was.push || !!want.push,
    from: [...new Set([...was.from, from])],
    done: null,
  });
  return true;
}

export interface EndingDeps {
  db: Db;
  bus: EventBus;
  inbox: InboxStore;
  github?: GitHub;
  projects?: Projects;
  now: () => number;
}

/**
 * Before the job completes: its GitHub link asked for first when a push
 * is wanted and the project has none (ADR-038; the job waits for my answer),
 * then the end steps, journaled. Returns what was done, or null when
 * nothing was asked.
 */
export async function runEnding(
  d: EndingDeps,
  ctx: JobContext,
  job: { id: string; projectId: string; goal: string },
): Promise<EndingDone | null> {
  // A completed job lands in my project (ADR-064 §8): merged as the project's setting says, or I'm asked.
  await ctx.step("ending:merge-setting", null, async () => mergeBySetting(d, job.id));
  const want = readEnding(d.db, job.id);
  if (!want.merge && !want.push) return null;
  if (want.done) return want.done;
  if (want.push && d.github && d.projects)
    await ensureLinks(
      d,
      ctx,
      job,
      // The words that make it ask for GitHub; no task row behind it.
      {
        id: `${job.id}-ending`,
        title: "Push the job's work to GitHub",
        instructions: "",
        scope: [],
        ending: true,
      },
    );
  return ctx.step("ending", { merge: want.merge, push: want.push }, async () =>
    endSteps(d, job.id),
  );
}

/** The end steps themselves: the merge, then the push, each said in what it returns. */
export async function endSteps(
  d: Omit<EndingDeps, "inbox" | "now"> & { inbox?: InboxStore },
  jobId: string,
): Promise<EndingDone> {
  const want = readEnding(d.db, jobId);
  const job = d.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  const row = job ? d.db.select().from(projects).where(eq(projects.id, job.projectId)).get() : null;
  const done: EndingDone = { merged: null, pushed: [], problems: [] };
  if (!job || !row) {
    done.problems.push("The job or its project is gone.");
    return done;
  }
  const project = viewOf(row);
  const several = isSeveral(project.repos);
  if (want.merge) {
    const m = mergeJob(d.db, d.bus, jobId, true);
    if (m.ok) done.merged = { into: project.workBranch, commit: m.commit };
    else if (!/already/i.test(m.reason)) {
      done.problems.push(`Merging into ${project.workBranch}: ${m.reason}`);
      // Not merged: I'm asked what to do, the job's branch kept as it is (ADR-064 §8).
      if (d.inbox) askToMerge(d as MergeDeps, jobId, project.workBranch, m);
    }
  }
  if (want.push) {
    const github = d.github;
    const projectsSvc = d.projects;
    if (!github || !projectsSvc) done.problems.push("GitHub isn't set up in Oraknid.");
    else {
      const touched = new Set(job.repos.map((r) => r.name));
      const targets = several ? project.repos.filter((r) => touched.has(r.name)) : project.repos;
      for (const r of targets) {
        const link = r.github;
        const name = several ? r.name : undefined;
        if (!link) {
          done.problems.push(
            `${several ? `The repo ${r.name}` : "The project"} has no GitHub repo linked: nothing pushed.`,
          );
          continue;
        }
        const path = r.folder
          ? join(project.workspacePath, ...r.folder.split("/"))
          : project.workspacePath;
        // The work branch once the job is in it; else the job's own branch, for me to merge.
        const branch =
          job.branch && !isMerged(path, r.workBranch, job.branch) ? job.branch : r.workBranch;
        const deps = { db: d.db, bus: d.bus, github, projects: projectsSvc };
        try {
          if (!link.ready) await githubCall(deps, jobId, "create_repo", name ? { repo: name } : {});
          await githubCall(deps, jobId, "push", { branch, ...(name ? { repo: name } : {}) });
          done.pushed.push({
            repo: `${link.owner}/${link.name}`,
            branch,
            url:
              hostFor(github, link)?.branchUrl(`${link.owner}/${link.name}`, branch) ??
              `https://github.com/${link.owner}/${link.name}/tree/${branch}`,
          });
        } catch (error) {
          done.problems.push(
            `Pushing ${branch} to ${link.owner}/${link.name}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  }
  writeSetting(d.db, endingKey(jobId), JobEndingState, { ...want, done });
  d.bus.publish({
    type: "job.ending",
    topic: `job:${jobId}`,
    jobId,
    payload: { ...done },
    actor: "eye",
  });
  return done;
}

// ── The job lands in my project (ADR-064 §8, after the Keys job) ───────

interface MergeDeps {
  db: Db;
  bus: EventBus;
  inbox: InboxStore;
}

const MERGE = "Merge into";
const RETRY = "Try the merge again";
const KEEP = "Keep it on its branch";
const MergeAsked = z.array(z.string());
const mergeAskedKey = (jobId: string) => `job.mergeAsked.${jobId}`;

/**
 * Before the end steps: a job that has a branch to merge is merged into
 * the work branch when the project says "merge" (the default), as if I had
 * asked; with "ask", I'm asked in the inbox and the job completes
 * meanwhile. A job I asked to merge in words is merged either way.
 */
function mergeBySetting(d: EndingDeps, jobId: string) {
  const want = readEnding(d.db, jobId);
  if (want.merge || want.done) return null;
  const job = d.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  const row = job ? d.db.select().from(projects).where(eq(projects.id, job.projectId)).get() : null;
  if (!job?.branch || !row?.isGitRepo || row.serverId) return null;
  const setting = projectWork(d.db, row.id).merge;
  if (setting === "merge") {
    requestEnding(d.db, jobId, { merge: true }, "the project's setting");
    return "merge";
  }
  const into = viewOf(row).workBranch;
  openMergeQuestion(d, jobId, {
    title: `Merge “${job.title}” into ${into}?`,
    detail: `The job is done and its work is on its branch ${job.branch}. The project's setting asks before merging: merge it into ${into}, or keep it on its branch (the Merge button on the job does it later).`,
    options: [`${MERGE} ${into}`, KEEP],
  });
  return "ask";
}

function openMergeQuestion(
  d: { db: Db; inbox: InboxStore },
  jobId: string,
  q: { title: string; detail: string; options: string[] },
) {
  const id = d.inbox.open({
    kind: "question",
    jobId,
    raisedBy: "eye",
    title: q.title,
    detail: q.detail,
    options: q.options,
    defaultOption: null,
  });
  writeSetting(d.db, mergeAskedKey(jobId), MergeAsked, [
    ...readSetting(d.db, mergeAskedKey(jobId), MergeAsked, []),
    id,
  ]);
}

/** A merge that didn't happen (a conflict, uncommitted changes in my checkout): I'm asked what next. */
function askToMerge(
  d: MergeDeps,
  jobId: string,
  into: string,
  m: { reason: string; conflicts: string[] },
) {
  openMergeQuestion(d, jobId, {
    title: `The job couldn't be merged into ${into}`,
    detail: [
      m.reason,
      m.conflicts.length ? `Conflicting: ${m.conflicts.map((f) => `\`${f}\``).join(", ")}` : "",
      "Nothing was merged; the work is on the job's branch. Put it right, then try again, or keep it on its branch.",
    ]
      .filter(Boolean)
      .join("\n\n"),
    options: [RETRY, KEEP],
  });
}

/** My answer to "merge it?": merged now (asked again if it can't be), or left on its branch. */
export function answerMerge(d: MergeDeps, jobId: string, itemId: string) {
  if (!readSetting(d.db, mergeAskedKey(jobId), MergeAsked, []).includes(itemId)) return;
  const answer = d.inbox.get(itemId)?.answer ?? "";
  if (!answer.startsWith(MERGE) && answer !== RETRY) return;
  const m = mergeJob(d.db, d.bus, jobId, false);
  const job = d.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  const row = job ? d.db.select().from(projects).where(eq(projects.id, job.projectId)).get() : null;
  if (!m.ok && !/already/i.test(m.reason) && row) askToMerge(d, jobId, viewOf(row).workBranch, m);
}

/** The questions a job's end asked (whether to merge it): they outlive the job (ADR-064 §8). */
export const asksAfterEnd = (db: Db, jobId: string) =>
  new Set(readSetting(db, mergeAskedKey(jobId), MergeAsked, []));
