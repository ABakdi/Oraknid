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
  /** GitHub Actions on me/piano (ADR-058). */
  ci: FakeActions;
  close(): Promise<void>;
}

/** A run of the stand-in's Actions, changed by a test as GitHub would. */
export interface FakeRun {
  id: number;
  workflowId: number;
  name: string;
  branch: string;
  sha: string;
  event: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: string | null;
  attempt: number;
  jobs: FakeJob[];
}

export interface FakeJob {
  id: number;
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: string | null;
  steps: {
    number: number;
    name: string;
    status: string;
    conclusion: string | null;
    started_at: string | null;
  }[];
}

export interface FakeActions {
  runs: FakeRun[];
  /** Each job's log, by its id. */
  logs: Map<number, string>;
  /** The changes asked: "rerun 102", "rerun-failed-jobs 102", "cancel 103", "dispatch 12 dev {…}". */
  changes: string[];
  /** Whether a token was sent to a signed address (it never should be). */
  tokenOnBlob: boolean;
  /** A new run on a branch, in progress (its one job running). */
  push(o: { branch: string; sha: string; name?: string; workflowId?: number }): FakeRun;
  /** A run ends, its jobs with it; a failure fails its job's "Run tests" step. */
  finish(id: number, conclusion: "success" | "failure" | "cancelled"): void;
  /** No workflows at all (the repository runs nothing). */
  noWorkflows(): void;
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

