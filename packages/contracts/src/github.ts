import { z } from "zod";
import { Timestamp } from "./common.ts";

// GitHub accounts and a project's GitHub link (ADR-023, ADR-038).

/** One of my GitHub tokens, named by its account. The token itself never leaves the keychain. */
export const GitHubAccount = z.object({
  login: z.string(),
  /** Why it can't be used now (GitHub refused it, or couldn't be reached to name it). */
  error: z.string().nullable(),
});
export type GitHubAccount = z.infer<typeof GitHubAccount>;

export const GitHubVisibility = z.enum(["public", "private"]);
export type GitHubVisibility = z.infer<typeof GitHubVisibility>;

export const GitHubName = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,100}$/, "letters, digits, dots, dashes and underscores")
  .refine((n) => n !== "." && n !== "..", "a name");

/** An owner: a user, an organisation, or (GitLab, ADR-062) a group with its subgroups. */
export const RepoOwner = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (o) => o.split("/").every((p) => GitHubName.safeParse(p).success),
    "letters, digits, dots, dashes and underscores, groups parted by /",
  );

/**
 * A project's GitHub link (ADR-038): the account Oraknid uses for it and
 * its repository. Pushing a branch there, creating it when it is new, and
 * opening a pull request there run without asking: the link is my approval.
 */
export const GitHubLink = z.object({
  /**
   * The git host (ADR-062): absent for GitHub, else another host's id
   * (`gitlab.com`, `git.example.org`). The same link, tool and gates.
   */
  host: z.string().min(1).max(200).optional(),
  /** The account's login: which of my tokens is used. */
  account: z.string().min(1),
  /** A user or organisation; on GitLab a group may have subgroups (`group/sub`). */
  owner: RepoOwner,
  name: GitHubName,
  visibility: GitHubVisibility,
  /** "new": Oraknid creates it (the github tool's create_repo); "existing": it is there. */
  origin: z.enum(["new", "existing"]),
  /** False until a new repo has been created. */
  ready: z.boolean(),
  linkedAt: Timestamp,
});
export type GitHubLink = z.infer<typeof GitHubLink>;

/** What I set in a project's Settings, or answered The Eye. */
export const GitHubLinkInput = GitHubLink.pick({
  host: true,
  account: true,
  owner: true,
  name: true,
  visibility: true,
  origin: true,
});
export type GitHubLinkInput = z.infer<typeof GitHubLinkInput>;

// ── Repos (ADR-040): my repositories read through the REST API with an
// account's token, in the daemon; the token never reaches the browser.

/** The project that links a repository, if any (ADR-038). */
export const GitHubLinkedProject = z.object({ id: z.string(), name: z.string() });
export type GitHubLinkedProject = z.infer<typeof GitHubLinkedProject>;

/** One of my repositories, as the list shows it. */
export const GitHubRepoSummary = z.object({
  /** Its git host (ADR-062): absent for GitHub. */
  host: z.string().optional(),
  /** The account whose token reads it. */
  account: z.string(),
  owner: z.string(),
  name: z.string(),
  fullName: z.string(),
  visibility: z.enum(["public", "private", "internal"]),
  defaultBranch: z.string(),
  /** ISO time of the last push, or null for an empty repository. */
  pushedAt: z.string().nullable(),
  description: z.string().nullable(),
  archived: z.boolean(),
  fork: z.boolean(),
  /** Where it is on GitHub, for "Open on GitHub". */
  url: z.string(),
  project: GitHubLinkedProject.nullable(),
});
export type GitHubRepoSummary = z.infer<typeof GitHubRepoSummary>;

/** The repositories of one account, or of all. */
export const GitHubRepoList = z.object({
  repos: z.array(GitHubRepoSummary),
  /** An account whose list couldn't be read, and why, in words. */
  errors: z.array(z.object({ account: z.string(), error: z.string() })),
  /** More than Oraknid reads at once (1,000 an account): the rest are on GitHub. */
  truncated: z.boolean(),
});
export type GitHubRepoList = z.infer<typeof GitHubRepoList>;

export const GitHubRepoDetail = GitHubRepoSummary.extend({
  stars: z.number().int(),
  openIssues: z.number().int(),
  /** Nothing pushed yet. */
  empty: z.boolean(),
});
export type GitHubRepoDetail = z.infer<typeof GitHubRepoDetail>;

