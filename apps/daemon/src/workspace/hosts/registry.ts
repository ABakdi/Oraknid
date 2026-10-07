import {
  GITHUB_HOST,
  type GitHostAccount,
  type GitHostView,
  type NewGitHostAccount,
} from "@oraknid/contracts";
import type { Db } from "../../db/open.ts";
import type { Secrets } from "../../os/secrets.ts";
import type { GitHub } from "../github.ts";
import type { Repos } from "../github-repos.ts";
import { Gitea } from "./gitea.ts";
import { GitLab } from "./gitlab.ts";
import type { GitHost } from "./host.ts";
import { HostAccounts, normaliseHostUrl, type StoredHostAccount, type TokenHost } from "./rest.ts";

// The git hosts (ADR-062): GitHub as it is, through an adapter over its
// client and its Repos reads, and the hosts I added an account on (GitLab,
// Gitea, Forgejo), each one client per address. A project's link names its
// host; no host is GitHub.

/** GitHub's client and its reads, seen as a git host. Nothing of GitHub's own code changes. */
export function githubHost(github: GitHub, repos?: Repos): GitHost {
  const browse = repos;
  return {
    id: GITHUB_HOST,
    kind: "github",
    url: "https://github.com",
    label: "GitHub",
    pullsName: "Pull requests",
    accounts: (check) => github.accounts(check),
    repos: (login) => github.repos(login),
    createRepo: (input, login) => github.createRepo(input, login),
    repo: (fullName, login) => github.repo(fullName, login),
    openPullRequest: (input, login) => github.openPullRequest(input, login),
    cloneUrl: (fullName) => github.cloneUrl(fullName),
    clone: (url, dest, login) => github.clone(url, dest, login),
    push: (input) => github.push(input),
    async branchHead(fullName, branch, login) {
      try {
        const { data } = await github.read<{ commit?: { sha?: string } }>(
          `/repos/${fullName}/branches/${encodeURIComponent(branch)}`,
          login,
        );
        return data.commit?.sha ?? null;
      } catch (e) {
        if ((e as { status?: number }).status === 404) return null;
        throw e;
      }
    },
    branchUrl: (fullName, branch) => `https://github.com/${fullName}/tree/${branch}`,
    get browse() {
      if (!browse) throw new Error("GitHub's repositories aren't read here.");
      return browse;
    },
  };
}

export class GitHosts {
  readonly accounts: HostAccounts;
  readonly #github: GitHost;
  readonly #clients = new Map<string, TokenHost>();

  constructor(
    private readonly o: {
      db: Db;
      secrets: Secrets;
      github: GitHub;
      repos?: Repos;
      fetch?: typeof fetch;
    },
  ) {
    this.accounts = new HostAccounts(o.db, o.secrets);
    this.#github = githubHost(o.github, o.repos);
    attached.set(o.github, this);
  }

