import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

/**
 * A stand-in for GitHub's REST API, for reading repositories (ADR-040):
 * accounts by token, repositories in pages, a rich one ("me/piano") with
 * branches, a tree, files (text, binary, too large), a README, commits in
 * pages with their diffs, and pull requests. It answers with ETags (and
 * 304 to If-None-Match) and an hourly allowance in the usual headers,
 * which a test can use up. Every request is counted.
 */
export interface FakeGitHub {
  api: string;
  /** Each request, as `METHOD path` (a 304 too). */
  hits: string[];
  /** Sets an account's allowance (0: used up). */
  setRemaining(login: string, n: number): void;
  /** Asks to slow down: the next requests get a 403 with Retry-After. */
  slowDown(seconds: number | null): void;
  close(): Promise<void>;
}

const TOKENS: Record<string, string> = { "good-token": "me", "work-token": "work" };
const DAY = 86_400_000;
const iso = (n: number) => new Date(Date.UTC(2026, 9, 2) - n * DAY).toISOString();

interface Repo {
  owner: string;
  name: string;
  private: boolean;
  description: string | null;
  pushed: string | null;
  defaultBranch: string;
}

const APP_TS = `import { tune } from "./tune";

/** Plays a scale, one note a beat. */
export function play(notes: string[]): void {
  for (const n of notes) {
    // A beat each.
    tune(n, 120);
  }
}
`;

const README = `# Piano

A small piano in the browser.

- Keys you can **play**
- A metronome

\`\`\`sh
pnpm dev
\`\`\`
`;

function files(): Record<string, string | Buffer> {
  return {
    "README.md": README,
    "package.json": '{\n  "name": "piano",\n  "version": "1.0.0"\n}\n',
    "src/app.ts": APP_TS,
    "src/tune.ts": "export const tune = (note: string, bpm: number) => [note, bpm];\n",
    "assets/logo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
    "assets/samples.bin": "x".repeat(600 * 1024),
  };
}

const PATCH_APP = `@@ -1,6 +1,9 @@
 import { tune } from "./tune";

-export function play(notes) {
-  for (const n of notes) tune(n);
+/** Plays a scale, one note a beat. */
+export function play(notes: string[]): void {
+  for (const n of notes) {
+    // A beat each.
+    tune(n, 120);
+  }
 }`;

