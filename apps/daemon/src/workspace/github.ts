import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitHubAccount, GitHubLimit } from "@oraknid/contracts";
import { z } from "zod";
import type { Db } from "../db/open.ts";
import type { Secrets } from "../os/secrets.ts";
import { readSetting, writeSetting } from "../settings.ts";

// GitHub through tokens I paste (ADR-023, ADR-038): several accounts, each
// token named by its account. REST with fetch; git with the token given
// through GIT_ASKPASS for one command, never in a URL, a remote or a config
// file, and never to a Leg.

/** Where the one token of before several accounts is kept; it stays there, named by its account. */
export const LEGACY_TOKEN = "github.token";
const ACCOUNTS = "github.accounts";
const tokenKey = (login: string) => `github.token.${login}`;
/** How long a read is kept before GitHub is asked again (with its ETag). */
const READ_TTL = 60_000;
/** How many reads are kept at most, the oldest dropped first. */
const READ_KEEP = 500;

/** A refusal from GitHub, said in words, with its HTTP status. */
export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** When GitHub may be asked again (its allowance full again, or the time it asked to wait), ms. */
    readonly retryAt: number | null = null,
  ) {
    super(message);
  }
}

/** "at 14:05, in 12 minutes". */
function inWords(at: number, now = Date.now()): string {
  const min = Math.max(1, Math.ceil((at - now) / 60_000));
  const clock = new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return `at ${clock}, in ${min} minute${min === 1 ? "" : "s"}`;
}

/** GitHub asked to wait: its allowance used up (`limit`), or slow down (no limit), until when. */
interface Pause {
  until: number;
  limit: number | null;
}

/** Why an account waits, in words, the time said from now. */
function pauseWords(who: string | undefined, p: Pause): string {
  const name = who ?? "this account";
  if (p.limit !== null)
    return `GitHub's hourly allowance for ${name} is used up (${p.limit} requests); it fills again ${inWords(p.until)}.`;
  const seconds = Math.max(1, Math.ceil((p.until - Date.now()) / 1000));
  return `GitHub asks Oraknid to slow down for ${name}: try again in ${seconds} seconds.`;
}

const Stored = z.array(
  z.object({
    login: z.string().min(1),
    /** The keychain entry holding its token. */
    secret: z.string().min(1),
    addedAt: z.number(),
  }),
);
type Stored = z.infer<typeof Stored>;

export interface GitHubRepo {
  fullName: string;
  name: string;
  private: boolean;
  description: string | null;
  updatedAt: string | null;
}

export interface RepoInfo {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  url: string;
  description: string | null;
}

export class GitHub {
  constructor(
    private readonly secrets: Secrets,
    private readonly db: Db,
    private readonly o: { api?: string; web?: string; fetch?: typeof fetch } = {},
  ) {}

