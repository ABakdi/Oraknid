import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitHubAccount } from "@oraknid/contracts";
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
  updatedAt: string;
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
    const t = token ?? (await this.#token());
    const res = await (this.o.fetch ?? fetch)(`${this.#api}${path}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${t}`,
        "x-github-api-version": "2022-11-28",
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 401) throw new Error("GitHub refused the token: it may have expired.");
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as {
        message?: string;
        errors?: { message?: string }[];
      };
      const why = body.errors?.map((e) => e.message).join("; ") || body.message || res.statusText;
      throw new Error(`GitHub said no: ${why}.`);
    }
    return (await res.json()) as T;
  }

  /** An account's repos, most recently pushed first. */
  async repos(login?: string | null): Promise<GitHubRepo[]> {
    const list = await this.#call<
      {
        full_name: string;
        name: string;
        private: boolean;
        description: string | null;
        pushed_at: string;
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
