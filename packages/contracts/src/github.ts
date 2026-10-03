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

/**
 * A project's GitHub link (ADR-038): the account Oraknid uses for it and
 * its repository. Pushing a branch there, creating it when it is new, and
 * opening a pull request there run without asking: the link is my approval.
 */
export const GitHubLink = z.object({
  /** The account's login: which of my tokens is used. */
  account: z.string().min(1),
  owner: GitHubName,
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
  account: true,
  owner: true,
  name: true,
  visibility: true,
  origin: true,
});
export type GitHubLinkInput = z.infer<typeof GitHubLinkInput>;
