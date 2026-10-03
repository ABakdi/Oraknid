import type {
  GitHubBranch,
  GitHubCommitDetail,
  GitHubCommitSummary,
  GitHubFile,
  GitHubFileChange,
  GitHubLink,
  GitHubLinkedProject,
  GitHubPullDetail,
  GitHubPullSummary,
  GitHubRepoDetail,
  GitHubRepoList,
  GitHubRepoRef,
  GitHubRepoSummary,
  GitHubTree,
  GitHubTreeEntry,
} from "@oraknid/contracts";
import { type GitHub, GitHubError } from "./github.ts";

// Repos (ADR-040): my repositories read through GitHub's REST API with an
// account's token, in the daemon. Nothing is cloned to browse; what is read
// is kept a minute by GitHub (the class) and the token never leaves it.

/** A file larger than this is not shown here: open it on GitHub. */
export const FILE_CAP = 512 * 1024;
/** Pages of 100 read of an account's repositories at most. */
const LIST_PAGES = 10;

interface ApiRepo {
  name: string;
  full_name: string;
  owner: { login: string };
  private: boolean;
  visibility?: string;
  default_branch?: string;
  pushed_at: string | null;
  description: string | null;
  archived?: boolean;
  fork?: boolean;
  html_url: string;
  stargazers_count?: number;
  open_issues_count?: number;
  size?: number;
}

interface ApiCommit {
  sha: string;
  html_url: string;
  commit: {
    message: string;
    author: { name?: string; date?: string } | null;
    committer?: { date?: string } | null;
  };
  author: { login: string } | null;
  parents?: { sha: string }[];
  stats?: { additions: number; deletions: number };
  files?: ApiFile[];
}

