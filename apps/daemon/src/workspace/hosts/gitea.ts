import type {
  GitHubBranch,
  GitHubCommitDetail,
  GitHubCommitSummary,
  GitHubPullDetail,
  GitHubPullSummary,
  GitHubRepoSummary,
  GitHubTreeEntry,
} from "@oraknid/contracts";
import type { GitHubRepo, RepoInfo } from "../github.ts";
import {
  type BrowseRef,
  byTree,
  fileOf,
  firstLine,
  HostError,
  isReadme,
  pathOf,
  type RepoBrowser,
  splitDiff,
} from "./host.ts";
import { type HostAccounts, TokenHost } from "./rest.ts";

// Gitea and Forgejo (ADR-062), my own, through the API v1 they share, with
// an access token (scopes: repository and user, read and write). Close to
// GitHub's: owner/name, contents, pulls; diffs come as text, cut per file.

interface ApiRepo {
  name: string;
  full_name: string;
  owner: { login: string; username?: string };
  private: boolean;
  internal?: boolean;
  default_branch?: string;
  updated_at: string | null;
  description: string | null;
  archived?: boolean;
  fork?: boolean;
  html_url: string;
  clone_url?: string;
  stars_count?: number;
  open_issues_count?: number;
  empty?: boolean;
}

interface ApiCommit {
  sha: string;
  html_url: string;
  commit: { message: string; author: { name?: string; date?: string } | null };
  author: { login: string } | null;
  parents?: { sha: string }[];
  stats?: { additions: number; deletions: number };
}

interface ApiPull {
  number: number;
  title: string;
  state: "open" | "closed";
  draft?: boolean;
  merged?: boolean;
  user: { login: string } | null;
  head: { ref: string };
  base: { ref: string };
  created_at: string;
  updated_at: string;
  html_url: string;
  body?: string | null;
}

interface ApiContent {
  type: "file" | "dir" | "symlink" | "submodule";
  name: string;
  path: string;
  size: number;
  content?: string | null;
  encoding?: string | null;
  html_url?: string | null;
}

const LIST_PAGES = 20;
const q = (s: string) => encodeURIComponent(s);

const commitSummary = (c: ApiCommit): GitHubCommitSummary => ({
  sha: c.sha,
  title: firstLine(c.commit.message),
  author: {
    name: c.commit.author?.name || c.author?.login || "unknown",
    login: c.author?.login ?? null,
  },
  date: c.commit.author?.date ?? "",
  url: c.html_url,
});

const pullSummary = (p: ApiPull): GitHubPullSummary => ({
  number: p.number,
  title: p.title,
  state: p.merged ? "merged" : p.state,
  draft: !!p.draft,
  author: p.user?.login ?? null,
  head: p.head.ref,
  base: p.base.ref,
  createdAt: p.created_at,
  updatedAt: p.updated_at,
  url: p.html_url,
});

export class Gitea extends TokenHost {
  readonly kind = "gitea" as const;
  readonly pullsName = "Pull requests";

  constructor(store: HostAccounts, host: string, url: string, flavor: string, http?: typeof fetch) {
    super(store, host, url, flavor || "Gitea", http);
  }

  protected get api() {
    return `${this.url}/api/v1`;
  }

  protected headers(token: string) {
    return { authorization: `token ${token}` };
  }

  protected gitUser(login: string) {
    return login;
  }

  async whoami(token: string): Promise<string> {
    const res = await this.request("/user", {}, token);
    return ((await res.json()) as { login: string }).login;
  }

  /** Forgejo says so at its own address; Gitea doesn't have it. */
  async flavorOf(): Promise<"Forgejo" | "Gitea"> {
    try {
      const res = await this.http(`${this.url}/api/forgejo/v1/version`, {
        signal: AbortSignal.timeout(5000),
      });
      return res.ok ? "Forgejo" : "Gitea";
    } catch {
      return "Gitea";
    }
  }

