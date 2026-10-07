import type {
  GitHubBranch,
  GitHubCommitDetail,
  GitHubCommitSummary,
  GitHubFileChange,
  GitHubPullDetail,
  GitHubPullSummary,
  GitHubRepoSummary,
  GitHubTreeEntry,
} from "@oraknid/contracts";
import type { GitHubRepo, RepoInfo } from "../github.ts";
import {
  type BrowseRef,
  byTree,
  countPatch,
  fileOf,
  firstLine,
  HostError,
  isReadme,
  type RepoBrowser,
} from "./host.ts";
import { type HostAccounts, TokenHost } from "./rest.ts";

// GitLab (ADR-062), gitlab.com or my own, through its REST API v4 with a
// personal access token (scopes: api, read_repository, write_repository).
// A project is named by its path with its namespace (`group/sub/name`);
// merge requests are its pull requests; git takes the token as `oauth2`.

interface ApiProject {
  id: number;
  path: string;
  path_with_namespace: string;
  namespace: { full_path: string };
  visibility: "private" | "internal" | "public";
  default_branch?: string | null;
  last_activity_at: string | null;
  description: string | null;
  archived?: boolean;
  forked_from_project?: unknown;
  web_url: string;
  http_url_to_repo?: string;
  star_count?: number;
  open_issues_count?: number;
  empty_repo?: boolean;
}

interface ApiCommit {
  id: string;
  title: string;
  message: string;
  author_name: string;
  author_email?: string;
  authored_date: string;
  web_url: string;
  parent_ids?: string[];
  stats?: { additions: number; deletions: number };
}

interface ApiDiff {
  old_path: string;
  new_path: string;
  new_file: boolean;
  renamed_file: boolean;
  deleted_file: boolean;
  diff: string;
}

interface ApiMr {
  iid: number;
  title: string;
  state: "opened" | "closed" | "merged" | "locked";
  draft?: boolean;
  work_in_progress?: boolean;
  author: { username: string } | null;
  source_branch: string;
  target_branch: string;
  created_at: string;
  updated_at: string;
  web_url: string;
  description?: string | null;
}

const LIST_PAGES = 10;
const id = (fullName: string) => encodeURIComponent(fullName);
const q = (s: string) => encodeURIComponent(s);

const change = (d: ApiDiff): GitHubFileChange => ({
  path: d.new_path,
  previousPath: d.renamed_file ? d.old_path : null,
  status: d.new_file
    ? "added"
    : d.deleted_file
      ? "removed"
      : d.renamed_file
        ? "renamed"
        : "modified",
  ...countPatch(d.diff ?? ""),
  patch: d.diff ? d.diff.replace(/\n+$/, "") : null,
});

const commitSummary = (c: ApiCommit): GitHubCommitSummary => ({
  sha: c.id,
  title: c.title || firstLine(c.message),
  author: { name: c.author_name || "unknown", login: null },
  date: c.authored_date,
  url: c.web_url,
});

const mrSummary = (m: ApiMr): GitHubPullSummary => ({
  number: m.iid,
  title: m.title,
  state: m.state === "merged" ? "merged" : m.state === "opened" ? "open" : "closed",
  draft: !!(m.draft ?? m.work_in_progress),
  author: m.author?.username ?? null,
  head: m.source_branch,
  base: m.target_branch,
  createdAt: m.created_at,
  updatedAt: m.updated_at,
  url: m.web_url,
});

export class GitLab extends TokenHost {
  readonly kind = "gitlab" as const;
  readonly pullsName = "Merge requests";

  constructor(store: HostAccounts, host: string, url: string, http?: typeof fetch) {
    super(store, host, url, "GitLab", http);
  }

  protected get api() {
    return `${this.url}/api/v4`;
  }

  protected headers(token: string) {
    return { "private-token": token };
  }

  protected gitUser() {
    return "oauth2";
  }

  async whoami(token: string): Promise<string> {
    const res = await this.request("/user", {}, token);
    return ((await res.json()) as { username: string }).username;
  }