  get #api() {
    return this.o.api ?? "https://api.github.com";
  }

  get #web() {
    return this.o.web ?? "https://github.com";
  }

  #stored(): Stored {
    return readSetting(this.db, ACCOUNTS, Stored, []);
  }

  /**
   * The accounts, the token of before named by its account the first time
   * (its keychain entry is kept and referred to, never read out or copied).
   */
  async #list(): Promise<Stored> {
    const stored = this.#stored();
    if (stored.length) return stored;
    const legacy = await this.secrets.get(LEGACY_TOKEN);
    if (!legacy) return [];
    try {
      const me = await this.#call<{ login: string }>("/user", {}, legacy);
      const list = [{ login: me.login, secret: LEGACY_TOKEN, addedAt: Date.now() }];
      writeSetting(this.db, ACCOUNTS, Stored, list);
      return list;
    } catch {
      // GitHub out of reach: the account is there, named when it answers.
      return [{ login: "", secret: LEGACY_TOKEN, addedAt: 0 }];
    }
  }

  /** My accounts, in the order I added them; `check` asks GitHub whether each token still works. */
  async accounts(check = false): Promise<GitHubAccount[]> {
    const list = await this.#list();
    const out: GitHubAccount[] = [];
    for (const a of list) {
      if (!a.login) {
        out.push({ login: "", error: "GitHub couldn't be reached to name this account." });
        continue;
      }
      if (!check) {
        out.push({ login: a.login, error: null });
        continue;
      }
      try {
        await this.#call("/user", {}, await this.#tokenOf(a));
        out.push({ login: a.login, error: null });
      } catch (error) {
        out.push({ login: a.login, error: (error as Error).message });
      }
    }
    return out;
  }

  /** Whether an account is set, and the first one's name (what New work and the helper need). */
  async status(): Promise<{ connected: boolean; login: string | null; error: string | null }> {
    const list = await this.#list();
    const first = list[0];
    if (!first) return { connected: false, login: null, error: null };
    try {
      const me = await this.#call<{ login: string }>("/user", {}, await this.#tokenOf(first));
      return { connected: true, login: me.login, error: null };
    } catch (error) {
      return { connected: true, login: first.login || null, error: (error as Error).message };
    }
  }

  /** Checks a token against GitHub and keeps it under its account's name; the same account's is replaced. */
  async addAccount(token: string): Promise<string> {
    const value = token.trim();
    const me = await this.#call<{ login: string }>("/user", {}, value);
    const list = await this.#list();
    const before = list.find((a) => a.login === me.login);
    const fresh = { login: me.login, secret: tokenKey(me.login), addedAt: Date.now() };
    await this.secrets.set(fresh.secret, value);
    if (before && before.secret !== fresh.secret) await this.secrets.delete(before.secret);
    // Replaced in place: the first account stays first, it is the default.
    const next = before ? list.map((a) => (a === before ? fresh : a)) : [...list, fresh];
    writeSetting(
      this.db,
      ACCOUNTS,
      Stored,
      next.filter((a) => a.login),
    );
    this.forget();
    return me.login;
  }

  /** Forgets an account: its token is deleted from the keychain. */
  async removeAccount(login: string) {
    const list = await this.#list();
    const gone = list.find((a) => a.login === login);
    if (!gone) throw new Error(`No GitHub account ${login || "(unnamed)"}.`);
    await this.secrets.delete(gone.secret);
    writeSetting(
      this.db,
      ACCOUNTS,
      Stored,
      list.filter((a) => a !== gone && a.login),
    );
    this.forget();
    this.#limits.delete(login);
  }

  async #tokenOf(a: Stored[number]): Promise<string> {
    const t = await this.secrets.get(a.secret);
    if (!t)
      throw new Error(
        `The token of ${a.login || "this account"} is missing from the keychain: add it again in Settings → Connections → GitHub.`,
      );
    return t;
  }

  /** The token of an account (the first one when none is named). */
  async #token(login?: string | null): Promise<string> {
    const list = await this.#list();
    const a = login ? list.find((x) => x.login === login) : list[0];
    if (!a)
      throw new Error(
        login
          ? `The GitHub account ${login} isn't in Oraknid any more: add its token in Settings → Connections → GitHub, or link the project to another.`
          : "Connect GitHub first: paste a token in Settings → Connections → GitHub.",
      );
    return this.#tokenOf(a);
  }

  async #call<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
    const res = await this.#request(path, init, token ?? (await this.#token()));
    return (await res.json()) as T;
  }

  /** One request; GitHub's allowance noted, and every refusal said in words (BR-17). */
  async #request(
    path: string,
    init: RequestInit,
    token: string,
    who?: string,
    extra: Record<string, string> = {},
  ): Promise<Response> {
    const res = await (this.o.fetch ?? fetch)(`${this.#api}${path}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...extra,
      },
      signal: AbortSignal.timeout(20_000),
    });
    const remaining = Number(res.headers.get("x-ratelimit-remaining"));
    const limit = Number(res.headers.get("x-ratelimit-limit"));
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    if (who && res.headers.has("x-ratelimit-remaining") && limit > 0)
      this.#limits.set(who, { remaining, limit, resetsAt: reset * 1000 });
    if (res.status === 401) throw new Error("GitHub refused the token: it may have expired.");
    if (
      (res.status === 403 || res.status === 429) &&
      res.headers.get("x-ratelimit-remaining") === "0"
    ) {
      // Nothing more is asked with this account until it is full again (ADR-058).
      const p = {
        until: reset > 0 ? reset * 1000 : Date.now() + 60 * 60_000,
        limit: limit || 5000,
      };
      if (who) this.#paused.set(who, p);
      throw new GitHubError(pauseWords(who, p), res.status, p.until);
    }
    if ((res.status === 403 || res.status === 429) && res.headers.has("retry-after")) {
      const seconds = Number(res.headers.get("retry-after")) || 60;
      const p = { until: Date.now() + seconds * 1000, limit: null };
      if (who) this.#paused.set(who, p);
      throw new GitHubError(pauseWords(who, p), res.status, p.until);
    }
    const redirected = init.redirect === "manual" && res.status >= 300 && res.status < 400;
    if (!res.ok && res.status !== 304 && !redirected) {
      const body = (await res.json().catch(() => ({}))) as {
        message?: string;
        errors?: { message?: string }[];
      };
      const why = body.errors?.map((e) => e.message).join("; ") || body.message || res.statusText;
      throw new GitHubError(`GitHub said no: ${why}.`, res.status);
    }
    return res;
  }

  /** Accounts GitHub asked to wait, until when (ms): nothing is asked of it with them till then. */
  readonly #paused = new Map<string, Pause>();
  /** What GitHub said last of each account's hourly allowance. */
  readonly #limits = new Map<string, { remaining: number; limit: number; resetsAt: number }>();
  /** Reads, briefly kept (ADR-040): an account and a path, with GitHub's ETag to ask again cheaply. */
  readonly #cache = new Map<
    string,
    { at: number; etag: string | null; data: unknown; next: boolean }
  >();

  /** The accounts' allowances as last seen, in words too. */
  limits(): GitHubLimit[] {
    return [...this.#limits].map(([account, l]) => ({
      account,
      ...l,
      words:
        l.remaining > 0
          ? `${l.remaining.toLocaleString("en")} of ${l.limit.toLocaleString("en")} requests left this hour; full again ${inWords(l.resetsAt)}.`
          : `None of ${l.limit.toLocaleString("en")} requests left this hour; full again ${inWords(l.resetsAt)}.`,
    }));
  }

  /** Forgets what was read: after a change of mine, the next read is GitHub's. */
  forget() {
    this.#cache.clear();
  }

  /**
   * A read through an account's token (the first when none is named), kept
   * for a minute; after that GitHub is asked again with the ETag, and an
   * unchanged answer (304) costs nothing of the allowance. `next` says
   * GitHub has another page.
   */
  async read<T>(
    path: string,
    login?: string | null,
    o: { ttl?: number } = {},
  ): Promise<{ data: T; next: boolean; stale: boolean; retryAt: number | null }> {
    const list = await this.#list();
    const a = login ? list.find((x) => x.login === login) : list[0];
    if (!a) await this.#token(login);
    const account = a as Stored[number];
    const key = `${account.login}\n${path}`;
    const kept = this.#cache.get(key);
    const fresh = (x: NonNullable<typeof kept>) => ({
      data: x.data as T,
      next: x.next,
      stale: false,
      retryAt: null,
    });
    if (kept && Date.now() - kept.at < (o.ttl ?? READ_TTL)) return fresh(kept);
    // GitHub asked to wait (ADR-058): what was read is served as it was, nothing new is asked.
    const until = this.pausedUntil(account.login);
    if (until) {
      if (kept) return { data: kept.data as T, next: kept.next, stale: true, retryAt: until };
      this.#refuseWhilePaused(account.login);
    }
    const res = await this.#request(
      path,
      {},
      await this.#tokenOf(account),
      account.login || undefined,
      kept?.etag ? { "if-none-match": kept.etag } : {},
    );
    if (res.status === 304 && kept) {
      kept.at = Date.now();
      return fresh(kept);
    }
    const data = (await res.json()) as T;
    const next = /<[^>]+>;\s*rel="next"/.test(res.headers.get("link") ?? "");
    if (this.#cache.size >= READ_KEEP) {
      const oldest = this.#cache.keys().next().value;
      if (oldest !== undefined) this.#cache.delete(oldest);
    }
    this.#cache.delete(key);
    this.#cache.set(key, { at: Date.now(), etag: res.headers.get("etag"), data, next });
    return { data, next, stale: false, retryAt: null };
  }

  /** Until when GitHub asked Oraknid to wait with an account (ms), or null. */
  pausedUntil(login: string): number | null {
    const p = this.#paused.get(login);
    if (p === undefined) return null;
    if (p.until <= Date.now()) {
      this.#paused.delete(login);
      return null;
    }
    return p.until;
  }

  /** While GitHub asked to wait, the same refusal again, GitHub not asked. */
  #refuseWhilePaused(login: string) {
    const p = this.pausedUntil(login) ? this.#paused.get(login) : undefined;
    if (p) throw new GitHubError(pauseWords(login || undefined, p), 429, p.until);
  }

  /**
   * A change through an account's token (ADR-058: a re-run, a cancel, a
   * workflow run by hand): GitHub's answer, or null when it has none (202,
   * 204). What was read is forgotten.
   */
  async send<T = unknown>(
    path: string,
    init: { method: "POST" | "PATCH" | "PUT" | "DELETE"; body?: unknown },
    login: string,
  ): Promise<T | null> {
    this.#refuseWhilePaused(login);
    try {
      const res = await this.#request(
        path,
        {
          method: init.method,
          ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        },
        await this.#token(login),
        login,
      );
      const text = await res.text();
      return text ? (JSON.parse(text) as T) : null;
    } finally {
      this.forget();
    }
  }

  /**
   * Something GitHub hands over at another address (a job's log, an
   * artifact's zip): asked with the token, the address it redirects to
   * fetched without it. The response's body is the caller's to read.
   */
  async raw(path: string, login: string): Promise<Response> {
    this.#refuseWhilePaused(login);
    const res = await this.#request(path, { redirect: "manual" }, await this.#token(login), login);
    const to = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!to) return res;
    // The signed address needs no token: it is never sent there.
    const next = await (this.o.fetch ?? fetch)(to, { signal: AbortSignal.timeout(5 * 60_000) });
    if (!next.ok)
      throw new GitHubError(`GitHub's file couldn't be fetched (${next.status}).`, next.status);
    return next;
  }

  /** An account's repos, most recently pushed first. */
  async repos(login?: string | null): Promise<GitHubRepo[]> {
    const list = await this.#call<
      {
        full_name: string;
        name: string;
        private: boolean;
        description: string | null;
        pushed_at: string | null;
      }[]
    >(
      "/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator",
      {},
      await this.#token(login),
    );
    return list.map((r) => ({
      fullName: r.full_name,
      name: r.name,
      private: r.private,
      description: r.description,
      updatedAt: r.pushed_at,
    }));
  }

  /**
   * A new repo on an account (or an organisation it belongs to). From the
   * page it gets a README so it can be cloned at once; for a project's own
   * history (the github tool) it starts empty, so the first push lands.
   */
  async createRepo(
    input: {
      name: string;
      private: boolean;
      description?: string;
      owner?: string;
      readme?: boolean;
    },
    login?: string | null,
  ): Promise<{ fullName: string; cloneUrl: string }> {
    const token = await this.#token(login);
    const path =
      input.owner && login && input.owner !== login ? `/orgs/${input.owner}/repos` : "/user/repos";
    const r = await this.#call<{ full_name: string; clone_url: string }>(
      path,
      {
        method: "POST",
        body: JSON.stringify({
          name: input.name,
          private: input.private,
          description: input.description ?? "",
          auto_init: input.readme ?? true,
        }),
      },
      token,
    );
    this.forget();
    return { fullName: r.full_name, cloneUrl: r.clone_url };
  }

  /** What GitHub says of one repo. */
  async repo(fullName: string, login?: string | null): Promise<RepoInfo> {
    const r = await this.#call<{
      full_name: string;
      private: boolean;
      default_branch: string;
      html_url: string;
      description: string | null;
    }>(`/repos/${fullName}`, {}, await this.#token(login));
    return {
      fullName: r.full_name,
      private: r.private,
      defaultBranch: r.default_branch,
      url: r.html_url,
      description: r.description,
    };
  }

  /** A pull request from one branch to another in one repo. */
  async openPullRequest(
    input: { fullName: string; head: string; base: string; title: string; body?: string },
    login?: string | null,
  ): Promise<{ number: number; url: string }> {
    const r = await this.#call<{ number: number; html_url: string }>(
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
      await this.#token(login),
    );
    return { number: r.number, url: r.html_url };
  }

  /**
   * The scopes of an account's token, as GitHub says them for a classic
   * token (`x-oauth-scopes`); null for a fine-grained one, which says none.
   */
  async scopes(login: string): Promise<string[] | null> {
    const res = await this.#request("/user", {}, await this.#token(login), login);
    const header = res.headers.get("x-oauth-scopes");
    if (header === null) return null;
    return header
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /**
   * Whether an account owns a repo (its own, or an organisation's it
   * administers), and whether it is archived. Deleting and archiving a
   * repo are only done on one it owns.
   */
  async ownership(
    fullName: string,
    login: string,
  ): Promise<{ owned: boolean; archived: boolean; url: string }> {
    const r = await this.#call<{
      owner: { login: string; type?: string };
      archived?: boolean;
      html_url: string;
      permissions?: { admin?: boolean };
    }>(`/repos/${fullName}`, {}, await this.#token(login));
    const own = r.owner.login.toLowerCase() === login.toLowerCase();
    const org = r.owner.type === "Organization" && !!r.permissions?.admin;
    return { owned: own || org, archived: !!r.archived, url: r.html_url };
  }

  /**
   * Deletes a repo on GitHub with an account's token. A token without the
   * delete_repo permission is refused by GitHub with a 403: said plainly,
   * with how to grant it.
   */
  async deleteRepo(fullName: string, login: string): Promise<void> {
    try {
      await this.#request(`/repos/${fullName}`, { method: "DELETE" }, await this.#token(login));
    } catch (e) {
      if (e instanceof GitHubError && e.status === 403)
        throw new GitHubError(
          `GitHub refused to delete ${fullName}: the token of ${login} hasn't the permission to delete repositories. Grant it on github.com → Settings → Developer settings → Personal access tokens: tick delete_repo for a classic token, or give a fine-grained one Administration: Read and write on ${fullName}; then paste the token again in Settings → Connections → GitHub.`,
          403,
        );
      if (e instanceof GitHubError && e.status === 404)
        throw new GitHubError(
          `GitHub has no repo ${fullName}, or ${login}'s token can't see it.`,
          404,
        );
      throw e;
    } finally {
      this.forget();
    }
  }

  /** Archives a repo on GitHub (read-only there), or makes it writable again. */
  async setArchived(fullName: string, archived: boolean, login: string): Promise<void> {
    try {
      await this.#request(
        `/repos/${fullName}`,
        { method: "PATCH", body: JSON.stringify({ archived }) },
        await this.#token(login),
      );
    } catch (e) {
      if (e instanceof GitHubError && e.status === 403)
        throw new GitHubError(
          `GitHub refused to ${archived ? "archive" : "unarchive"} ${fullName}: the token of ${login} hasn't the permission to change the repository's settings. Grant it on github.com → Settings → Developer settings → Personal access tokens: tick repo for a classic token, or give a fine-grained one Administration: Read and write on ${fullName}; then paste the token again in Settings → Connections → GitHub.`,
          403,
        );
      if (e instanceof GitHubError && e.status === 404)
        throw new GitHubError(
          `GitHub has no repo ${fullName}, or ${login}'s token can't see it.`,
          404,
        );
      throw e;
    } finally {
      this.forget();
    }
  }

  /** The branches of a GitHub repo and their commits (git ls-remote, the token through GIT_ASKPASS). */
  async remoteHeads(fullName: string, login: string): Promise<string[]> {
    const token = await this.#token(login);
    const r = withAskpass(token, (env) =>
      spawnSync("git", ["ls-remote", "--heads", "--", this.cloneUrl(fullName)], {
        encoding: "utf8",
        timeout: 2 * 60_000,
        env,
      }),
    );
    if (r.status !== 0)
      throw new Error(`git ls-remote failed: ${scrub(r.stderr || r.stdout || "", token).trim()}`);
    return r.stdout
      .split("\n")
      .map((l) => l.split("\t")[0] ?? "")
      .filter((sha) => /^[0-9a-f]{40,64}$/.test(sha));
  }

  /** The clone URL of a repo. */
  cloneUrl(fullName: string): string {
    return `${this.#web}/${fullName}.git`;
  }

  /**
   * Clones into `dest` (which must not exist). A GitHub URL gets the token
   * through GIT_ASKPASS for this one command; any other URL is cloned as is.
   */
  async clone(url: string, dest: string, login?: string | null) {
    if (existsSync(dest)) throw new Error(`${dest} exists already: choose another folder.`);
    const token = url.startsWith(this.#web) ? await this.#token(login) : undefined;
    const r = withAskpass(token, (env) =>
      spawnSync("git", ["clone", "-q", "--", url, dest], {
        encoding: "utf8",
        timeout: 10 * 60_000,
        env,
      }),
    );
    if (r.status !== 0) {
      rmSync(dest, { recursive: true, force: true });
      throw new Error(`git clone failed: ${scrub(r.stderr || r.stdout || "", token)}`);
    }
  }

  /**
   * Pushes branches of a repository on this computer to a GitHub repo, the
   * token given through GIT_ASKPASS for this one command (ADR-038). The
   * remote is the URL itself: nothing is written to `.git/config`.
   */
  async push(input: {
    cwd: string;
    fullName: string;
    /** `local:remote` pairs, or branch names pushed under the same name. */
    refspecs: string[];
    force?: boolean;
    login?: string | null;
  }): Promise<{ output: string }> {
    const token = await this.#token(input.login);
    const r = withAskpass(token, (env) =>
      spawnSync(
        "git",
        [
          "push",
          "--porcelain",
          ...(input.force ? ["--force-with-lease"] : []),
          "--",
          this.cloneUrl(input.fullName),
          ...input.refspecs,
        ],
        { cwd: input.cwd, encoding: "utf8", timeout: 10 * 60_000, env },
      ),
    );
    const output = scrub(`${r.stdout ?? ""}${r.stderr ?? ""}`.trim(), token);
    if (r.status !== 0) throw new Error(`git push failed: ${output}`);
    return { output };
  }
}

/** Runs one git command with the token offered through GIT_ASKPASS, and nowhere else. */
function withAskpass<T>(token: string | undefined, run: (env: NodeJS.ProcessEnv) => T): T {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  if (!token) return run(env);
  const dir = mkdtempSync(join(tmpdir(), "oraknid-askpass-"));
  const askpass = join(dir, "askpass.sh");
  writeFileSync(
    askpass,
    '#!/bin/sh\ncase "$1" in Username*) echo x-access-token ;; *) echo "$ORAKNID_GIT_TOKEN" ;; esac\n',
  );
  chmodSync(askpass, 0o700);
  try {
    return run({ ...env, GIT_ASKPASS: askpass, ORAKNID_GIT_TOKEN: token });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const scrub = (text: string, token: string | undefined) =>
  token ? text.split(token).join("[token]") : text;
