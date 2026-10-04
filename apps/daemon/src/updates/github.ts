import type { DevAhead, ReleaseView, UpdateChannel } from "@oraknid/contracts";
import { compareVersions, isNewer, parseVersion } from "./semver.ts";

// Oraknid's releases on GitHub, read without an account (ADR-048).

export const RELEASES_REPO = "ABakdi/Oraknid";

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** A release as GitHub lists it, drafts and pre-releases included. */
export interface Release extends ReleaseView {
  draft: boolean;
}

/** What the last answers were, kept so an unchanged list costs nothing (If-None-Match). */
export interface FeedCache {
  releases: { etag: string | null; list: Release[] } | null;
  compare: { base: string; etag: string | null; ahead: DevAhead } | null;
}

export const EMPTY_CACHE: FeedCache = { releases: null, compare: null };

/** Why a check didn't get an answer, in words. */
export class CheckError extends Error {}

export interface FeedOptions {
  fetch?: Fetch;
  /** GitHub's API (tests: a stand-in). */
  api?: string;
  repo?: string;
  userAgent: string;
  timeoutMs?: number;
}

export class ReleaseFeed {
  readonly #fetch: Fetch;
  readonly #api: string;
  readonly #repo: string;

  constructor(private readonly o: FeedOptions) {
    this.#fetch = o.fetch ?? ((url, init) => fetch(url, init));
    this.#api = (o.api ?? "https://api.github.com").replace(/\/$/, "");
    this.#repo = o.repo ?? RELEASES_REPO;
  }

  /** GitHub's page of a commit or a comparison. */
  web(path: string) {
    return `https://github.com/${this.#repo}/${path}`;
  }

  async #get(
    path: string,
    etag: string | null,
  ): Promise<{ status: number; etag: string | null; body: unknown }> {
    let res: Response;
    try {
      res = await this.#fetch(`${this.#api}/repos/${this.#repo}/${path}`, {
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": this.o.userAgent,
          ...(etag ? { "if-none-match": etag } : {}),
        },
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 15_000),
      });
    } catch {
      throw new CheckError("GitHub couldn't be reached (offline?). Oraknid tries again later.");
    }
    if (res.status === 304) return { status: 304, etag, body: null };
    if (res.status === 403 || res.status === 429)
      throw new CheckError(
        "GitHub's limit for checks without an account is reached for now. Oraknid tries again later.",
      );
    if (res.status === 404) return { status: 404, etag: null, body: null };
    if (!res.ok) throw new CheckError(`GitHub answered ${res.status}. Oraknid tries again later.`);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new CheckError("GitHub's answer couldn't be read. Oraknid tries again later.");
    }
    return { status: res.status, etag: res.headers.get("etag"), body };
  }

  /** The releases, newest first; unchanged ones come from the cache (304). */
  async releases(cache: FeedCache["releases"]): Promise<NonNullable<FeedCache["releases"]>> {
    const r = await this.#get("releases?per_page=30", cache?.etag ?? null);
    if (r.status === 304 && cache) return cache;
    if (r.status === 404) return { etag: null, list: [] };
    const list = (Array.isArray(r.body) ? r.body : []).flatMap((x): Release[] => {
      const g = x as Record<string, unknown>;
      const tag = typeof g.tag_name === "string" ? g.tag_name : "";
      const v = parseVersion(tag);
      if (!v) return [];
      return [
        {
          tag,
          version: tag.replace(/^v/, ""),
          name: typeof g.name === "string" && g.name ? g.name : tag,
          draft: g.draft === true,
          prerelease: g.prerelease === true,
          publishedAt:
            typeof g.published_at === "string" ? Date.parse(g.published_at) || null : null,
          notes: typeof g.body === "string" ? g.body : "",
          url: typeof g.html_url === "string" ? g.html_url : this.web(`releases/tag/${tag}`),
        },
      ];
    });
    return { etag: r.etag, list };
  }

  /** How far `branch` is past `base` (a commit), with its newest commits. */
  async ahead(
    base: string,
    branch: string,
    cache: FeedCache["compare"],
  ): Promise<NonNullable<FeedCache["compare"]>> {
    const same = cache?.base === base ? cache : null;
    const r = await this.#get(`compare/${base}...${branch}`, same?.etag ?? null);
    if (r.status === 304 && same) return same;
    const url = this.web(`compare/${base.slice(0, 12)}...${branch}`);
    // A commit GitHub doesn't know (a clone's own work): nothing to say.
    if (r.status === 404) return { base, etag: null, ahead: { count: 0, commits: [], url } };
    const g = (r.body ?? {}) as { ahead_by?: unknown; commits?: unknown };
    const commits = (Array.isArray(g.commits) ? g.commits : [])
      .map((c) => {
        const x = c as { sha?: unknown; commit?: { message?: unknown } };
        return {
          sha: typeof x.sha === "string" ? x.sha : "",
          message:
            typeof x.commit?.message === "string" ? (x.commit.message.split("\n")[0] ?? "") : "",
        };
      })
      .reverse()
      .slice(0, 20);
    const count = typeof g.ahead_by === "number" ? g.ahead_by : commits.length;
    return { base, etag: r.etag, ahead: { count, commits, url } };
  }
}

/**
 * The releases newer than `version` on a channel, the newest first. Drafts
 * never count; pre-releases count on the dev channel only.
 */
export function newerReleases(list: Release[], version: string, channel: UpdateChannel): Release[] {
  return list
    .filter((r) => !r.draft && (channel === "dev" || !r.prerelease) && isNewer(r.tag, version))
    .sort((a, b) => {
      const x = parseVersion(a.tag);
      const y = parseVersion(b.tag);
      return x && y ? compareVersions(y, x) : 0;
    });
}
