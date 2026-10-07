import {
  GitHostAccount,
  GitHostView,
  GitHubBranch,
  GitHubCommitDetail,
  GitHubCommitSummary,
  GitHubFile,
  GitHubName,
  GitHubPullDetail,
  GitHubPullSummary,
  GitHubRepoDetail,
  GitHubRepoList,
  GitHubTree,
  githubPage,
  HostRepoRef,
  NewGitHostAccount,
  RepoOwner,
} from "@oraknid/contracts";
import { ORPCError, os } from "@orpc/server";
import { z } from "zod";
import type { EventBus } from "../events/bus.ts";
import { GitHubError } from "../workspace/github.ts";
import { HostError } from "../workspace/hosts/host.ts";
import type { GitHosts } from "../workspace/hosts/registry.ts";

// Git hosts (ADR-062, API-Contract → hosts): GitLab, Gitea and Forgejo
// accounts by token, and the Repos page's reads on any host, GitHub's
// included (then the same as `github.*`). Adding and removing an account
// and creating a repository are home only for a standard device.

const base = os.$context<{ hosts: GitHosts; bus: EventBus }>();

async function guard<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ORPCError) throw error;
    if (error instanceof HostError || error instanceof GitHubError)
      throw new ORPCError(
        error.status === 404
          ? "NOT_FOUND"
          : error.status === 403 || error.status === 429
            ? "TOO_MANY_REQUESTS"
            : "BAD_REQUEST",
        { message: error.message },
      );
    if (error instanceof Error && error.constructor === Error)
      throw new ORPCError(/already/.test(error.message) ? "CONFLICT" : "BAD_REQUEST", {
        message: error.message,
      });
    console.error("request failed", error);
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "Something went wrong inside Oraknid; the details are in its log (oraknid logs).",
    });
  }
}

const browse = (c: { hosts: GitHosts }, r: { host: string }) => c.hosts.get(r.host).browse;