interface ApiFile {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

interface ApiPull {
  number: number;
  title: string;
  state: "open" | "closed";
  draft?: boolean;
  merged_at: string | null;
  user: { login: string } | null;
  head: { ref: string; label?: string };
  base: { ref: string };
  created_at: string;
  updated_at: string;
  html_url: string;
  body?: string | null;
  additions?: number;
  deletions?: number;
}

interface ApiContent {
  type: "file" | "dir" | "symlink" | "submodule";
  name: string;
  path: string;
  size: number;
  content?: string;
  encoding?: string;
  html_url?: string | null;
}

/** What the projects tell: which links which repository. */
export interface ProjectLinks {
  list(): { id: string; name: string; repos: { github: GitHubLink | null }[] }[];
}

const q = (s: string) => encodeURIComponent(s);
/** A path in a repository, each part encoded, the slashes kept. */
const pathOf = (p: string) =>
  p
    .split("/")
    .filter(Boolean)
    .map((x) => encodeURIComponent(x))
    .join("/");

const firstLine = (s: string) => s.split("\n", 1)[0] ?? "";

const visibilityOf = (r: ApiRepo): GitHubRepoSummary["visibility"] =>
  r.visibility === "internal" ? "internal" : r.private ? "private" : "public";

const change = (f: ApiFile): GitHubFileChange => ({
  path: f.filename,
  previousPath: f.previous_filename ?? null,
  status: f.status,
  additions: f.additions,
  deletions: f.deletions,
  patch: f.patch ?? null,
});

const commitSummary = (c: ApiCommit): GitHubCommitSummary => ({
  sha: c.sha,
  title: firstLine(c.commit.message),
  author: {
    name: c.commit.author?.name || c.author?.login || "unknown",
    login: c.author?.login ?? null,
  },
  date: c.commit.author?.date ?? c.commit.committer?.date ?? "",
  url: c.html_url,
});

const pullSummary = (p: ApiPull): GitHubPullSummary => ({
  number: p.number,
  title: p.title,
  state: p.merged_at ? "merged" : p.state,
  draft: !!p.draft,
  author: p.user?.login ?? null,
  head: p.head.ref,
  base: p.base.ref,
  createdAt: p.created_at,
  updatedAt: p.updated_at,
  url: p.html_url,
});

/** Text, or null when it reads as binary (a NUL byte, or not UTF-8). */
export function asText(bytes: Uint8Array): string | null {
  if (bytes.subarray(0, 8000).includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export class Repos {
  /** Which account read a repository last, so its page reads it the same way. */
  readonly #seen = new Map<string, string>();

  constructor(
    private readonly github: GitHub,
    private readonly projects: ProjectLinks,
  ) {}

  /** The project linking each repository (owner/name, any case). */
  #links(): Map<string, GitHubLinkedProject> {
    const m = new Map<string, GitHubLinkedProject>();
    // Each repo of a project of several has its own (ADR-042).
    for (const p of this.projects.list())
      for (const r of p.repos)
        if (r.github)
          m.set(`${r.github.owner}/${r.github.name}`.toLowerCase(), { id: p.id, name: p.name });
    return m;
  }

  #summary(r: ApiRepo, account: string, links: Map<string, GitHubLinkedProject>) {
    return {
      account,
      owner: r.owner.login,
      name: r.name,
      fullName: r.full_name,
      visibility: visibilityOf(r),
      defaultBranch: r.default_branch ?? "main",
      pushedAt: r.pushed_at,
      description: r.description,
      archived: !!r.archived,
      fork: !!r.fork,
      url: r.html_url,
      project: links.get(r.full_name.toLowerCase()) ?? null,
    } satisfies GitHubRepoSummary;
  }

  /**
   * The repositories of one account, or of all (one listed once, under the
   * first account that sees it), most recently pushed first.
   */
  async list(account?: string | null): Promise<GitHubRepoList> {
    const accounts = (await this.github.accounts()).map((a) => a.login).filter(Boolean);
    if (account && !accounts.includes(account))
      throw new Error(`No GitHub account ${account} in Oraknid.`);
    const links = this.#links();
    const out = new Map<string, GitHubRepoSummary>();
    const errors: GitHubRepoList["errors"] = [];
    let truncated = false;
    for (const login of account ? [account] : accounts) {
      try {
        for (let page = 1; page <= LIST_PAGES; page++) {
          const r = await this.github.read<ApiRepo[]>(
            `/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member&page=${page}`,
            login,
          );
          for (const repo of r.data) {
            const key = repo.full_name.toLowerCase();
            if (!out.has(key)) out.set(key, this.#summary(repo, login, links));
            if (!this.#seen.has(key)) this.#seen.set(key, login);
          }
          if (!r.next) break;
          if (page === LIST_PAGES) truncated = true;
        }
      } catch (e) {
        errors.push({ account: login, error: (e as Error).message });
      }
    }
    const repos = [...out.values()].sort((a, b) =>
      (b.pushedAt ?? "").localeCompare(a.pushedAt ?? ""),
    );
    return { repos, errors, truncated };
  }

  /**
   * The account to read a repository with: the one asked for, the one its
   * project is linked through, the one named like its owner, the one that
   * listed it, else the first that can see it.
   */
  async #account(ref: GitHubRepoRef): Promise<string> {
    const accounts = (await this.github.accounts()).map((a) => a.login).filter(Boolean);
    if (!accounts.length)
      throw new Error("Connect GitHub first: paste a token in Settings → Connections → GitHub.");
    if (ref.account) {
      if (!accounts.includes(ref.account))
        throw new Error(`No GitHub account ${ref.account} in Oraknid.`);
      return ref.account;
    }
    const key = `${ref.owner}/${ref.name}`.toLowerCase();
    const linked = this.projects
      .list()
      .flatMap((p) => p.repos.map((r) => r.github))
      .find((l) => l && `${l.owner}/${l.name}`.toLowerCase() === key);
    if (linked && accounts.includes(linked.account)) return linked.account;
    const owner = accounts.find((a) => a.toLowerCase() === ref.owner.toLowerCase());
    if (owner) return owner;
    const seen = this.#seen.get(key);
    if (seen && accounts.includes(seen)) return seen;
    for (const a of accounts) {
      try {
        await this.github.read(`/repos/${ref.owner}/${ref.name}`, a);
        this.#seen.set(key, a);
        return a;
      } catch {
        // This account can't see it; the next may.
      }
    }
    return accounts[0] as string;
  }

  /** A read about one repository, a 404 said in words. */
  async #read<T>(ref: GitHubRepoRef, path: string): Promise<{ data: T; next: boolean }> {
    const account = await this.#account(ref);
    try {
      return await this.github.read<T>(`/repos/${ref.owner}/${ref.name}${path}`, account);
    } catch (e) {
      if (e instanceof GitHubError && e.status === 404)
        throw new GitHubError(
          `GitHub has no such thing in ${ref.owner}/${ref.name}, or ${account}'s token can't read it.`,
          404,
        );
      throw e;
    }
  }

  async info(ref: GitHubRepoRef): Promise<GitHubRepoDetail> {
    const account = await this.#account(ref);
    const { data: r } = await this.#read<ApiRepo>(ref, "");
    let empty = false;
    if (!r.size) {
      const b = await this.#read<unknown[]>(ref, "/branches?per_page=1").catch(() => null);
      empty = !!b && b.data.length === 0;
    }
    return {
      ...this.#summary(r, account, this.#links()),
      stars: r.stargazers_count ?? 0,
      openIssues: r.open_issues_count ?? 0,
      empty,
    };
  }

  async branches(ref: GitHubRepoRef, page = 1) {
    const r = await this.#read<{ name: string; commit: { sha: string }; protected?: boolean }[]>(
      ref,
      `/branches?per_page=100&page=${page}`,
    );
    return {
      items: r.data.map(
        (b): GitHubBranch => ({ name: b.name, sha: b.commit.sha, protected: !!b.protected }),
      ),
      page,
      next: r.next,
    };
  }

