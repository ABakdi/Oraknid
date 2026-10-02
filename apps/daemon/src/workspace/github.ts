import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Secrets } from "../os/secrets.ts";

// GitHub through a token I paste (ADR-023): REST with fetch, cloning with
// the token given to git through GIT_ASKPASS for one command, never in a
// URL, a remote or a config file, and never to a Leg.

const TOKEN = "github.token";

export interface GitHubRepo {
  fullName: string;
  name: string;
  private: boolean;
  description: string | null;
  updatedAt: string;
}

export class GitHub {
  constructor(
    private readonly secrets: Secrets,
    private readonly o: { api?: string; web?: string; fetch?: typeof fetch } = {},
  ) {}

  get #api() {
    return this.o.api ?? "https://api.github.com";
  }

  async #call<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
    const t = token ?? (await this.secrets.get(TOKEN));
    if (!t) throw new Error("Connect GitHub first: paste a token in Settings → GitHub.");
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

  /** Whether a token is set, and whose it is. */
  async status(): Promise<{ connected: boolean; login: string | null; error: string | null }> {
    if (!(await this.secrets.get(TOKEN))) return { connected: false, login: null, error: null };
    try {
      const me = await this.#call<{ login: string }>("/user");
      return { connected: true, login: me.login, error: null };
    } catch (error) {
      return { connected: true, login: null, error: (error as Error).message };
    }
  }

  /** Checks the token against GitHub before keeping it. */
  async setToken(token: string): Promise<string> {
    const me = await this.#call<{ login: string }>("/user", {}, token.trim());
    await this.secrets.set(TOKEN, token.trim());
    return me.login;
  }

  async removeToken() {
    await this.secrets.delete(TOKEN);
  }

  /** My repos, most recently pushed first. */
  async repos(): Promise<GitHubRepo[]> {
    const list = await this.#call<
      {
        full_name: string;
        name: string;
        private: boolean;
        description: string | null;
        pushed_at: string;
      }[]
    >("/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator");
    return list.map((r) => ({
      fullName: r.full_name,
      name: r.name,
      private: r.private,
      description: r.description,
      updatedAt: r.pushed_at,
    }));
  }

  /** A new repo on my account, with a README so it can be cloned at once. */
  async createRepo(input: {
    name: string;
    private: boolean;
    description?: string;
  }): Promise<{ fullName: string; cloneUrl: string }> {
    const r = await this.#call<{ full_name: string; clone_url: string }>("/user/repos", {
      method: "POST",
      body: JSON.stringify({
        name: input.name,
        private: input.private,
        description: input.description ?? "",
        auto_init: true,
      }),
    });
    return { fullName: r.full_name, cloneUrl: r.clone_url };
  }

  /** The clone URL of one of my repos. */
  cloneUrl(fullName: string): string {
    return `${this.o.web ?? "https://github.com"}/${fullName}.git`;
  }

  /**
   * Clones into `dest` (which must not exist). A GitHub URL gets the token
   * through GIT_ASKPASS for this one command; any other URL is cloned as is.
   */
  async clone(url: string, dest: string) {
    if (existsSync(dest)) throw new Error(`${dest} exists already: choose another folder.`);
    const token = url.startsWith(this.o.web ?? "https://github.com")
      ? await this.secrets.get(TOKEN)
      : undefined;
    const dir = mkdtempSync(join(tmpdir(), "oraknid-askpass-"));
    const askpass = join(dir, "askpass.sh");
    writeFileSync(
      askpass,
      '#!/bin/sh\ncase "$1" in Username*) echo x-access-token ;; *) echo "$ORAKNID_GIT_TOKEN" ;; esac\n',
    );
    chmodSync(askpass, 0o700);
    try {
      const r = spawnSync("git", ["clone", "-q", "--", url, dest], {
        encoding: "utf8",
        timeout: 10 * 60_000,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          ...(token ? { GIT_ASKPASS: askpass, ORAKNID_GIT_TOKEN: token } : {}),
        },
      });
      if (r.status !== 0) {
        rmSync(dest, { recursive: true, force: true });
        throw new Error(`git clone failed: ${(r.stderr || r.stdout || "").trim()}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
