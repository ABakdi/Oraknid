import {
  CiArtifact,
  CiBadge,
  CiLog,
  CiRunDetail,
  CiRunPage,
  CiRunRef,
  CiWorkflow,
  GitHubRepoRef,
  Id,
} from "@oraknid/contracts";
import { ORPCError, os } from "@orpc/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Downloads } from "../cloud/routes.ts";
import { events as eventsTable } from "../db/schema.ts";
import type { JobStore } from "../engine/jobs.ts";
import type { EventBus } from "../events/bus.ts";
import { readEnding } from "../eye/ending.ts";
import { GitHubError } from "../workspace/github.ts";
import type { Ci, CiRepo } from "../workspace/github-ci.ts";
import type { Repos } from "../workspace/github-repos.ts";
import type { Projects } from "../workspace/projects.ts";

// GitHub Actions inside Oraknid (ADR-058, API-Contract → CI). Reads are
// free; re-running, cancelling and running a workflow by hand are mine from
// the page, audited (an agent's or the helper's go through approvals, not
// here). An artifact is downloaded through a one-time link (ADR-046),
// never away from home.

interface CiContext {
  ci: Ci;
  repos: Repos;
  downloads: Downloads;
  bus: EventBus;
  remote: boolean;
  projects: Projects;
  jobs: JobStore;
}

const base = os.$context<CiContext>();

async function guard<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ORPCError) throw error;
    if (error instanceof GitHubError)
      throw new ORPCError(
        error.retryAt
          ? "TOO_MANY_REQUESTS"
          : error.status === 404
            ? "NOT_FOUND"
            : error.status === 403
              ? "FORBIDDEN"
              : error.status === 409
                ? "CONFLICT"
                : "BAD_REQUEST",
        { message: error.message, data: { retryAt: error.retryAt } },
      );
    if (error instanceof Error && error.constructor === Error)
      throw new ORPCError(/^No (project|job)\b/.test(error.message) ? "NOT_FOUND" : "BAD_REQUEST", {
        message: error.message,
      });
    console.error("request failed", error);
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "Something went wrong inside Oraknid; the details are in its log (oraknid logs).",
    });
  }
}

/** The repository and the account that reads it (ADR-040's rule). */
const repoOf = async (c: CiContext, ref: GitHubRepoRef): Promise<CiRepo> => ({
  owner: ref.owner,
  name: ref.name,
  account: await c.repos.accountFor(ref),
});

const audit = (c: CiContext, type: string, payload: Record<string, unknown>) =>
  c.bus.publish({ type, topic: "overview", jobId: null, payload, actor: "owner" });

/** A project's repo with its link, and its two branches' badges. */
export const CiProjectRepo = z.object({
  repo: z.string(),
  fullName: z.string(),
  account: z.string(),
  releaseBranch: z.string(),
  workBranch: z.string(),
  release: CiBadge,
  work: CiBadge.nullable(),
});
export type CiProjectRepo = z.infer<typeof CiProjectRepo>;

/** What a job's CI is about: its pull request, or the branch it pushed. */
export const CiForJob = z.object({
  fullName: z.string(),
  owner: z.string(),
  name: z.string(),
  account: z.string(),
  branch: z.string(),
  pullRequest: z.number().int().nullable(),
  badge: CiBadge,
});
export type CiForJob = z.infer<typeof CiForJob>;