  #summary(r: ApiRepo, account: string): GitHubRepoSummary {
    return {
      host: this.id,
      account,
      owner: r.owner.login ?? r.owner.username,
      name: r.name,
      fullName: r.full_name,
      visibility: r.private ? "private" : r.internal ? "internal" : "public",
      defaultBranch: r.default_branch || "main",
      pushedAt: r.updated_at,
      description: r.description || null,
      archived: !!r.archived,
      fork: !!r.fork,
      url: r.html_url,
      project: null,
    };
  }

  async repos(login?: string | null): Promise<GitHubRepo[]> {
    const { data } = await this.read<ApiRepo[]>(
      "/user/repos?limit=50",
      login ?? this.account().login,
    );
    return data
      .map((r) => ({
        fullName: r.full_name,
        name: r.name,
        private: r.private,
        description: r.description || null,
        updatedAt: r.updated_at,
      }))
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
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
    const path =
      input.owner && input.owner.toLowerCase() !== a.login.toLowerCase()
        ? `/orgs/${q(input.owner)}/repos`
        : "/user/repos";
    const r = await this.call<ApiRepo>(
      path,
      {
        method: "POST",
        body: JSON.stringify({
          name: input.name,
          private: input.private,
          description: input.description ?? "",
          auto_init: input.readme ?? true,
          ...(input.readme === false ? {} : { readme: "Default" }),
        }),
      },
      a.login,
    );
    this.forget();
    return { fullName: r.full_name, cloneUrl: r.clone_url ?? this.cloneUrl(r.full_name) };
  }

  async repo(fullName: string, login?: string | null): Promise<RepoInfo> {
    const r = await this.call<ApiRepo>(`/repos/${fullName}`, {}, login);
    return {
      fullName: r.full_name,
      private: r.private,
      defaultBranch: r.default_branch || "main",
      url: r.html_url,
      description: r.description || null,
    };
  }

  async openPullRequest(
    input: { fullName: string; head: string; base: string; title: string; body?: string },
    login?: string | null,
  ) {
    const p = await this.call<ApiPull>(
      `/repos/${input.fullName}/pulls`,
      {
        method: "POST",
        body: JSON.stringify({
          head: input.head,
          base: input.base,
          title: input.title,
          body: input.body ?? "",
        }),
      },
      login,
    );
    this.forget();
    return { number: p.number, url: p.html_url };
  }

  async branchHead(fullName: string, branch: string, login?: string | null) {
    try {
      const b = await this.call<{ commit?: { id?: string } }>(
        `/repos/${fullName}/branches/${q(branch)}`,
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
    return `${this.url}/${fullName}/src/branch/${pathOf(branch)}`;
  }

  browse: RepoBrowser = {
    list: (account) =>
      this.listAll(account, async (login) => {
        const repos: GitHubRepoSummary[] = [];
        let truncated = false;
        for (let page = 1; page <= LIST_PAGES; page++) {
          const r = await this.read<ApiRepo[]>(`/user/repos?limit=50&page=${page}`, login);
          repos.push(...r.data.map((x) => this.#summary(x, login)));
          if (!r.next || r.data.length === 0) break;
          if (page === LIST_PAGES) truncated = true;
        }
        return { repos, truncated };
      }),

    info: async (ref) => {
      const login = this.readerOf(ref);
      const { data: r } = await this.#read<ApiRepo>(ref, "");
      return {
        ...this.#summary(r, login),
        stars: r.stars_count ?? 0,
        openIssues: r.open_issues_count ?? 0,
        empty: !!r.empty,
      };
    },

    branches: async (ref, page = 1) => {
      const r = await this.#read<{ name: string; commit: { id: string }; protected?: boolean }[]>(
        ref,
        `/branches?limit=50&page=${page}`,
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
      if (recursive) {
        const r = await this.#read<{
          tree: { path: string; type: string; size?: number; mode?: string }[];
          truncated: boolean;
        }>(ref, `/git/trees/${q(at)}?recursive=true&per_page=10000`);
        return {
          ref: at,
          path: "",
          truncated: r.data.truncated,
          entries: (r.data.tree ?? []).map(
            (e): GitHubTreeEntry => ({
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
            }),
          ),
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
        .sort(byTree);
      return { ref: at, path, entries, truncated: false };
    },

    file: async (ref, at, path) => {
      const r = await this.#read<ApiContent | ApiContent[]>(
        ref,
        `/contents/${pathOf(path)}?ref=${q(at)}`,
      );
      if (Array.isArray(r.data)) throw new Error(`${path} is a folder, not a file.`);
      const c = r.data;
      return fileOf({
        path: c.path,
        ref: at,
        size: c.size,
        url:
          c.html_url ??
          `${this.url}/${ref.owner}/${ref.name}/src/commit/${q(at)}/${pathOf(c.path)}`,
        base64: c.encoding === "base64" && typeof c.content === "string" ? c.content : undefined,
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
          `/commits?sha=${q(branch)}&limit=30&page=${page}&stat=false&verification=false&files=false`,
        );
        return { items: r.data.map(commitSummary), page, next: r.next };
      } catch (e) {
        // An empty repository: nothing pushed yet.
        if (e instanceof HostError && (e.status === 409 || e.status === 404))
          return { items: [] as GitHubCommitSummary[], page, next: false };
        throw e;
      }
    },

    commit: async (ref, sha): Promise<GitHubCommitDetail> => {
      const [c, diff] = await Promise.all([
        this.#read<ApiCommit>(ref, `/git/commits/${q(sha)}?stat=true&files=false`),
        this.#read<string>(ref, `/git/commits/${q(sha)}.diff`, true),
      ]);
      const files = splitDiff(diff.data);
      return {
        ...commitSummary(c.data),
        message: c.data.commit.message,
        parents: (c.data.parents ?? []).map((p) => p.sha),
        additions: c.data.stats?.additions ?? files.reduce((n, f) => n + f.additions, 0),
        deletions: c.data.stats?.deletions ?? files.reduce((n, f) => n + f.deletions, 0),
        files,
        filesTruncated: false,
      };
    },

    pulls: async (ref, state, page = 1) => {
      const r = await this.#read<ApiPull[]>(
        ref,
        `/pulls?state=${state}&sort=newest&limit=30&page=${page}`,
      );
      return { items: r.data.map(pullSummary), page, next: r.next };
    },

    pull: async (ref, number): Promise<GitHubPullDetail> => {
      const [p, commits, diff] = await Promise.all([
        this.#read<ApiPull>(ref, `/pulls/${number}`),
        this.#read<ApiCommit[]>(ref, `/pulls/${number}/commits?limit=50`),
        this.#read<string>(ref, `/pulls/${number}.diff`, true),
      ]);
      const files = splitDiff(diff.data);
      return {
        ...pullSummary(p.data),
        body: p.data.body ?? "",
        commits: commits.data.map(commitSummary),
        files,
        additions: files.reduce((n, f) => n + f.additions, 0),
        deletions: files.reduce((n, f) => n + f.deletions, 0),
        truncated: commits.next,
      };
    },
  };

  /** A read about one repository, a 404 said in words; `raw` for a diff's text. */
  async #read<T>(ref: BrowseRef, path: string, raw = false): Promise<{ data: T; next: boolean }> {
    const login = this.readerOf(ref);
    try {
      return await this.read<T>(`/repos/${ref.owner}/${ref.name}${path}`, login, raw);
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