  /** A directory at a ref, folders first; or, `recursive`, every path under the root. */
  async tree(ref: GitHubRepoRef, at: string, path = "", recursive = false): Promise<GitHubTree> {
    if (recursive) {
      const r = await this.#read<{
        tree: { path: string; type: "blob" | "tree" | "commit"; size?: number; mode?: string }[];
        truncated: boolean;
      }>(ref, `/git/trees/${q(at)}?recursive=1`);
      return {
        ref: at,
        path: "",
        truncated: r.data.truncated,
        entries: r.data.tree.map((e) => ({
          name: e.path.split("/").pop() ?? e.path,
          path: e.path,
          type:
            e.type === "tree"
              ? "dir"
              : e.type === "commit"
                ? "submodule"
                : e.mode === "120000"
                  ? "symlink"
                  : "file",
          size: e.type === "blob" ? (e.size ?? null) : null,
        })),
      };
    }
    const r = await this.#read<ApiContent[] | ApiContent>(
      ref,
      `/contents/${pathOf(path)}?ref=${q(at)}`,
    );
    if (!Array.isArray(r.data)) throw new Error(`${path} is a file, not a folder.`);
    const entries = r.data
      .map(
        (e): GitHubTreeEntry => ({
          name: e.name,
          path: e.path,
          type: e.type,
          size: e.type === "file" ? e.size : null,
        }),
      )
      .sort((a, b) =>
        a.type === "dir" && b.type !== "dir"
          ? -1
          : b.type === "dir" && a.type !== "dir"
            ? 1
            : a.name.localeCompare(b.name),
      );
    return { ref: at, path, entries, truncated: false };
  }

  /** A file at a ref: its text, or that it is binary or too large to show. */
  async file(ref: GitHubRepoRef, at: string, path: string): Promise<GitHubFile> {
    const r = await this.#read<ApiContent | ApiContent[]>(
      ref,
      `/contents/${pathOf(path)}?ref=${q(at)}`,
    );
    if (Array.isArray(r.data)) throw new Error(`${path} is a folder, not a file.`);
    return this.#file(r.data, at, ref);
  }

  #file(c: ApiContent, at: string, ref: GitHubRepoRef): GitHubFile {
    const url =
      c.html_url ?? `https://github.com/${ref.owner}/${ref.name}/blob/${at}/${pathOf(c.path)}`;
    const base = { path: c.path, ref: at, size: c.size, url };
    if (c.size > FILE_CAP || c.encoding === "none" || c.content === undefined)
      return { ...base, text: null, binary: false, tooLarge: true };
    const text = asText(Buffer.from(c.content, "base64"));
    return { ...base, text, binary: text === null, tooLarge: false };
  }

  /** The README at the root, or null when there is none. */
  async readme(ref: GitHubRepoRef, at: string): Promise<GitHubFile | null> {
    try {
      const r = await this.#read<ApiContent>(ref, `/readme?ref=${q(at)}`);
      return this.#file(r.data, at, ref);
    } catch (e) {
      if (e instanceof GitHubError && e.status === 404) return null;
      throw e;
    }
  }

  /** A branch's history, newest first, 30 a page. */
  async commits(ref: GitHubRepoRef, branch: string, page = 1) {
    try {
      const r = await this.#read<ApiCommit[]>(
        ref,
        `/commits?sha=${q(branch)}&per_page=30&page=${page}`,
      );
      return { items: r.data.map(commitSummary), page, next: r.next };
    } catch (e) {
      // An empty repository: nothing pushed yet.
      if (e instanceof GitHubError && e.status === 409)
        return { items: [] as GitHubCommitSummary[], page, next: false };
      throw e;
    }
  }

  /** One commit: its message, author, and each file's diff. */
  async commit(ref: GitHubRepoRef, sha: string): Promise<GitHubCommitDetail> {
    const { data: c } = await this.#read<ApiCommit>(ref, `/commits/${q(sha)}`);
    const files = (c.files ?? []).map(change);
    return {
      ...commitSummary(c),
      message: c.commit.message,
      parents: (c.parents ?? []).map((p) => p.sha),
      additions: c.stats?.additions ?? files.reduce((n, f) => n + f.additions, 0),
      deletions: c.stats?.deletions ?? files.reduce((n, f) => n + f.deletions, 0),
      files,
      filesTruncated: files.length >= 300,
    };
  }

  /** Pull requests, open or closed (merged among the closed), newest first, 30 a page. */
  async pulls(ref: GitHubRepoRef, state: "open" | "closed", page = 1) {
    const r = await this.#read<ApiPull[]>(
      ref,
      `/pulls?state=${state}&sort=created&direction=desc&per_page=30&page=${page}`,
    );
    return { items: r.data.map(pullSummary), page, next: r.next };
  }

  /** One pull request: its description, commits and each file's diff. */
  async pull(ref: GitHubRepoRef, number: number): Promise<GitHubPullDetail> {
    const [p, commits, files] = await Promise.all([
      this.#read<ApiPull>(ref, `/pulls/${number}`),
      this.#read<ApiCommit[]>(ref, `/pulls/${number}/commits?per_page=100`),
      this.#read<ApiFile[]>(ref, `/pulls/${number}/files?per_page=100`),
    ]);
    const changes = files.data.map(change);
    return {
      ...pullSummary(p.data),
      body: p.data.body ?? "",
      commits: commits.data.map(commitSummary),
      files: changes,
      additions: p.data.additions ?? changes.reduce((n, f) => n + f.additions, 0),
      deletions: p.data.deletions ?? changes.reduce((n, f) => n + f.deletions, 0),
      truncated: commits.next || files.next,
    };
  }
}