  #client(a: Pick<StoredHostAccount, "host" | "kind" | "url" | "flavor">): TokenHost {
    const kept = this.#clients.get(a.host);
    if (kept && kept.url === a.url && kept.kind === a.kind) return kept;
    const c =
      a.kind === "gitlab"
        ? new GitLab(this.accounts, a.host, a.url, this.o.fetch)
        : new Gitea(this.accounts, a.host, a.url, a.flavor, this.o.fetch);
    this.#clients.set(a.host, c);
    return c;
  }

  /** A host by its id; GitHub when none is named. */
  get(host?: string | null): GitHost {
    if (!host || host === GITHUB_HOST) return this.#github;
    const a = this.accounts.of(host)[0];
    if (!a)
      throw new Error(
        `There is no account on ${host} in Oraknid any more: add one in Repos → Accounts, or link the project to another.`,
      );
    return this.#client(a);
  }

  /** The host of a project's link. */
  forLink(link: { host?: string | undefined } | null | undefined): GitHost {
    return this.get(link?.host ?? null);
  }

  /** GitHub, then each host I have an account on, in the order I added them. */
  views(): GitHostView[] {
    const seen = new Map<string, GitHostView>();
    for (const a of this.accounts.all()) {
      if (seen.has(a.host)) continue;
      const c = this.#client(a);
      seen.set(a.host, {
        host: a.host,
        kind: a.kind,
        url: a.url,
        label: c.label,
        pullsName: c.pullsName,
      });
    }
    const g = this.#github;
    return [
      { host: g.id, kind: g.kind, url: g.url, label: g.label, pullsName: g.pullsName },
      ...seen.values(),
    ];
  }

  /** My accounts on the other hosts; `check` asks each whether its token still works. */
  async list(check = false): Promise<GitHostAccount[]> {
    const out: GitHostAccount[] = [];
    for (const a of this.accounts.all()) {
      let error: string | null = null;
      if (check)
        try {
          await this.#client(a).whoami(await this.accounts.token(a));
        } catch (e) {
          error = (e as Error).message;
        }
      out.push({ host: a.host, kind: a.kind, url: a.url, login: a.login, error });
    }
    return out;
  }

  /** A token checked against its host and kept under its account's name. */
  async add(input: NewGitHostAccount): Promise<{ host: string; login: string }> {
    const { url, host } = normaliseHostUrl(input.url);
    const token = input.token.trim();
    const other = this.accounts.all().find((a) => a.host === host);
    if (other && other.kind !== input.kind)
      throw new Error(`${host} is already in Oraknid as ${other.flavor || other.kind}.`);
    const probe =
      input.kind === "gitlab"
        ? new GitLab(this.accounts, host, url, this.o.fetch)
        : new Gitea(this.accounts, host, url, "Gitea", this.o.fetch);
    const login = await probe.whoami(token);
    const flavor = probe instanceof Gitea ? await probe.flavorOf() : "GitLab";
    await this.accounts.put({ host, kind: input.kind, url, login, flavor }, token);
    this.#clients.delete(host);
    return { host, login };
  }

  async remove(host: string, login: string) {
    await this.accounts.remove(host, login);
    this.#clients.get(host)?.forget();
    if (!this.accounts.of(host).length) this.#clients.delete(host);
  }

  /** Every host's repositories, or one host's (or one account's there), most recently changed first. */
  async repoList(host?: string | null, account?: string | null) {
    const hosts = host ? [this.get(host)] : [this.#github, ...this.#others()];
    const all = await Promise.all(
      hosts.map(async (h) => {
        if (h.id === GITHUB_HOST && !(await this.o.github.accounts()).length)
          return { repos: [], errors: [], truncated: false };
        return h.browse.list(account ?? null).catch((e) => ({
          repos: [],
          errors: [{ account: h.id, error: (e as Error).message }],
          truncated: false,
        }));
      }),
    );
    return {
      repos: all
        .flatMap((l) => l.repos)
        .sort((a, b) => (b.pushedAt ?? "").localeCompare(a.pushedAt ?? "")),
      errors: all.flatMap((l) => l.errors),
      truncated: all.some((l) => l.truncated),
    };
  }

  #others(): GitHost[] {
    const ids = [...new Set(this.accounts.all().map((a) => a.host))];
    return ids.map((id) => this.get(id));
  }
}

const attached = new WeakMap<GitHub, GitHosts>();

/**
 * The host of a project's link, reached from the GitHub client the daemon
 * already hands to the Eye, the Verifier and the endings: GitHub's own when
 * the link names none, else the registry made with that client.
 */
export function hostFor(
  github: GitHub | undefined,
  link: { host?: string | undefined } | null | undefined,
): GitHost | null {
  if (!github) return null;
  const hosts = attached.get(github);
  if (hosts) return hosts.forLink(link);
  if (link?.host && link.host !== GITHUB_HOST)
    throw new Error(`The git host ${link.host} isn't set up in Oraknid.`);
  return githubHost(github);
}

/** The registry made with this GitHub client, if any. */
export const hostsOf = (github: GitHub | undefined): GitHosts | null =>
  github ? (attached.get(github) ?? null) : null;