export const hostsRouter = {
  /** GitHub, then each host I have an account on. */
  list: base.output(z.array(GitHostView)).handler(({ context: c }) => c.hosts.views()),
  /** My accounts on GitLab, Gitea and Forgejo; `check` asks each host whether its token still works. */
  accounts: base
    .input(z.object({ check: z.boolean().default(false) }).default({ check: false }))
    .output(z.array(GitHostAccount))
    .handler(({ context: c, input }) => guard(() => c.hosts.list(input.check))),
  /** A token checked against its host and kept in the keychain under its account's name. */
  addAccount: base
    .input(NewGitHostAccount)
    .output(z.object({ host: z.string(), login: z.string() }))
    .handler(({ context: c, input }) =>
      guard(async () => {
        const r = await c.hosts.add(input);
        c.bus.publish({
          type: "githost.connected",
          topic: "overview",
          jobId: null,
          payload: { host: r.host, login: r.login, kind: input.kind },
          actor: "owner",
        });
        return r;
      }),
    ),
  removeAccount: base
    .input(z.object({ host: z.string(), login: z.string() }))
    .handler(({ context: c, input }) =>
      guard(async () => {
        await c.hosts.remove(input.host, input.login);
        c.bus.publish({
          type: "githost.disconnected",
          topic: "overview",
          jobId: null,
          payload: input,
          actor: "owner",
        });
      }),
    ),
  /** An account's repositories on a host (New work's picker). */
  repos: base
    .input(z.object({ host: z.string(), login: z.string().optional() }))
    .output(
      z.array(
        z.object({
          fullName: z.string(),
          name: z.string(),
          private: z.boolean(),
          description: z.string().nullable(),
          updatedAt: z.string().nullable(),
        }),
      ),
    )
    .handler(({ context: c, input }) =>
      guard(() => c.hosts.get(input.host).repos(input.login ?? null)),
    ),
  /** Every host's repositories (or one host's, or one account's there), most recent first. */
  repoList: base
    .input(z.object({ host: z.string().optional(), account: z.string().optional() }).default({}))
    .output(GitHubRepoList)
    .handler(({ context: c, input }) =>
      guard(() => c.hosts.repoList(input.host ?? null, input.account ?? null)),
    ),
  repoInfo: base
    .input(HostRepoRef)
    .output(GitHubRepoDetail)
    .handler(({ context: c, input }) => guard(() => browse(c, input).info(input))),
  branches: base
    .input(HostRepoRef.extend({ page: z.number().int().positive().default(1) }))
    .output(githubPage(GitHubBranch))
    .handler(({ context: c, input }) => guard(() => browse(c, input).branches(input, input.page))),
  tree: base
    .input(
      HostRepoRef.extend({
        ref: z.string().min(1),
        path: z.string().default(""),
        recursive: z.boolean().default(false),
      }),
    )
    .output(GitHubTree)
    .handler(({ context: c, input }) =>
      guard(() => browse(c, input).tree(input, input.ref, input.path, input.recursive)),
    ),
  file: base
    .input(HostRepoRef.extend({ ref: z.string().min(1), path: z.string().min(1) }))
    .output(GitHubFile)
    .handler(({ context: c, input }) =>
      guard(() => browse(c, input).file(input, input.ref, input.path)),
    ),
  readme: base
    .input(HostRepoRef.extend({ ref: z.string().min(1) }))
    .output(GitHubFile.nullable())
    .handler(({ context: c, input }) => guard(() => browse(c, input).readme(input, input.ref))),
  commits: base
    .input(
      HostRepoRef.extend({
        branch: z.string().min(1),
        page: z.number().int().positive().default(1),
      }),
    )
    .output(githubPage(GitHubCommitSummary))
    .handler(({ context: c, input }) =>
      guard(() => browse(c, input).commits(input, input.branch, input.page)),
    ),
  commit: base
    .input(HostRepoRef.extend({ sha: z.string().regex(/^[0-9a-fA-F]{4,64}$/) }))
    .output(GitHubCommitDetail)
    .handler(({ context: c, input }) => guard(() => browse(c, input).commit(input, input.sha))),
  pulls: base
    .input(
      HostRepoRef.extend({
        state: z.enum(["open", "closed"]).default("open"),
        page: z.number().int().positive().default(1),
      }),
    )
    .output(githubPage(GitHubPullSummary))
    .handler(({ context: c, input }) =>
      guard(() => browse(c, input).pulls(input, input.state, input.page)),
    ),
  pull: base
    .input(HostRepoRef.extend({ number: z.number().int().positive() }))
    .output(GitHubPullDetail)
    .handler(({ context: c, input }) => guard(() => browse(c, input).pull(input, input.number))),
  /** A new repository of mine on a host (with a README, so it can be cloned at once); audited. */
  createRepo: base
    .input(
      z.object({
        host: z.string(),
        account: z.string().optional(),
        /** A group or organisation; my own namespace when left out. */
        owner: RepoOwner.optional(),
        name: GitHubName,
        private: z.boolean().default(true),
        description: z.string().max(350).optional(),
      }),
    )
    .output(
      z.object({ host: z.string(), account: z.string(), owner: z.string(), name: z.string() }),
    )
    .handler(({ context: c, input }) =>
      guard(async () => {
        const h = c.hosts.get(input.host);
        const login = input.account ?? (await h.accounts())[0]?.login ?? null;
        const repo = await h.createRepo(
          {
            name: input.name,
            private: input.private,
            ...(input.owner ? { owner: input.owner } : {}),
            ...(input.description ? { description: input.description } : {}),
          },
          login,
        );
        c.bus.publish({
          type: "github.repo-created",
          topic: "overview",
          jobId: null,
          payload: { host: h.id, fullName: repo.fullName, private: input.private },
          actor: "owner",
        });
        const cut = repo.fullName.lastIndexOf("/");
        const owner = repo.fullName.slice(0, cut);
        return {
          host: h.id,
          account: login ?? owner,
          owner,
          name: repo.fullName.slice(cut + 1),
        };
      }),
    ),
};
