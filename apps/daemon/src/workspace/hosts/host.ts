import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  GitHostKind,
  GitHubAccount,
  GitHubBranch,
  GitHubCommitDetail,
  GitHubCommitSummary,
  GitHubFile,
  GitHubFileChange,
  GitHubPullDetail,
  GitHubPullSummary,
  GitHubRepoDetail,
  GitHubRepoList,
  GitHubTree,
} from "@oraknid/contracts";
import type { GitHubRepo, RepoInfo } from "../github.ts";
import type { Ci } from "../github-ci.ts";

// A git host (ADR-062): what Oraknid does on GitHub, GitLab or Gitea and
// Forgejo through an account's token. GitHub's client satisfies the core
// as it is (its methods have these shapes); the adapter in github-host.ts
// adds the reading the Repos page does. CI is another builder's, on GitHub
// first: it comes in as the optional `ci` facet, outside this interface.

/** What the github tool, New work and a project's link need of a host. */
export interface GitHostCore {
  /** My accounts on it; `check` asks the host whether each token still works. */
  accounts(check?: boolean): Promise<GitHubAccount[]>;
  /** An account's repositories, most recently changed first (New work's picker). */
  repos(login?: string | null): Promise<GitHubRepo[]>;
  /** A new repository; with a README unless `readme: false` (the tool's, empty for the first push). */
  createRepo(
    input: {
      name: string;
      private: boolean;
      description?: string;
      owner?: string;
      readme?: boolean;
    },
    login?: string | null,
  ): Promise<{ fullName: string; cloneUrl: string }>;
  repo(fullName: string, login?: string | null): Promise<RepoInfo>;
  /** A pull request (a merge request on GitLab) from one branch to another. */
  openPullRequest(
    input: { fullName: string; head: string; base: string; title: string; body?: string },
    login?: string | null,
  ): Promise<{ number: number; url: string }>;
  cloneUrl(fullName: string): string;
  /** Clones into `dest` with the token through GIT_ASKPASS for this one command. */
  clone(url: string, dest: string, login?: string | null): Promise<void>;
  /** Pushes refspecs by URL with the token through GIT_ASKPASS; nothing is written to .git/config. */
  push(input: {
    cwd: string;
    fullName: string;
    refspecs: string[];
    force?: boolean;
    login?: string | null;
  }): Promise<{ output: string }>;
}

/** Which repository a read is about; `account` when one was asked for. */
export interface BrowseRef {
  owner: string;
  name: string;
  account?: string | undefined;
}

type Page<T> = { items: T[]; page: number; next: boolean };

/** The Repos page's reads (ADR-040), in GitHub's shapes, for any host. */
export interface RepoBrowser {
  list(account?: string | null): Promise<GitHubRepoList>;
  info(ref: BrowseRef): Promise<GitHubRepoDetail>;
  branches(ref: BrowseRef, page?: number): Promise<Page<GitHubBranch>>;
  tree(ref: BrowseRef, at: string, path?: string, recursive?: boolean): Promise<GitHubTree>;
  file(ref: BrowseRef, at: string, path: string): Promise<GitHubFile>;
  readme(ref: BrowseRef, at: string): Promise<GitHubFile | null>;
  commits(ref: BrowseRef, branch: string, page?: number): Promise<Page<GitHubCommitSummary>>;
  commit(ref: BrowseRef, sha: string): Promise<GitHubCommitDetail>;
  pulls(ref: BrowseRef, state: "open" | "closed", page?: number): Promise<Page<GitHubPullSummary>>;
  pull(ref: BrowseRef, number: number): Promise<GitHubPullDetail>;
}

export interface GitHost extends GitHostCore {
  /** "github", or the host's address without its scheme. */
  readonly id: string;
  readonly kind: GitHostKind;
  /** `https://gitlab.com`. */
  readonly url: string;
  /** "GitHub", "GitLab (gitlab.com)", "Forgejo (git.example.org)". */
  readonly label: string;
  /** "Pull requests", or "Merge requests" on GitLab. */
  readonly pullsName: string;
  /** A branch's commit on the host, or null when it has no such branch (the built-in check). */
  branchHead(fullName: string, branch: string, login?: string | null): Promise<string | null>;
  /** Where a branch is shown on the host's own site. */
  branchUrl(fullName: string, branch: string): string;
  browse: RepoBrowser;
  /** CI: GitHub's Actions (ADR-058) on GitHub; other hosts have none here yet. */
  ci?: Ci;
}

/** A refusal from a host, said in words, with its HTTP status. */
export class HostError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** What a token is called on the command line: never in a URL, a remote or a config file. */
export const scrub = (text: string, token: string | undefined) =>
  token ? text.split(token).join("[token]") : text;

/**
 * Runs one git command with the credentials offered through GIT_ASKPASS,
 * and nowhere else; the script reads them from its environment. Async, so
 * the daemon keeps answering while git talks to the host.
 */