export const ciRouter = {
  /** A repository's runs, newest first, 20 a page; a branch's or a workflow's when asked. */
  runs: base
    .input(
      GitHubRepoRef.extend({
        branch: z.string().min(1).optional(),
        workflowId: z.number().int().positive().optional(),
        page: z.number().int().positive().default(1),
      }),
    )
    .output(CiRunPage)
    .handler(({ context: c, input }) =>
      guard(async () =>
        c.ci.runs(await repoOf(c, input), {
          branch: input.branch ?? null,
          workflowId: input.workflowId ?? null,
          page: input.page,
        }),
      ),
    ),
  /** A run with its jobs and steps. */
  run: base
    .input(CiRunRef)
    .output(CiRunDetail)
    .handler(({ context: c, input }) =>
      guard(async () => c.ci.run(await repoOf(c, input), input.runId)),
    ),
  /** A job's log, by step, the failing step first; `q` marks the matching lines. */
  log: base
    .input(
      GitHubRepoRef.extend({
        jobId: z.number().int().positive(),
        q: z.string().max(200).optional(),
      }),
    )
    .output(CiLog)
    .handler(({ context: c, input }) =>
      guard(async () =>
        c.ci.log(await repoOf(c, input), input.jobId, input.q ? { q: input.q } : {}),
      ),
    ),
  artifacts: base
    .input(CiRunRef)
    .output(z.array(CiArtifact))
    .handler(({ context: c, input }) =>
      guard(async () => c.ci.artifacts(await repoOf(c, input), input.runId)),
    ),
  /** A one-time link (two minutes) to download an artifact's zip through the daemon. */
  artifactLink: base
    .input(GitHubRepoRef.extend({ artifactId: z.number().int().positive() }))
    .output(z.object({ url: z.string(), expiresAt: z.number() }))
    .handler(({ context: c, input }) =>
      guard(async () => {
        if (c.remote)
          throw new ORPCError("FORBIDDEN", {
            message:
              "Downloads go to a browser on the computer running Oraknid; away from home they aren't available yet.",
          });
        const r = await repoOf(c, input);
        return c.downloads.mint(() => c.ci.openArtifact(r, input.artifactId));
      }),
    ),
  /** The workflows, each with whether it can be run by hand and its inputs. */
  workflows: base
    .input(GitHubRepoRef)
    .output(z.array(CiWorkflow))
    .handler(({ context: c, input }) => guard(async () => c.ci.workflows(await repoOf(c, input)))),
  /** Runs it again: every job, or only those that failed (`failedOnly`). Audited. */
  rerun: base
    .input(CiRunRef.extend({ failedOnly: z.boolean().default(true) }))
    .handler(({ context: c, input }) =>
      guard(async () => {
        const r = await repoOf(c, input);
        await c.ci.rerun(r, input.runId, input.failedOnly);
        audit(c, "ci.rerun", {
          fullName: `${r.owner}/${r.name}`,
          runId: input.runId,
          failedOnly: input.failedOnly,
        });
      }),
    ),
  cancel: base.input(CiRunRef).handler(({ context: c, input }) =>
    guard(async () => {
      const r = await repoOf(c, input);
      await c.ci.cancel(r, input.runId);
      audit(c, "ci.cancelled", { fullName: `${r.owner}/${r.name}`, runId: input.runId });
    }),
  ),
  /** Runs a workflow by hand on a branch or tag, with its inputs. Audited. */
  dispatch: base
    .input(
      GitHubRepoRef.extend({
        workflowId: z.number().int().positive(),
        ref: z.string().min(1).max(250),
        inputs: z.record(z.string(), z.string().max(4000)).default({}),
      }),
    )
    .handler(({ context: c, input }) =>
      guard(async () => {
        const r = await repoOf(c, input);
        await c.ci.dispatch(r, input.workflowId, input.ref, input.inputs);
        audit(c, "ci.dispatched", {
          fullName: `${r.owner}/${r.name}`,
          workflowId: input.workflowId,
          ref: input.ref,
          inputs: Object.keys(input.inputs),
        });
      }),
    ),
  /** A branch's CI at a glance. */
  badge: base
    .input(GitHubRepoRef.extend({ branch: z.string().min(1) }))
    .output(CiBadge)
    .handler(({ context: c, input }) =>
      guard(async () => c.ci.badge(await repoOf(c, input), input.branch)),
    ),
  /** A project's linked repos, each with its release and work branches' badges. */
  project: base
    .input(z.object({ id: Id }))
    .output(z.array(CiProjectRepo))
    .handler(({ context: c, input }) =>
      guard(async () => {
        const p = c.projects.require(input.id);
        const out: CiProjectRepo[] = [];
        for (const repo of p.repos) {
          const l = repo.github;
          if (!l?.ready) continue;
          const r = { owner: l.owner, name: l.name, account: l.account };
          const [release, work] = await Promise.all([
            c.ci.badge(r, repo.releaseBranch),
            repo.workBranch !== repo.releaseBranch
              ? c.ci.badge(r, repo.workBranch)
              : Promise.resolve(null),
          ]);
          out.push({
            repo: repo.name,
            fullName: `${l.owner}/${l.name}`,
            account: l.account,
            releaseBranch: repo.releaseBranch,
            workBranch: repo.workBranch,
            release,
            work,
          });
        }
        return out;
      }),
    ),
  /**
   * A job's CI: its pull request's head (the github tool's), else the branch
   * it pushed (its end steps' or the tool's); null when it put nothing on GitHub.
   */
  forJob: base
    .input(z.object({ id: Id }))
    .output(CiForJob.nullable())
    .handler(({ context: c, input }) =>
      guard(async () => {
        const job = c.jobs.require(input.id);
        const p = c.projects.require(job.projectId);
        const links = p.repos.flatMap((r) => (r.github?.ready ? [r.github] : []));
        const linkOf = (fullName: string) =>
          links.find((l) => `${l.owner}/${l.name}`.toLowerCase() === fullName.toLowerCase());
        const rows = c.jobs.db
          .select()
          .from(eventsTable)
          .where(
            and(
              eq(eventsTable.jobId, job.id),
              inArray(eventsTable.type, ["github.pull-request", "github.pushed"]),
            ),
          )
          .orderBy(desc(eventsTable.seq))
          .all();
        let found: { fullName: string; branch: string; pr: number | null } | null = null;
        const pr = rows.find((e) => e.type === "github.pull-request");
        if (pr) {
          const x = pr.payload as { repo?: string; head?: string; number?: number };
          if (x.repo && x.head) found = { fullName: x.repo, branch: x.head, pr: x.number ?? null };
        }
        if (!found) {
          const pushed = rows.find((e) => e.type === "github.pushed");
          const x = (pushed?.payload ?? {}) as { repo?: string; to?: string };
          if (x.repo && x.to) found = { fullName: x.repo, branch: x.to, pr: null };
        }
        if (!found) {
          const done = readEnding(c.jobs.db, job.id).done?.pushed[0];
          const fullName = done?.repo.includes("/")
            ? done.repo
            : links[0]
              ? `${links[0].owner}/${links[0].name}`
              : null;
          if (done && fullName) found = { fullName, branch: done.branch, pr: null };
        }
        if (!found) return null;
        const [owner = "", name = ""] = found.fullName.split("/");
        const link = linkOf(found.fullName);
        const account = link?.account ?? (await c.repos.accountFor({ owner, name }));
        const badge = await c.ci.badge({ owner, name, account }, found.branch);
        return {
          fullName: found.fullName,
          owner,
          name,
          account,
          branch: found.branch,
          pullRequest: found.pr,
          badge,
        };
      }),
    ),
};
