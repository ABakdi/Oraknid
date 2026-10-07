import { z } from "zod";
import { GitHubName, RepoOwner } from "./github.ts";

// Git hosts besides GitHub (ADR-062): GitLab (gitlab.com or my own) and
// Gitea or Forgejo (my own), each account a personal access token in the
// keychain. GitHub stays as it is (ADR-023, ADR-038, ADR-040); these share
// its shapes for repositories, commits, branches and pull requests.

/** The kinds of git host Oraknid speaks to. Forgejo speaks Gitea's API. */
export const GitHostKind = z.enum(["github", "gitlab", "gitea"]);
export type GitHostKind = z.infer<typeof GitHostKind>;

/** The id of GitHub as a host: a link without `host` is GitHub's. */
export const GITHUB_HOST = "github";

/**
 * Which host: "github", or another host's address without its scheme
 * (`gitlab.com`, `git.example.org:3000`, `example.org/gitea`).
 */
export const GitHostId = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~-]+)*$/, "a host name, with a port or path");
export type GitHostId = z.infer<typeof GitHostId>;

/** One of my accounts on a git host other than GitHub; its token never leaves the keychain. */
export const GitHostAccount = z.object({
  host: z.string(),
  kind: GitHostKind,
  /** The host's address, `https://gitlab.com`. */
  url: z.string(),
  login: z.string(),
  /** Why it can't be used now (the host refused the token, or couldn't be reached). */
  error: z.string().nullable(),
});
export type GitHostAccount = z.infer<typeof GitHostAccount>;

/** A token pasted for GitLab or Gitea/Forgejo, at an address (GitLab's own by default). */
export const NewGitHostAccount = z.object({
  kind: z.enum(["gitlab", "gitea"]),
  /** `https://gitlab.com`, `https://git.example.org`; plain http only for this computer. */
  url: z.string().url().max(300),
  token: z.string().min(8).max(500),
});
export type NewGitHostAccount = z.infer<typeof NewGitHostAccount>;

/** Which repository on which host, and optionally through which account. */
export const HostRepoRef = z.object({
  host: z.string().default(GITHUB_HOST),
  owner: RepoOwner,
  name: GitHubName,
  account: z.string().optional(),
});
export type HostRepoRef = z.infer<typeof HostRepoRef>;

/** A host as the Repos page offers it: GitHub, or one I added an account on. */
export const GitHostView = z.object({
  host: z.string(),
  kind: GitHostKind,
  url: z.string(),
  /** "GitHub", "GitLab (gitlab.com)", "Forgejo (git.example.org)". */
  label: z.string(),
  /** What its pull requests are called: "Merge requests" on GitLab. */
  pullsName: z.string(),
});
export type GitHostView = z.infer<typeof GitHostView>;