export async function startFakeGitHub(o: { fillerRepos?: number } = {}): Promise<FakeGitHub> {
  const hits: string[] = [];
  const remaining = new Map<string, number>();
  let retryAfter: number | null = null;
  const repos: Record<string, Repo[]> = {
    me: [
      {
        owner: "me",
        name: "piano",
        private: false,
        description: "A small piano in the browser",
        pushed: iso(0),
        defaultBranch: "main",
      },
      {
        owner: "me",
        name: "notes",
        private: true,
        description: null,
        pushed: iso(3),
        defaultBranch: "main",
      },
      {
        owner: "me",
        name: "empty",
        private: true,
        description: "Nothing pushed yet",
        pushed: null,
        defaultBranch: "main",
      },
      ...Array.from({ length: o.fillerRepos ?? 0 }, (_, i) => ({
        owner: "me",
        name: `old-${String(i).padStart(3, "0")}`,
        private: i % 2 === 0,
        description: `Old thing ${i}`,
        pushed: iso(10 + i),
        defaultBranch: "main",
      })),
    ],
    work: [
      {
        owner: "acme",
        name: "site",
        private: true,
        description: "The company site",
        pushed: iso(1),
        defaultBranch: "trunk",
      },
      // Also seen by "me": listed once under all accounts.
      {
        owner: "me",
        name: "piano",
        private: false,
        description: "A small piano in the browser",
        pushed: iso(0),
        defaultBranch: "main",
      },
    ],
  };
  const find = (owner: string, name: string) =>
    Object.values(repos)
      .flat()
      .find((r) => r.owner === owner && r.name === name);
  const canSee = (login: string, owner: string, name: string) =>
    (repos[login] ?? []).some((r) => r.owner === owner && r.name === name);

  const commits = Array.from({ length: 45 }, (_, i) => ({
    sha: createHash("sha1").update(`c${i}`).digest("hex"),
    message:
      i === 0
        ? "Play a scale one note a beat\n\nThe metronome sets the tempo."
        : `Change ${45 - i}`,
    date: new Date(Date.UTC(2026, 9, 2, 12) - i * 3600_000).toISOString(),
  }));

  const apiRepo = (r: Repo) => ({
    name: r.name,
    full_name: `${r.owner}/${r.name}`,
    owner: { login: r.owner },
    private: r.private,
    visibility: r.private ? "private" : "public",
    default_branch: r.defaultBranch,
    pushed_at: r.pushed,
    description: r.description,
    archived: false,
    fork: false,
    html_url: `https://github.com/${r.owner}/${r.name}`,
    stargazers_count: r.name === "piano" ? 7 : 0,
    open_issues_count: 1,
    size: r.pushed ? 120 : 0,
  });
  const apiCommit = (c: (typeof commits)[number], owner: string, name: string) => ({
    sha: c.sha,
    html_url: `https://github.com/${owner}/${name}/commit/${c.sha}`,
    commit: { message: c.message, author: { name: "Me Myself", date: c.date } },
    author: { login: "me" },
    parents: [],
  });
  const fileChanges = [
    { filename: "src/app.ts", status: "modified", additions: 6, deletions: 2, patch: PATCH_APP },
    {
      filename: "src/tune.ts",
      status: "added",
      additions: 1,
      deletions: 0,
      patch: "@@ -0,0 +1 @@\n+export const tune = (note: string, bpm: number) => [note, bpm];",
    },
    { filename: "assets/logo.png", status: "added", additions: 0, deletions: 0 },
  ];
  const pulls = [
    {
      number: 2,
      title: "Add a metronome",
      state: "open",
      draft: false,
      merged_at: null,
      body: "Adds a **metronome**.\n\n- [x] tempo\n- [ ] sound",
    },
    {
      number: 1,
      title: "First keys",
      state: "closed",
      draft: false,
      merged_at: iso(5),
      body: "",
    },
  ];
  const apiPull = (p: (typeof pulls)[number], owner: string, name: string) => ({
    number: p.number,
    title: p.title,
    state: p.state,
    draft: p.draft,
    merged_at: p.merged_at,
    user: { login: "me" },
    head: { ref: p.number === 2 ? "metronome" : "keys" },
    base: { ref: "main" },
    created_at: iso(p.number === 2 ? 1 : 6),
    updated_at: iso(p.number === 2 ? 0 : 5),
    html_url: `https://github.com/${owner}/${name}/pull/${p.number}`,
    body: p.body,
    additions: 7,
    deletions: 2,
  });

  /** One page of a list, and a Link header when there is more. */
  const paged = <T>(url: URL, all: T[], fallback = 30) => {
    const per = Number(url.searchParams.get("per_page") ?? fallback);
    const page = Number(url.searchParams.get("page") ?? 1);
    const items = all.slice((page - 1) * per, page * per);
    const next = page * per < all.length;
    const u = new URL(url);
    u.searchParams.set("page", String(page + 1));
    return { items, link: next ? `<${u}>; rel="next"` : null };
  };

  const route = (
    login: string,
    method: string,
    url: URL,
    sent: string,
  ): { status: number; body: unknown; link?: string | null } => {
    const p = url.pathname;
    if (method === "GET" && p === "/user") return { status: 200, body: { login } };
    if (method === "POST" && p === "/user/repos") {
      const b = JSON.parse(sent || "{}") as {
        name: string;
        private: boolean;
        description?: string;
      };
      if (find(login, b.name))
        return {
          status: 422,
          body: {
            message: "Repository creation failed.",
            errors: [{ message: "name already exists on this account" }],
          },
        };
      const made: Repo = {
        owner: login,
        name: b.name,
        private: b.private,
        description: b.description || null,
        pushed: new Date().toISOString(),
        defaultBranch: "main",
      };
      repos[login] = [made, ...(repos[login] ?? [])];
      return {
        status: 201,
        body: {
          full_name: `${login}/${b.name}`,
          clone_url: `https://github.com/${login}/${b.name}.git`,
        },
      };
    }
    if (method === "GET" && p === "/user/repos") {
      const { items, link } = paged(url, (repos[login] ?? []).map(apiRepo));
      return { status: 200, body: items, link };
    }
    const m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(p);
    if (!m) return { status: 404, body: { message: "Not Found" } };
    const [, owner = "", name = "", rest = ""] = m;
    const r = find(owner, name);
    if (!r || !canSee(login, owner, name)) return { status: 404, body: { message: "Not Found" } };
    const isPiano = owner === "me" && name === "piano";
    if (rest === "") return { status: 200, body: apiRepo(r) };
    if (rest === "/branches") {
      const all = r.pushed
        ? [
            { name: r.defaultBranch, commit: { sha: commits[0]?.sha }, protected: true },
            ...(isPiano
              ? [
                  { name: "dev", commit: { sha: commits[1]?.sha }, protected: false },
                  { name: "feature/keys", commit: { sha: commits[2]?.sha }, protected: false },
                ]
              : []),
          ]
        : [];
      const { items, link } = paged(url, all);
      return { status: 200, body: items, link };
    }
    if (!r.pushed && (rest.startsWith("/contents") || rest === "/readme"))
      return { status: 404, body: { message: "This repository is empty." } };
    if (!r.pushed && rest.startsWith("/commits"))
      return { status: 409, body: { message: "Git Repository is empty." } };
    const tree = files();
    if (rest.startsWith("/contents")) {
      const path = decodeURIComponent(rest.slice("/contents".length).replace(/^\//, ""));
      const content = tree[path];
      if (content !== undefined) {
        const buf = Buffer.from(content);
        const big = buf.length > 1024 * 1024 * 0.5;
        return {
          status: 200,
          body: {
            type: "file",
            name: path.split("/").pop(),
            path,
            size: buf.length,
            encoding: big ? "none" : "base64",
            content: big ? "" : buf.toString("base64"),
            html_url: `https://github.com/${owner}/${name}/blob/${url.searchParams.get("ref")}/${path}`,
          },
        };
      }
      const prefix = path ? `${path}/` : "";
      const children = new Map<string, { type: string; size: number }>();
      for (const [f, c] of Object.entries(tree)) {
        if (!f.startsWith(prefix)) continue;
        const restPath = f.slice(prefix.length);
        const [head, ...more] = restPath.split("/");
        if (!head) continue;
        children.set(
          head,
          more.length ? { type: "dir", size: 0 } : { type: "file", size: c.length },
        );
      }
      if (!children.size) return { status: 404, body: { message: "Not Found" } };
      return {
        status: 200,
        body: [...children].map(([n, x]) => ({
          type: x.type,
          name: n,
          path: `${prefix}${n}`,
          size: x.size,
        })),
      };
    }
    if (rest === "/readme") {
      const buf = Buffer.from(README);
      return {
        status: 200,
        body: {
          type: "file",
          name: "README.md",
          path: "README.md",
          size: buf.length,
          encoding: "base64",
          content: buf.toString("base64"),
        },
      };
    }
    if (rest.startsWith("/git/trees/")) {
      const entries = Object.entries(tree).map(([path, c]) => ({
        path,
        type: "blob",
        size: c.length,
        mode: "100644",
      }));
      const dirs = new Set(
        Object.keys(tree).flatMap((f) =>
          f
            .split("/")
            .slice(0, -1)
            .map((_, i, a) => a.slice(0, i + 1).join("/")),
        ),
      );
      return {
        status: 200,
        body: {
          tree: [...[...dirs].map((path) => ({ path, type: "tree", mode: "040000" })), ...entries],
          truncated: false,
        },
      };
    }
    if (rest === "/commits") {
      const list = isPiano ? commits : commits.slice(0, 1);
      const { items, link } = paged(
        url,
        list.map((c) => apiCommit(c, owner, name)),
      );
      return { status: 200, body: items, link };
    }
    const one = /^\/commits\/([0-9a-f]+)$/.exec(rest);
    if (one) {
      const c = commits.find((x) => x.sha.startsWith(one[1] ?? "-"));
      if (!c) return { status: 422, body: { message: "No commit found for SHA" } };
      return {
        status: 200,
        body: {
          ...apiCommit(c, owner, name),
          parents: [{ sha: commits[commits.indexOf(c) + 1]?.sha ?? "" }],
          stats: { additions: 7, deletions: 2 },
          files: fileChanges,
        },
      };
    }
    if (rest === "/pulls") {
      const state = url.searchParams.get("state") ?? "open";
      const list = (isPiano ? pulls : []).filter((x) => x.state === state);
      const { items, link } = paged(
        url,
        list.map((x) => apiPull(x, owner, name)),
      );
      return { status: 200, body: items, link };
    }
    const pr = /^\/pulls\/(\d+)(\/commits|\/files)?$/.exec(rest);
    if (pr) {
      const x = isPiano ? pulls.find((y) => y.number === Number(pr[1])) : undefined;
      if (!x) return { status: 404, body: { message: "Not Found" } };
      if (pr[2] === "/commits")
        return { status: 200, body: commits.slice(0, 2).map((c) => apiCommit(c, owner, name)) };
      if (pr[2] === "/files") return { status: 200, body: fileChanges.slice(0, 2) };
      return { status: 200, body: apiPull(x, owner, name) };
    }
    return { status: 404, body: { message: "Not Found" } };
  };

  const handle = (req: IncomingMessage, res: ServerResponse, sent: string) => {
    const url = new URL(req.url ?? "/", "http://fake.github");
    const method = req.method ?? "GET";
    res.setHeader("content-type", "application/json");
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
    const login = TOKENS[token];
    if (!login) {
      hits.push(`${method} ${url.pathname}${url.search}`);
      res.statusCode = 401;
      return res.end('{"message":"Bad credentials"}');
    }
    const left = remaining.get(login) ?? 5000;
    const reset = Math.floor(Date.now() / 1000) + 1800;
    res.setHeader("x-ratelimit-limit", "5000");
    res.setHeader("x-ratelimit-reset", String(reset));
    if (retryAfter !== null) {
      hits.push(`${method} ${url.pathname}${url.search}`);
      res.setHeader("x-ratelimit-remaining", String(left));
      res.setHeader("retry-after", String(retryAfter));
      res.statusCode = 403;
      return res.end('{"message":"You have exceeded a secondary rate limit."}');
    }
    if (left <= 0) {
      hits.push(`${method} ${url.pathname}${url.search}`);
      res.setHeader("x-ratelimit-remaining", "0");
      res.statusCode = 403;
      return res.end('{"message":"API rate limit exceeded."}');
    }
    const r = route(login, method, url, sent);
    const body = JSON.stringify(r.body);
    const etag = `"${createHash("sha1").update(body).digest("hex")}"`;
    hits.push(`${method} ${url.pathname}${url.search}`);
    if (r.status === 200 && req.headers["if-none-match"] === etag) {
      // Not counted against the allowance, as on GitHub.
      res.setHeader("x-ratelimit-remaining", String(left));
      res.setHeader("etag", etag);
      res.statusCode = 304;
      return res.end();
    }
    remaining.set(login, left - 1);
    res.setHeader("x-ratelimit-remaining", String(left - 1));
    if (r.status === 200) res.setHeader("etag", etag);
    if (r.link) res.setHeader("link", r.link);
    res.statusCode = r.status;
    res.end(body);
  };

  const server = createServer((req, res) => {
    let sent = "";
    req.on("data", (d) => {
      sent += d;
    });
    req.on("end", () => handle(req, res, sent));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    api: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    hits,
    setRemaining: (login, n) => remaining.set(login, n),
    slowDown: (s) => {
      retryAfter = s;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