  #summary(p: ApiProject, account: string): GitHubRepoSummary {
    return {
      host: this.id,
      account,
      owner: p.namespace.full_path,
      name: p.path,
      fullName: p.path_with_namespace,
      visibility: p.visibility,
      defaultBranch: p.default_branch ?? "main",
      pushedAt: p.last_activity_at,
      description: p.description,
      archived: !!p.archived,
      fork: !!p.forked_from_project,
      url: p.web_url,
      project: null,
    };
  }

  async repos(login?: string | null): Promise<GitHubRepo[]> {
    const { data } = await this.read<ApiProject[]>(
      "/projects?membership=true&order_by=last_activity_at&per_page=100",
      login ?? this.account().login,
    );
    return data.map((p) => ({
      fullName: p.path_with_namespace,
      name: p.path,
      private: p.visibility !== "public",
      description: p.description,
      updatedAt: p.last_activity_at,
    }));
  }

  async createRepo(
    input: {
      name: string;
      private: boolean;
      description?: string;
      owner?: string;
      readme?: boolean;
    },
    login?: string | null,
  ) {
    const a = this.account(login);
    let namespace: number | undefined;
    if (input.owner && input.owner.toLowerCase() !== a.login.toLowerCase()) {
      const ns = await this.call<{ id: number }>(`/namespaces/${id(input.owner)}`, {}, a.login);
      namespace = ns.id;
    }
    const p = await this.call<ApiProject>(
      "/projects",
      {
        method: "POST",
        body: JSON.stringify({
          name: input.name,
          path: input.name,
          visibility: input.private ? "private" : "public",
          description: input.description ?? "",
          initialize_with_readme: input.readme ?? true,
          ...(namespace !== undefined ? { namespace_id: namespace } : {}),
        }),
      },
      a.login,
    );
    this.forget();
    return {
      fullName: p.path_with_namespace,
      cloneUrl: p.http_url_to_repo ?? this.cloneUrl(p.path_with_namespace),
    };
  }

  async repo(fullName: string, login?: string | null): Promise<RepoInfo> {
    const p = await this.call<ApiProject>(`/projects/${id(fullName)}`, {}, login);
    return {
      fullName: p.path_with_namespace,
      private: p.visibility !== "public",
      defaultBranch: p.default_branch ?? "main",
      url: p.web_url,
      description: p.description,
    };
  }

  async openPullRequest(
    input: { fullName: string; head: string; base: string; title: string; body?: string },
    login?: string | null,
  ) {
    const m = await this.call<ApiMr>(
      `/projects/${id(input.fullName)}/merge_requests`,
      {
        method: "POST",
        body: JSON.stringify({
          source_branch: input.head,
          target_branch: input.base,
          title: input.title,
          description: input.body ?? "",
        }),
      },
      login,
    );
    this.forget();
    return { number: m.iid, url: m.web_url };
  }

  async branchHead(fullName: string, branch: string, login?: string | null) {
    try {
      const b = await this.call<{ commit?: { id?: string } }>(
        `/projects/${id(fullName)}/repository/branches/${q(branch)}`,
        {},
        login,
      );
      return b.commit?.id ?? null;
    } catch (e) {
      if (e instanceof HostError && e.status === 404) return null;
      throw e;
    }
  }

  branchUrl(fullName: string, branch: string) {
    return `${this.url}/${fullName}/-/tree/${q(branch)}`;
  }

  browse: RepoBrowser = {
    list: (account) =>
      this.listAll(account, async (login) => {
        const repos: GitHubRepoSummary[] = [];
        let truncated = false;
        for (let page = 1; page <= LIST_PAGES; page++) {
          const r = await this.read<ApiProject[]>(
            `/projects?membership=true&order_by=last_activity_at&per_page=100&page=${page}`,
            login,
          );
          repos.push(...r.data.map((p) => this.#summary(p, login)));
          if (!r.next) break;
          if (page === LIST_PAGES) truncated = true;
        }
        return { repos, truncated };
      }),

    info: async (ref) => {
      const login = this.readerOf(ref);
      const { data: p } = await this.#read<ApiProject>(ref, "");
      return {
        ...this.#summary(p, login),
        stars: p.star_count ?? 0,
        openIssues: p.open_issues_count ?? 0,
        empty: !!p.empty_repo,
      };
    },

    branches: async (ref, page = 1) => {
      const r = await this.#read<{ name: string; commit: { id: string }; protected?: boolean }[]>(
        ref,
        `/repository/branches?per_page=100&page=${page}`,
      );
      return {
        items: r.data.map(
          (b): GitHubBranch => ({ name: b.name, sha: b.commit.id, protected: !!b.protected }),
        ),
        page,
        next: r.next,
      };
    },

    tree: async (ref, at, path = "", recursive = false) => {
      const entries: GitHubTreeEntry[] = [];
      let truncated = false;
      for (let page = 1; page <= (recursive ? 20 : 10); page++) {
        const r = await this.#read<{ name: string; path: string; type: string; mode: string }[]>(
          ref,
          `/repository/tree?ref=${q(at)}&per_page=100&page=${page}${path ? `&path=${q(path)}` : ""}${recursive ? "&recursive=true" : ""}`,
        );
        for (const e of r.data)
          entries.push({
            name: e.name,
            path: e.path,
            type:
              e.type === "tree"
                ? "dir"
                : e.type === "commit"
                  ? "submodule"
                  : e.mode === "120000"
                    ? "symlink"
                    : "file",
            size: null,
          });
        if (!r.next) break;
        if (page === (recursive ? 20 : 10)) truncated = true;
      }
      if (!recursive) entries.sort(byTree);
      return { ref: at, path: recursive ? "" : path, entries, truncated };
    },

    file: async (ref, at, path) => {
      const { data: f } = await this.#read<{
        file_path: string;
        size: number;
        encoding: string;
        content: string;
      }>(ref, `/repository/files/${q(path)}?ref=${q(at)}`);
      return fileOf({
        path: f.file_path,
        ref: at,
        size: f.size,
        url: `${this.url}/${ref.owner}/${ref.name}/-/blob/${q(at)}/${path}`,
        base64: f.encoding === "base64" ? f.content : Buffer.from(f.content).toString("base64"),
      });
    },

    readme: async (ref, at) => {
      const root = await this.browse.tree(ref, at, "").catch((e) => {
        if (e instanceof HostError && e.status === 404) return null;
        throw e;
      });
      const found = root?.entries.find((e) => e.type === "file" && isReadme(e.name));
      return found ? this.browse.file(ref, at, found.path) : null;
    },

    commits: async (ref, branch, page = 1) => {
      try {
        const r = await this.#read<ApiCommit[]>(
          ref,
          `/repository/commits?ref_name=${q(branch)}&per_page=30&page=${page}`,
        );
        return { items: r.data.map(commitSummary), page, next: r.next };
      } catch (e) {
        if (e instanceof HostError && e.status === 404)
          return { items: [] as GitHubCommitSummary[], page, next: false };
        throw e;
      }
    },

    commit: async (ref, sha): Promise<GitHubCommitDetail> => {
      const [c, diffs] = await Promise.all([
        this.#read<ApiCommit>(ref, `/repository/commits/${q(sha)}?stats=true`),
        this.#read<ApiDiff[]>(ref, `/repository/commits/${q(sha)}/diff?per_page=100`),
      ]);
      const files = diffs.data.map(change);
      return {
        ...commitSummary(c.data),
        message: c.data.message,
        parents: c.data.parent_ids ?? [],
        additions: c.data.stats?.additions ?? files.reduce((n, f) => n + f.additions, 0),
        deletions: c.data.stats?.deletions ?? files.reduce((n, f) => n + f.deletions, 0),
        files,
        filesTruncated: diffs.next,
      };
    },

    pulls: async (ref, state, page = 1) => {
      if (state === "open") {
        const r = await this.#read<ApiMr[]>(
          ref,
          `/merge_requests?state=opened&order_by=created_at&sort=desc&per_page=30&page=${page}`,
        );
        return { items: r.data.map(mrSummary), page, next: r.next };
      }
      // Closed as GitHub means it: merged ones too.
      const [merged, closed] = await Promise.all([
        this.#read<ApiMr[]>(
          ref,
          `/merge_requests?state=merged&order_by=created_at&sort=desc&per_page=30&page=${page}`,
        ),
        this.#read<ApiMr[]>(
          ref,
          `/merge_requests?state=closed&order_by=created_at&sort=desc&per_page=30&page=${page}`,
        ),
      ]);
      const items = [...merged.data, ...closed.data]
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .map(mrSummary);
      return { items, page, next: merged.next || closed.next };
    },

    pull: async (ref, number): Promise<GitHubPullDetail> => {
      const [m, commits, diffs] = await Promise.all([
        this.#read<ApiMr>(ref, `/merge_requests/${number}`),
        this.#read<ApiCommit[]>(ref, `/merge_requests/${number}/commits?per_page=100`),
        this.#read<ApiDiff[]>(ref, `/merge_requests/${number}/diffs?per_page=100`).catch(
          async (e) => {
            // Before GitLab 15.7: the changes, all at once.
            if (!(e instanceof HostError && e.status === 404)) throw e;
            const c = await this.#read<{ changes: ApiDiff[] }>(
              ref,
              `/merge_requests/${number}/changes`,
            );
            return { data: c.data.changes, next: false };
          },
        ),
      ]);
      const files = diffs.data.map(change);
      return {
        ...mrSummary(m.data),
        body: m.data.description ?? "",
        commits: commits.data.map(commitSummary),
        files,
        additions: files.reduce((n, f) => n + f.additions, 0),
        deletions: files.reduce((n, f) => n + f.deletions, 0),
        truncated: commits.next || diffs.next,
      };
    },
  };

  /** A read about one project, a 404 said in words. */
  async #read<T>(ref: BrowseRef, path: string): Promise<{ data: T; next: boolean }> {
    const login = this.readerOf(ref);
    try {
      return await this.read<T>(`/projects/${id(`${ref.owner}/${ref.name}`)}${path}`, login);
    } catch (e) {
      if (e instanceof HostError && e.status === 404)
        throw new HostError(
          `${this.id} has no such thing in ${ref.owner}/${ref.name}, or ${login}'s token can't read it.`,
          404,
        );
      throw e;
    }
  }
}
