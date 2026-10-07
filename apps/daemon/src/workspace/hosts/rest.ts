import type { GitHostKind, GitHubAccount, GitHubRepoList } from "@oraknid/contracts";
import { z } from "zod";
import type { Db } from "../../db/open.ts";
import type { Secrets } from "../../os/secrets.ts";
import { readSetting, writeSetting } from "../../settings.ts";
import type { GitHubRepo, RepoInfo } from "../github.ts";
import {
  type BrowseRef,
  type GitHost,
  gitClone,
  gitHeads,
  gitPush,
  HostError,
  type RepoBrowser,
} from "./host.ts";

// The accounts on git hosts other than GitHub (ADR-062), and what GitLab's
// and Gitea's clients share: a token per account in the keychain, REST
// with fetch, reads kept a minute and asked again with their ETag, and
// every refusal said in words. The token is never in a URL, a log, an
// event or an answer.

export const HOST_ACCOUNTS = "githosts.accounts";
const tokenKey = (host: string, login: string) => `githost.token.${host}.${login}`;
const READ_TTL = 60_000;
const READ_KEEP = 500;

export const StoredHostAccount = z.object({
  host: z.string().min(1),
  kind: z.enum(["gitlab", "gitea"]),
  url: z.string().min(1),
  login: z.string().min(1),
  /** "GitLab", "Gitea" or "Forgejo": what answered when it was added. */
  flavor: z.string().default(""),
  /** The keychain entry holding its token. */
  secret: z.string().min(1),
  addedAt: z.number(),
});
export type StoredHostAccount = z.infer<typeof StoredHostAccount>;
const Stored = z.array(StoredHostAccount);