export async function gitWith(
  cred: { user: string; token: string } | undefined,
  args: string[],
  o: { cwd?: string; timeoutMs: number },
): Promise<{ status: number | null; output: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  const dir = cred ? mkdtempSync(join(tmpdir(), "oraknid-askpass-")) : null;
  if (dir && cred) {
    const askpass = join(dir, "askpass.sh");
    writeFileSync(
      askpass,
      '#!/bin/sh\ncase "$1" in Username*) echo "$ORAKNID_GIT_USER" ;; *) echo "$ORAKNID_GIT_TOKEN" ;; esac\n',
    );
    chmodSync(askpass, 0o700);
    Object.assign(env, {
      GIT_ASKPASS: askpass,
      ORAKNID_GIT_USER: cred.user,
      ORAKNID_GIT_TOKEN: cred.token,
    });
  }
  try {
    return await new Promise((resolve) => {
      const child = spawn("git", args, { cwd: o.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (d: Buffer) => {
        out += d.toString("utf8");
      });
      child.stderr.on("data", (d: Buffer) => {
        out += d.toString("utf8");
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), o.timeoutMs);
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve({ status: null, output: e.message });
      });
      child.on("close", (status) => {
        clearTimeout(timer);
        resolve({ status, output: scrub(out, cred?.token).trim() });
      });
    });
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

/** git clone, the credentials only when given (a public URL elsewhere is cloned as is). */
export async function gitClone(url: string, dest: string, cred?: { user: string; token: string }) {
  if (existsSync(dest)) throw new Error(`${dest} exists already: choose another folder.`);
  const r = await gitWith(cred, ["clone", "-q", "--", url, dest], { timeoutMs: 10 * 60_000 });
  if (r.status !== 0) {
    rmSync(dest, { recursive: true, force: true });
    throw new Error(`git clone failed: ${r.output}`);
  }
}

/** git push by URL, `--force-with-lease` when forced; the output scrubbed of the token. */
export async function gitPush(
  url: string,
  input: { cwd: string; refspecs: string[]; force?: boolean },
  cred: { user: string; token: string },
): Promise<{ output: string }> {
  const r = await gitWith(
    cred,
    [
      "push",
      "--porcelain",
      ...(input.force ? ["--force-with-lease"] : []),
      "--",
      url,
      ...input.refspecs,
    ],
    { cwd: input.cwd, timeoutMs: 10 * 60_000 },
  );
  if (r.status !== 0) throw new Error(`git push failed: ${r.output}`);
  return { output: r.output };
}

/** "at 14:05, in 12 minutes". */
export function inWords(at: number, now = Date.now()): string {
  const min = Math.max(1, Math.ceil((at - now) / 60_000));
  const clock = new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return `at ${clock}, in ${min} minute${min === 1 ? "" : "s"}`;
}

/** Text, or null when it reads as binary (a NUL byte, or not UTF-8). */
export function asText(bytes: Uint8Array): string | null {
  if (bytes.subarray(0, 8000).includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** A file larger than this is not shown: open it on the host. */
export const FILE_CAP = 512 * 1024;

/** A file at a ref, from its base64 content, in GitHub's shape. */
export function fileOf(o: {
  path: string;
  ref: string;
  size: number;
  url: string;
  base64: string | undefined;
}): GitHubFile {
  const base = { path: o.path, ref: o.ref, size: o.size, url: o.url };
  if (o.size > FILE_CAP || o.base64 === undefined)
    return { ...base, text: null, binary: false, tooLarge: true };
  const text = asText(Buffer.from(o.base64, "base64"));
  return { ...base, text, binary: text === null, tooLarge: false };
}

const firstLine = (s: string) => s.split("\n", 1)[0] ?? "";

export { firstLine };

/** Lines added and removed in a patch (the hunks only). */
export function countPatch(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const l of patch.split("\n")) {
    if (l.startsWith("+++") || l.startsWith("---")) continue;
    if (l.startsWith("+")) additions++;
    else if (l.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}

/**
 * A unified diff of several files (`git diff` as Gitea gives it) cut into
 * one change per file, each patch from its first hunk, as GitHub gives it.
 */
export function splitDiff(text: string): GitHubFileChange[] {
  const out: GitHubFileChange[] = [];
  const parts = text.split(/^diff --git /m).slice(1);
  for (const part of parts) {
    const lines = part.split("\n");
    const head = lines[0] ?? "";
    const m = /^a\/(.+?) b\/(.+)$/.exec(head);
    let from = m?.[1] ?? head;
    let to = m?.[2] ?? head;
    let status = "modified";
    let i = 1;
    for (; i < lines.length && !(lines[i] ?? "").startsWith("@@"); i++) {
      const l = lines[i] ?? "";
      if (l.startsWith("new file mode")) status = "added";
      else if (l.startsWith("deleted file mode")) status = "removed";
      else if (l.startsWith("rename from ")) {
        from = l.slice("rename from ".length);
        status = "renamed";
      } else if (l.startsWith("rename to ")) to = l.slice("rename to ".length);
    }
    const patch = lines.slice(i).join("\n").replace(/\n+$/, "");
    const counts = countPatch(patch);
    out.push({
      path: to,
      previousPath: status === "renamed" ? from : null,
      status,
      ...counts,
      patch: patch || null,
    });
  }
  return out;
}

/** Folders first, then by name. */
export const byTree = <T extends { type: string; name: string }>(a: T, b: T) =>
  a.type === "dir" && b.type !== "dir"
    ? -1
    : b.type === "dir" && a.type !== "dir"
      ? 1
      : a.name.localeCompare(b.name);

/** A path in a repository, each part encoded, the slashes kept. */
export const pathOf = (p: string) =>
  p
    .split("/")
    .filter(Boolean)
    .map((x) => encodeURIComponent(x))
    .join("/");

/** Is this the README at a root, by its name. */
export const isReadme = (name: string) => /^readme(\.[a-z0-9]+)?$/i.test(name);

/** The commits a remote's branches are at (git ls-remote --heads). */
export async function gitHeads(
  url: string,
  cred: { user: string; token: string },
): Promise<string[]> {
  const r = await gitWith(cred, ["ls-remote", "--heads", "--", url], { timeoutMs: 2 * 60_000 });
  if (r.status !== 0) throw new Error(`git ls-remote failed: ${r.output}`);
  return r.output
    .split("\n")
    .map((l) => l.split("\t")[0] ?? "")
    .filter((sha) => /^[0-9a-f]{40,64}$/.test(sha));
}