  // ── GitHub Actions on me/piano (ADR-058) ──────────────────────────
  const at = (h: number, m: number, s: number) =>
    new Date(Date.UTC(2026, 9, 2, h, m, s)).toISOString().replace(".000Z", "Z");
  const steps = (start: [number, number, number][], failAt: number | null, running = false) =>
    ["Set up job", "Run actions/checkout@v4", "Install", "Run tests", "Complete job"].map(
      (name, i) => ({
        number: i + 1,
        name,
        status: running && i >= 3 ? "in_progress" : "completed",
        conclusion: running && i >= 3 ? null : failAt === i + 1 ? "failure" : "success",
        started_at: start[i] ? at(...(start[i] as [number, number, number])) : null,
      }),
    );
  const TIMES: [number, number, number][] = [
    [12, 0, 0],
    [12, 0, 2],
    [12, 0, 5],
    [12, 0, 20],
    [12, 1, 0],
  ];
  const failingLog = [
    `${at(12, 0, 0).replace("Z", ".1000000Z")} Current runner version: '2.320.0'`,
    `${at(12, 0, 0).replace("Z", ".2000000Z")} Runner name: 'GitHub Actions 3'`,
    `${at(12, 0, 2).replace("Z", ".1000000Z")} ##[group]Run actions/checkout@v4`,
    `${at(12, 0, 2).replace("Z", ".3000000Z")} Syncing repository: me/piano`,
    `${at(12, 0, 3).replace("Z", ".0000000Z")} ##[endgroup]`,
    `${at(12, 0, 5).replace("Z", ".1000000Z")} ##[group]Run pnpm install --frozen-lockfile`,
    `${at(12, 0, 6).replace("Z", ".0000000Z")} Lockfile is up to date`,
    `${at(12, 0, 19).replace("Z", ".0000000Z")} Done in 13s`,
    `${at(12, 0, 20).replace("Z", ".1000000Z")} ##[group]Run pnpm test`,
    `${at(12, 0, 21).replace("Z", ".0000000Z")}  RUN  v5.0.3 /home/runner/work/piano`,
    ...Array.from(
      { length: 50 },
      (_, i) =>
        `${at(12, 0, 22 + Math.floor(i / 2)).replace("Z", ".5000000Z")}  ✓ src/keys.test.ts > key ${i}`,
    ),
    `${at(12, 0, 58).replace("Z", ".0000000Z")}  FAIL  src/tune.test.ts > tune > plays at 120 bpm`,
    `${at(12, 0, 58).replace("Z", ".1000000Z")} \u001b[31mAssertionError: expected 100 to be 120\u001b[39m`,
    `${at(12, 0, 59).replace("Z", ".0000000Z")} ##[error]Process completed with exit code 1.`,
    `${at(12, 1, 0).replace("Z", ".1000000Z")} Post job cleanup.`,
    `${at(12, 1, 0).replace("Z", ".2000000Z")} Cleaning up orphan processes`,
  ].join("\n");
  const passingLog = (sha: string) =>
    [
      `${at(12, 0, 0).replace("Z", ".1000000Z")} Current runner version: '2.320.0'`,
      `${at(12, 0, 20).replace("Z", ".1000000Z")} ##[group]Run pnpm test`,
      `${at(12, 0, 30).replace("Z", ".1000000Z")}  Test Files  12 passed (12) at ${sha.slice(0, 7)}`,
    ].join("\n");
  let workflows = [
    { id: 11, name: "CI", path: ".github/workflows/ci.yml", state: "active" },
    { id: 12, name: "Deploy", path: ".github/workflows/deploy.yml", state: "active" },
  ];
  const WORKFLOW_FILES: Record<string, string> = {
    ".github/workflows/ci.yml":
      "name: CI\non: [push, pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n",
    ".github/workflows/deploy.yml": `name: Deploy
on:
  workflow_dispatch:
    inputs:
      environment:
        description: Where to
        type: choice
        options: [staging, production]
        default: staging
      dry_run:
        type: boolean
        default: true
      note:
        description: Why
        required: true
jobs:
  deploy:
    runs-on: ubuntu-latest
`,
  };
  const ci: FakeActions = {
    runs: [
      {
        id: 101,
        workflowId: 11,
        name: "CI",
        branch: "main",
        sha: commits[0]?.sha ?? "",
        event: "push",
        status: "completed",
        conclusion: "success",
        attempt: 1,
        jobs: [
          {
            id: 1001,
            name: "test",
            status: "completed",
            conclusion: "success",
            steps: steps(TIMES, null),
          },
        ],
      },
      {
        id: 102,
        workflowId: 11,
        name: "CI",
        branch: "dev",
        sha: commits[1]?.sha ?? "",
        event: "push",
        status: "completed",
        conclusion: "failure",
        attempt: 1,
        jobs: [
          {
            id: 1002,
            name: "build",
            status: "completed",
            conclusion: "success",
            steps: steps(TIMES, null),
          },
          {
            id: 1003,
            name: "test",
            status: "completed",
            conclusion: "failure",
            steps: steps(TIMES, 4),
          },
        ],
      },
    ],
    logs: new Map([
      [1001, passingLog(commits[0]?.sha ?? "")],
      [1002, passingLog(commits[1]?.sha ?? "")],
      [1003, failingLog],
    ]),
    changes: [],
    tokenOnBlob: false,
    push: (o) => {
      const id = 200 + ci.runs.length;
      const run: FakeRun = {
        id,
        workflowId: o.workflowId ?? 11,
        name: o.name ?? "CI",
        branch: o.branch,
        sha: o.sha,
        event: "push",
        status: "in_progress",
        conclusion: null,
        attempt: 1,
        jobs: [
          {
            id: id * 10,
            name: "test",
            status: "in_progress",
            conclusion: null,
            steps: steps(TIMES, null, true),
          },
        ],
      };
      ci.runs.push(run);
      ci.logs.set(id * 10, passingLog(o.sha));
      return run;
    },
    finish: (id, conclusion) => {
      const run = ci.runs.find((r) => r.id === id);
      if (!run) return;
      run.status = "completed";
      run.conclusion = conclusion;
      for (const j of run.jobs) {
        j.status = "completed";
        j.conclusion = conclusion;
        j.steps = steps(TIMES, conclusion === "failure" ? 4 : null);
        if (conclusion === "failure") ci.logs.set(j.id, failingLog);
      }
    },
    noWorkflows: () => {
      workflows = [];
    },
  };
  const apiRun = (r: FakeRun, owner: string, name: string) => ({
    id: r.id,
    name: r.name,
    display_title: `A change on ${r.branch}`,
    workflow_id: r.workflowId,
    head_branch: r.branch,
    head_sha: r.sha,
    event: r.event,
    status: r.status,
    conclusion: r.conclusion,
    run_attempt: r.attempt,
    actor: { login: "me" },
    run_started_at: at(12, 0, 0),
    created_at: at(12, 0, 0),
    updated_at: at(12, 1, 30),
    html_url: `https://github.com/${owner}/${name}/actions/runs/${r.id}`,
    pull_requests: r.branch === "metronome" ? [{ number: 2 }] : [],
  });
  const apiJob = (j: FakeJob, owner: string, name: string) => ({
    id: j.id,
    name: j.name,
    status: j.status,
    conclusion: j.conclusion,
    started_at: at(12, 0, 0),
    completed_at: j.status === "completed" ? at(12, 1, 1) : null,
    html_url: `https://github.com/${owner}/${name}/actions/runs/0/job/${j.id}`,
    steps: j.steps.map((s) => ({
      ...s,
      completed_at: s.status === "completed" ? s.started_at : null,
    })),
  });
  const artifacts = (runId: number) =>
    runId === 102
      ? [
          {
            id: 501,
            name: "coverage",
            size_in_bytes: 18,
            expired: false,
            created_at: at(12, 1, 0),
            expires_at: "2026-12-31T00:00:00Z",
          },
          {
            id: 502,
            name: "old-build",
            size_in_bytes: 1000,
            expired: true,
            created_at: at(12, 1, 0),
            expires_at: "2026-10-03T00:00:00Z",
          },
        ]
      : [];
  type Routed = { status: number; body: unknown; link?: string | null; location?: string };
  const actionsRoute = (
    method: string,
    url: URL,
    rest: string,
    owner: string,
    name: string,
    sent: string,
    host: string,
  ): Routed | null => {
    const piano = owner === "me" && name === "piano";
    const wfFile = /^\/contents\/(\.github\/workflows\/.+)$/.exec(rest);
    if (method === "GET" && wfFile) {
      const content = piano ? WORKFLOW_FILES[decodeURIComponent(wfFile[1] ?? "")] : undefined;
      if (content === undefined) return { status: 404, body: { message: "Not Found" } };
      return {
        status: 200,
        body: {
          type: "file",
          content: Buffer.from(content).toString("base64"),
          encoding: "base64",
        },
      };
    }
    if (!rest.startsWith("/actions/")) return null;
    const runs = piano ? ci.runs : [];
    const list = (all: FakeRun[]) => {
      const branch = url.searchParams.get("branch");
      const mine = all.filter((r) => !branch || r.branch === branch).sort((a, b) => b.id - a.id);
      const { items, link } = paged(url, mine);
      return {
        status: 200,
        body: { total_count: mine.length, workflow_runs: items.map((r) => apiRun(r, owner, name)) },
        link,
      };
    };
    if (method === "GET" && rest === "/actions/workflows") {
      const wfs = piano ? workflows : [];
      return { status: 200, body: { total_count: wfs.length, workflows: wfs } };
    }
    const wfRuns = /^\/actions\/workflows\/(\d+)\/runs$/.exec(rest);
    if (method === "GET" && wfRuns)
      return list(runs.filter((r) => r.workflowId === Number(wfRuns[1])));
    if (method === "GET" && rest === "/actions/runs") return list(runs);
    const run = /^\/actions\/runs\/(\d+)(\/[a-z-]+)?$/.exec(rest);
    if (run) {
      const r = runs.find((x) => x.id === Number(run[1]));
      if (!r) return { status: 404, body: { message: "Not Found" } };
      const what = run[2] ?? "";
      if (method === "GET" && what === "") return { status: 200, body: apiRun(r, owner, name) };
      if (method === "GET" && what === "/jobs")
        return {
          status: 200,
          body: { total_count: r.jobs.length, jobs: r.jobs.map((j) => apiJob(j, owner, name)) },
        };
      if (method === "GET" && what === "/artifacts") {
        const a = artifacts(r.id);
        return { status: 200, body: { total_count: a.length, artifacts: a } };
      }
      if (method === "POST" && (what === "/rerun" || what === "/rerun-failed-jobs")) {
        ci.changes.push(`${what.slice(1)} ${r.id}`);
        r.status = "queued";
        r.conclusion = null;
        r.attempt += 1;
        return { status: 201, body: {} };
      }
      if (method === "POST" && what === "/cancel") {
        if (r.status === "completed")
          return {
            status: 409,
            body: { message: "Cannot cancel a workflow run that is completed." },
          };
        ci.changes.push(`cancel ${r.id}`);
        r.status = "completed";
        r.conclusion = "cancelled";
        return { status: 202, body: {} };
      }
    }
    const job = /^\/actions\/jobs\/(\d+)(\/logs)?$/.exec(rest);
    if (method === "GET" && job) {
      const j = runs.flatMap((x) => x.jobs).find((x) => x.id === Number(job[1]));
      if (!j) return { status: 404, body: { message: "Not Found" } };
      if (job[2])
        return {
          status: 302,
          body: null,
          location: `http://${host}/blobs/log-${j.id}?sig=signed`,
        };
      return { status: 200, body: apiJob(j, owner, name) };
    }
    const art = /^\/actions\/artifacts\/(\d+)(\/zip)?$/.exec(rest);
    if (method === "GET" && art) {
      const a = runs.flatMap((x) => artifacts(x.id)).find((x) => x.id === Number(art[1]));
      if (!a) return { status: 404, body: { message: "Not Found" } };
      if (art[2]) {
        if (a.expired) return { status: 410, body: { message: "Artifact has expired" } };
        return {
          status: 302,
          body: null,
          location: `http://${host}/blobs/artifact-${a.id}?sig=signed`,
        };
      }
      return { status: 200, body: a };
    }
    const dispatch = /^\/actions\/workflows\/(\d+)\/dispatches$/.exec(rest);
    if (method === "POST" && dispatch) {
      const wf = workflows.find((w) => w.id === Number(dispatch[1]));
      if (!piano || !wf) return { status: 404, body: { message: "Not Found" } };
      const b = JSON.parse(sent || "{}") as { ref?: string; inputs?: Record<string, string> };
      ci.changes.push(`dispatch ${wf.id} ${b.ref} ${JSON.stringify(b.inputs ?? {})}`);
      const made = ci.push({
        branch: b.ref ?? "main",
        sha: commits[0]?.sha ?? "",
        name: wf.name,
        workflowId: wf.id,
      });
      made.event = "workflow_dispatch";
      return { status: 204, body: null };
    }
    return { status: 404, body: { message: "Not Found" } };
  };

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

  const route = (login: string, method: string, url: URL, sent: string, host = ""): Routed => {
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
    const actions = actionsRoute(method, url, rest, owner, name, sent, host);
    if (actions) return actions;
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
    // A signed address (a log, an artifact): no token needed, and none should come.
    const blob = /^\/blobs\/(log|artifact)-(\d+)$/.exec(url.pathname);
    if (blob) {
      hits.push(`${method} ${url.pathname}`);
      if (req.headers.authorization) ci.tokenOnBlob = true;
      if (blob[1] === "log") {
        res.setHeader("content-type", "text/plain; charset=utf-8");
        return res.end(ci.logs.get(Number(blob[2])) ?? "");
      }
      const zip = Buffer.from(`PK\u0003\u0004fake-zip-${blob[2]}`);
      res.setHeader("content-type", "application/zip");
      res.setHeader("content-length", String(zip.length));
      return res.end(zip);
    }
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
    const r = route(login, method, url, sent, req.headers.host ?? "");
    if (r.location) res.setHeader("location", r.location);
    const body = r.body === null ? "" : JSON.stringify(r.body);
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
    ci,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