/** The host's address, checked: https, or http only to this computer (the test servers). */
export function normaliseHostUrl(raw: string): { url: string; host: string } {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error(`${raw} isn't an address: give one like https://gitlab.com.`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:")
    throw new Error("A git host's address starts with https://.");
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (u.protocol === "http:" && !local)
    throw new Error(
      `${u.host} over plain http would send the token in clear: use its https:// address.`,
    );
  if (u.username || u.password) throw new Error("Give the address without a name or password.");
  const path = u.pathname.replace(/\/+$/, "");
  const url = `${u.protocol}//${u.host}${path}`;
  const host = `${u.host}${path}`.toLowerCase();
  if (host === "github.com" || host === "api.github.com")
    throw new Error("GitHub is added in its own card: Settings → Connections → GitHub.");
  return { url, host };
}

/** The accounts on other hosts, kept in the settings, their tokens in the keychain. */
export class HostAccounts {
  constructor(
    private readonly db: Db,
    readonly secrets: Secrets,
  ) {}

  all(): StoredHostAccount[] {
    return readSetting(this.db, HOST_ACCOUNTS, Stored, []);
  }

  of(host: string): StoredHostAccount[] {
    return this.all().filter((a) => a.host === host);
  }

  /** Keeps an account's token under its host and login; the same account's replaces it. */
  async put(a: Omit<StoredHostAccount, "secret" | "addedAt">, token: string, now = Date.now()) {
    const secret = tokenKey(a.host, a.login);
    await this.secrets.set(secret, token);
    const list = this.all();
    const fresh = { ...a, secret, addedAt: now };
    const i = list.findIndex((x) => x.host === a.host && x.login === a.login);
    if (i >= 0) list[i] = fresh;
    else list.push(fresh);
    writeSetting(this.db, HOST_ACCOUNTS, Stored, list);
  }

  async remove(host: string, login: string) {
    const list = this.all();
    const gone = list.find((a) => a.host === host && a.login === login);
    if (!gone) throw new Error(`No account ${login} on ${host} in Oraknid.`);
    await this.secrets.delete(gone.secret);
    writeSetting(
      this.db,
      HOST_ACCOUNTS,
      Stored,
      list.filter((a) => a !== gone),
    );
  }

  async token(a: StoredHostAccount): Promise<string> {
    const t = await this.secrets.get(a.secret);
    if (!t)
      throw new Error(
        `The token of ${a.login} on ${a.host} is missing from the keychain: add it again in Repos → Accounts.`,
      );
    return t;
  }
}

type Kept = { at: number; etag: string | null; data: unknown; next: boolean };

/**
 * What GitLab's and Gitea's clients share. A subclass says how the host
 * takes a token, where its API is, who a token belongs to, and how git
 * is given the token (GitLab: `oauth2`; Gitea: the login).
 */
export abstract class TokenHost implements GitHost {
  abstract readonly kind: GitHostKind;
  abstract readonly pullsName: string;
  abstract browse: RepoBrowser;
  readonly #cache = new Map<string, Kept>();

  constructor(
    protected readonly store: HostAccounts,
    readonly id: string,
    readonly url: string,
    protected readonly flavor: string,
    protected readonly http: typeof fetch = fetch,
  ) {}

  get label() {
    return `${this.flavor} (${this.id})`;
  }

  /** The API's root: `https://gitlab.com/api/v4`. */
  protected abstract get api(): string;
  protected abstract headers(token: string): Record<string, string>;
  /** The login a token belongs to. */
  abstract whoami(token: string): Promise<string>;
  /** The user name git is given with the token. */
  protected abstract gitUser(login: string): string;
  abstract repos(login?: string | null): Promise<GitHubRepo[]>;
  abstract createRepo(
    input: {
      name: string;
      private: boolean;
      description?: string;
      owner?: string;
      readme?: boolean;
    },
    login?: string | null,
  ): Promise<{ fullName: string; cloneUrl: string }>;
  abstract repo(fullName: string, login?: string | null): Promise<RepoInfo>;
  abstract openPullRequest(
    input: { fullName: string; head: string; base: string; title: string; body?: string },
    login?: string | null,
  ): Promise<{ number: number; url: string }>;
  abstract branchHead(
    fullName: string,
    branch: string,
    login?: string | null,
  ): Promise<string | null>;
  abstract branchUrl(fullName: string, branch: string): string;

  /** The account to use: the one named, else the first on this host. */
  protected account(login?: string | null): StoredHostAccount {
    const list = this.store.of(this.id);
    const a = login ? list.find((x) => x.login === login) : list[0];
    if (!a)
      throw new Error(
        login
          ? `The account ${login} on ${this.id} isn't in Oraknid any more: add its token in Repos → Accounts, or link the project to another.`
          : `Add an account on ${this.id} first: paste a token in Repos → Accounts.`,
      );
    return a;
  }

  protected async tokenOf(login?: string | null) {
    const a = this.account(login);
    return { account: a, token: await this.store.token(a) };
  }

  async accounts(check = false): Promise<GitHubAccount[]> {
    const out: GitHubAccount[] = [];
    for (const a of this.store.of(this.id)) {
      if (!check) {
        out.push({ login: a.login, error: null });
        continue;
      }
      try {
        await this.whoami(await this.store.token(a));
        out.push({ login: a.login, error: null });
      } catch (e) {
        out.push({ login: a.login, error: (e as Error).message });
      }
    }
    return out;
  }

  /** One request with a token; every refusal in words. */
  protected async request(
    path: string,
    init: RequestInit,
    token: string,
    extra: Record<string, string> = {},
  ): Promise<Response> {
    let res: Response;
    try {
      res = await this.http(`${this.api}${path}`, {
        ...init,
        headers: {
          accept: "application/json",
          ...this.headers(token),
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...extra,
        },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      throw new HostError(`${this.id} couldn't be reached: ${(e as Error).message}`, 0);
    }
    if (res.status === 401)
      throw new HostError(
        `${this.id} refused the token: it may have expired or been revoked.`,
        401,
      );
    if (res.status === 429 || (res.status === 403 && res.headers.has("retry-after")))
      throw new HostError(
        `${this.id} asks Oraknid to slow down: try again in ${Number(res.headers.get("retry-after")) || 60} seconds.`,
        res.status,
      );
    if (!res.ok && res.status !== 304) {
      const body = (await res.json().catch(() => ({}))) as {
        message?: unknown;
        error?: unknown;
        errors?: unknown;
      };
      const words = (v: unknown): string =>
        typeof v === "string"
          ? v
          : Array.isArray(v)
            ? v.map(words).join("; ")
            : v && typeof v === "object"
              ? Object.entries(v)
                  .map(([k, x]) => `${k} ${words(x)}`)
                  .join("; ")
              : "";
      const why = words(body.message) || words(body.error) || words(body.errors) || res.statusText;
      throw new HostError(`${this.id} said no: ${why}.`, res.status);
    }
    return res;
  }

  protected async call<T>(path: string, init: RequestInit, login?: string | null): Promise<T> {
    const { token } = await this.tokenOf(login);
    const res = await this.request(path, init, token);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** A read kept a minute, then asked again with its ETag; `next` when the host has another page. */
  async read<T>(
    path: string,
    login?: string | null,
    raw = false,
  ): Promise<{ data: T; next: boolean }> {
    const { account, token } = await this.tokenOf(login);
    const key = `${account.login}\n${raw ? "raw:" : ""}${path}`;
    const kept = this.#cache.get(key);
    if (kept && Date.now() - kept.at < READ_TTL) return { data: kept.data as T, next: kept.next };
    const res = await this.request(
      path,
      {},
      token,
      kept?.etag ? { "if-none-match": kept.etag } : {},
    );
    if (res.status === 304 && kept) {
      kept.at = Date.now();
      return { data: kept.data as T, next: kept.next };
    }
    const data = (raw ? await res.text() : await res.json()) as T;
    const next =
      /<[^>]+>;\s*rel="next"/.test(res.headers.get("link") ?? "") ||
      !!res.headers.get("x-next-page");
    if (this.#cache.size >= READ_KEEP) {
      const oldest = this.#cache.keys().next().value;
      if (oldest !== undefined) this.#cache.delete(oldest);
    }
    this.#cache.delete(key);
    this.#cache.set(key, { at: Date.now(), etag: res.headers.get("etag"), data, next });
    return { data, next };
  }

  forget() {
    this.#cache.clear();
  }

  cloneUrl(fullName: string): string {
    return `${this.url}/${fullName}.git`;
  }

  async clone(url: string, dest: string, login?: string | null) {
    const mine = url.startsWith(`${this.url}/`);
    const cred = mine ? await this.tokenOf(login) : null;
    await gitClone(
      url,
      dest,
      cred ? { user: this.gitUser(cred.account.login), token: cred.token } : undefined,
    );
  }

  /** The commits of a repository's branches (git ls-remote, the token through GIT_ASKPASS). */
  async remoteHeads(fullName: string, login?: string | null): Promise<string[]> {
    const { account, token } = await this.tokenOf(login);
    return gitHeads(this.cloneUrl(fullName), { user: this.gitUser(account.login), token });
  }

  async push(input: {
    cwd: string;
    fullName: string;
    refspecs: string[];
    force?: boolean;
    login?: string | null;
  }) {
    const { account, token } = await this.tokenOf(input.login);
    return gitPush(this.cloneUrl(input.fullName), input, {
      user: this.gitUser(account.login),
      token,
    });
  }

  /** The account a repository is read with: the one asked for, the one named like its owner, else the first. */
  protected readerOf(ref: BrowseRef): string {
    const list = this.store.of(this.id).map((a) => a.login);
    if (!list.length)
      throw new Error(`Add an account on ${this.id} first: paste a token in Repos → Accounts.`);
    if (ref.account) {
      if (!list.includes(ref.account))
        throw new Error(`No account ${ref.account} on ${this.id} in Oraknid.`);
      return ref.account;
    }
    const top = ref.owner.split("/")[0]?.toLowerCase();
    return list.find((l) => l.toLowerCase() === top) ?? (list[0] as string);
  }

  /** Every account's list of repositories, one listed once, most recently changed first. */
  protected async listAll(
    account: string | null | undefined,
    one: (login: string) => Promise<{ repos: GitHubRepoList["repos"]; truncated: boolean }>,
  ): Promise<GitHubRepoList> {
    const logins = this.store.of(this.id).map((a) => a.login);
    if (account && !logins.includes(account))
      throw new Error(`No account ${account} on ${this.id} in Oraknid.`);
    const out = new Map<string, GitHubRepoList["repos"][number]>();
    const errors: GitHubRepoList["errors"] = [];
    let truncated = false;
    for (const login of account ? [account] : logins) {
      try {
        const r = await one(login);
        truncated ||= r.truncated;
        for (const repo of r.repos) {
          const key = repo.fullName.toLowerCase();
          if (!out.has(key)) out.set(key, repo);
        }
      } catch (e) {
        errors.push({ account: `${login}@${this.id}`, error: (e as Error).message });
      }
    }
    const repos = [...out.values()].sort((a, b) =>
      (b.pushedAt ?? "").localeCompare(a.pushedAt ?? ""),
    );
    return { repos, errors, truncated };
  }
}