/** A page of something GitHub pages; `next` when there is more. */
export const githubPage = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item), page: z.number().int().positive(), next: z.boolean() });

export const GitHubBranch = z.object({
  name: z.string(),
  sha: z.string(),
  protected: z.boolean(),
});
export type GitHubBranch = z.infer<typeof GitHubBranch>;

export const GitHubTreeEntry = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(["file", "dir", "symlink", "submodule"]),
  /** Bytes, for a file. */
  size: z.number().int().nullable(),
});
export type GitHubTreeEntry = z.infer<typeof GitHubTreeEntry>;

export const GitHubTree = z.object({
  ref: z.string(),
  path: z.string(),
  entries: z.array(GitHubTreeEntry),
  /** GitHub cut a recursive tree short. */
  truncated: z.boolean(),
});
export type GitHubTree = z.infer<typeof GitHubTree>;

/** A file at a ref: its text, or why it isn't shown. */
export const GitHubFile = z.object({
  path: z.string(),
  ref: z.string(),
  size: z.number().int(),
  /** The text, when it is text and not too large. */
  text: z.string().nullable(),
  binary: z.boolean(),
  /** Larger than Oraknid shows (512 KB): open it on GitHub. */
  tooLarge: z.boolean(),
  url: z.string(),
});
export type GitHubFile = z.infer<typeof GitHubFile>;

export const GitHubPerson = z.object({
  name: z.string(),
  login: z.string().nullable(),
});
export type GitHubPerson = z.infer<typeof GitHubPerson>;

export const GitHubCommitSummary = z.object({
  sha: z.string(),
  /** The first line. */
  title: z.string(),
  author: GitHubPerson,
  /** ISO time it was authored. */
  date: z.string(),
  url: z.string(),
});
export type GitHubCommitSummary = z.infer<typeof GitHubCommitSummary>;

/** One file in a commit or a pull request, with its patch when GitHub gives one. */
export const GitHubFileChange = z.object({
  path: z.string(),
  previousPath: z.string().nullable(),
  status: z.string(),
  additions: z.number().int(),
  deletions: z.number().int(),
  /** The unified diff of this file; null for a binary or a very large one. */
  patch: z.string().nullable(),
});
export type GitHubFileChange = z.infer<typeof GitHubFileChange>;

export const GitHubCommitDetail = GitHubCommitSummary.extend({
  message: z.string(),
  parents: z.array(z.string()),
  additions: z.number().int(),
  deletions: z.number().int(),
  files: z.array(GitHubFileChange),
  /** More files than GitHub returns at once (300). */
  filesTruncated: z.boolean(),
});
export type GitHubCommitDetail = z.infer<typeof GitHubCommitDetail>;

export const GitHubPullSummary = z.object({
  number: z.number().int(),
  title: z.string(),
  state: z.enum(["open", "closed", "merged"]),
  draft: z.boolean(),
  author: z.string().nullable(),
  head: z.string(),
  base: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  url: z.string(),
});
export type GitHubPullSummary = z.infer<typeof GitHubPullSummary>;

export const GitHubPullDetail = GitHubPullSummary.extend({
  body: z.string(),
  commits: z.array(GitHubCommitSummary),
  files: z.array(GitHubFileChange),
  additions: z.number().int(),
  deletions: z.number().int(),
  /** More commits or files than are shown (100 each). */
  truncated: z.boolean(),
});
export type GitHubPullDetail = z.infer<typeof GitHubPullDetail>;

/** How much of GitHub's hourly allowance an account has left, as last seen. */
export const GitHubLimit = z.object({
  account: z.string(),
  remaining: z.number().int(),
  limit: z.number().int(),
  /** When it is full again (ms). */
  resetsAt: z.number(),
  /** The same in words. */
  words: z.string(),
});
export type GitHubLimit = z.infer<typeof GitHubLimit>;

/** Which repository, and optionally through which account. */
export const GitHubRepoRef = z.object({
  owner: GitHubName,
  name: GitHubName,
  account: z.string().optional(),
});
export type GitHubRepoRef = z.infer<typeof GitHubRepoRef>;
