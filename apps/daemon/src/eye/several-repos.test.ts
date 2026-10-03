import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobView, Question, WebPlan } from "@oraknid/contracts";
import type { SessionStart } from "@oraknid/leg-sdk";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { ulid } from "ulid";
import { afterEach, describe, expect, it } from "vitest";
import type { Router } from "../api/router.ts";
import { type Daemon, startDaemon } from "../daemon.ts";
import { closeDatabase, openDatabase } from "../db/open.ts";
import { servers } from "../db/schema.ts";
import { resolvePaths } from "../paths.ts";
import { fakeOs } from "../testing/fake-os.ts";
import { type Action, scriptedLeg, type TurnContext } from "../testing/scripted-leg.ts";
import { GitHub } from "../workspace/github.ts";
import { findRepos, reposOfScope } from "../workspace/repos.ts";
import type { EyeBrain } from "./brain.ts";
import { parseBuiltinCheck, runBuiltinCheck } from "./builtin-checks.ts";
import { namedServer, roleIn } from "./links.ts";

// ADR-042: a project of several repos (a site and its API, each its own
// repository), a job across them, and servers with a role in the project.

let daemon: Daemon | undefined;
let stop: (() => void) | undefined;
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  stop?.();
  stop = undefined;
});

const git = (cwd: string, ...a: string[]) =>
  spawnSync("git", ["-c", "user.email=me@example.com", "-c", "user.name=Me", ...a], {
    cwd,
    encoding: "utf8",
  });
const out = (cwd: string, ...a: string[]) => git(cwd, ...a).stdout.trim();

/** A repo with main and dev, a commit on each. */
function repoAt(dir: string, file: string) {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), `# ${file}\n`);
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "start");
  git(dir, "branch", "dev");
}

/** The project's folder: not a repo itself, `web/` and `api/` each one. */
function twoRepos() {
  const dir = mkdtempSync(join(tmpdir(), "oraknid-several-"));
  repoAt(join(dir, "web"), "web");
  repoAt(join(dir, "api"), "api");
  writeFileSync(join(dir, "notes.txt"), "not in any repo\n");
  return dir;
}

const TOKEN = "ghp-several-token";

/** A stand-in for GitHub: its API, bare repos the clone URLs point to, and branches read from them. */
async function fakeGitHub() {
  const web = mkdtempSync(join(tmpdir(), "oraknid-several-gh-"));
  const repos = new Map<string, { private: boolean }>();
  const bare = (full: string) => join(web, `${full}.git`);
  const make = (full: string, priv: boolean) => {
    repos.set(full, { private: priv });
    mkdirSync(bare(full), { recursive: true });
    git(bare(full), "init", "-q", "--bare", "-b", "main");
  };
  make("me/site", false);
  make("me/site-api", true);
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.statusCode = 401;
        return res.end('{"message":"Bad credentials"}');
      }
      const url = req.url ?? "";
      if (url === "/user") return res.end(JSON.stringify({ login: "me" }));
      if (url.startsWith("/user/repos") && req.method === "GET")
        return res.end(
          JSON.stringify(
            [...repos].map(([full, r]) => ({
              full_name: full,
              name: full.split("/")[1],
              private: r.private,
              description: null,
              pushed_at: "2026-10-03T00:00:00Z",
            })),
          ),
        );
      const branch = /^\/repos\/([^/]+\/[^/]+)\/branches\/(.+)$/.exec(url);
      if (branch && repos.has(branch[1] as string)) {
        const sha = out(
          bare(branch[1] as string),
          "rev-parse",
          "--verify",
          "-q",
          `refs/heads/${decodeURIComponent(branch[2] as string)}`,
        );
        if (!sha) {
          res.statusCode = 404;
          return res.end('{"message":"Branch not found"}');
        }
        return res.end(JSON.stringify({ name: branch[2], commit: { sha } }));
      }
      const repo = /^\/repos\/([^/]+\/[^/]+)$/.exec(url);
      if (repo && repos.has(repo[1] as string)) {
        const full = repo[1] as string;
        return res.end(
          JSON.stringify({
            full_name: full,
            private: repos.get(full)?.private,
            default_branch: "main",
            html_url: `https://github.com/${full}`,
            description: null,
          }),
        );
      }
      res.statusCode = 404;
      res.end('{"message":"Not Found"}');
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  stop = () => server.close();
  return { api: `http://127.0.0.1:${(server.address() as { port: number }).port}`, web, bare };
}

async function harness(
  folder: string,
  script: (t: TurnContext) => Action[],
  plan: () => WebPlan,
  o: { github?: { api: string; web: string } } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "oraknid-several-data-"));
  const leg = scriptedLeg(script);
  const starts: SessionStart[] = [];
  const start = leg.adapter.start.bind(leg.adapter);
  leg.adapter.start = (s) => {
    starts.push(s);
    return start(s);
  };
  const plans: { digest: string; cwd: string }[] = [];
  const brain = {
    plan: async (i: { digest: string; cwd: string }) => {
      plans.push(i);
      return plan();
    },
    replan: async () => ({ ...plan(), tasks: [] }),
    summarize: async () => ({ title: "s", body: "s" }),
    evaluate: async () => ({ accepted: true, reason: "ok", missing: [] }),
    repairCheck: async ({ command }: { command: string }) => ({
      broken: false,
      command,
      reason: "",
    }),
    triage: async () => ({ intent: "question", reply: "Fine.", silk: null, tasks: [] }),
    classifyCommand: async () => ({ decision: "allow" as const, reason: "fine" }),
    interviewRound: async () => ({ done: true, playback: "Clear.", questions: [], open: [] }),
  } as unknown as EyeBrain;
  daemon = await startDaemon({
    paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
    port: 0,
    dbFile: ":memory:",
    os: fakeOs({ keychain: true }).os,
    adapters: { "claude-code": leg.adapter },
    brain,
    ...(o.github ? { github: o.github } : {}),
    metricsIntervalMs: 50,
    stallCheckMs: 100,
  });
  const api = createORPCClient<RouterClient<Router>>(
    new RPCLink({
      url: `${daemon.url}/api`,
      headers: { authorization: `Bearer ${daemon.cliToken}` },
    }),
  );
  await api.legs.create({ kind: "claude-code", name: "Claude A", config: {} });
  const project = await api.projects.create({ name: "site", workspacePath: folder });
  return { d: daemon, api, leg, starts, plans, project };
}

type Api = Awaited<ReturnType<typeof harness>>["api"];

async function until(api: Api, id: string, states: string[], ms = 20_000): Promise<JobView> {
  const end = Date.now() + ms;
  for (;;) {
    const j = await api.jobs.get({ id });
    if (states.includes(j.state)) return j;
    if (Date.now() > end) throw new Error(`job stayed ${j.state} (${j.blockedReason ?? ""})`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function eventually<T>(fn: () => Promise<T | undefined | null | false>, ms = 15_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

const task = (
  key: string,
  title: string,
  scope: string[],
  verify: string[],
  dependsOn: string[] = [],
): WebPlan["tasks"][number] => ({
  key,
  title,
  instructions: title,
  kind: "implement",
  dependsOn,
  scope,
  verify,
  requiredCapabilities: ["implementation"],
  difficulty: "low",
});

async function newJob(api: Api, projectId: string, goal: string) {
  const { id } = await api.jobs.create({
    projectId,
    goal,
    verify: [],
    autonomy: "standard",
    inputs: [],
    allowedLegIds: [],
    unsandboxed: false,
  });
  await api.jobs.start({ id });
  return id;
}

const PAGE = "Build the page and its API";
const HEALTH = "Add the health route";

describe("a project of several repos (ADR-042)", () => {
  it("finds its repos, works across them, and commits, checks, rolls back and merges each on its own", async () => {
    const folder = twoRepos();
    const isTask = (t: TurnContext, title: string) => t.system.includes(`# Your task: ${title}`);
    const { api, starts, plans, project } = await harness(
      folder,
      (t) => {
        if (isTask(t, HEALTH))
          return t.turn === 1
            ? [
                { write: "api/health.js", content: "export const ok = true;\n" },
                // Outside the task's scope (api/**): put back, never committed (D1).
                { write: "web/stray.txt", content: "not mine\n" },
                { say: "DONE" },
              ]
            : [{ say: "DONE" }];
        return [
          { write: "web/index.html", content: "<h1>site</h1>\n" },
          { write: "api/server.js", content: "export const port = 8080;\n" },
          { say: "DONE" },
        ];
      },
      () => ({
        summary: "A page and its API.",
        tasks: [
          task(
            "t1",
            PAGE,
            ["web/**", "api/**"],
            ["test -f web/index.html", "test -f api/server.js"],
          ),
          task("t2", HEALTH, ["api/**"], ["test -f api/health.js"], ["t1"]),
        ],
        jobVerify: [],
      }),
    );
    // Found when the project was added: each repo by its folder, its own branches.
    expect(project.repos).toEqual([
      { name: "api", folder: "api", releaseBranch: "main", workBranch: "dev", github: null },
      { name: "web", folder: "web", releaseBranch: "main", workBranch: "dev", github: null },
    ]);
    expect(project.github).toBeNull();
    expect(project.isGitRepo).toBe(true);

    const id = await newJob(api, project.id, "A page and its API");
    const done = await until(api, id, ["completed", "blocked", "paused", "waiting"]);
    expect(done.state).toBe("completed");

    // The plan knew the layout and read the project's folder.
    expect(plans[0]?.digest).toContain("`web/`: the repo **web**");
    expect(plans[0]?.cwd).toBe(folder);
    // The Leg worked in the job's folder, each repo a worktree at its folder.
    const job = await api.jobs.get({ id });
    const root = job.worktree as string;
    expect(root).toBe(join(folder, ".oraknid", "worktrees", id));
    expect(starts[0]?.cwd).toBe(root);
    expect(starts[0]?.systemPrompt).toContain("# The repos");
    for (const r of ["web", "api"]) {
      expect(readFileSync(join(root, r, ".git"), "utf8")).toMatch(/^gitdir: /);
      expect(out(join(root, r), "rev-parse", "--abbrev-ref", "HEAD")).toBe(job.branch);
    }

    // One commit per repo the task changed, each with its own message, never one across them.
    const branch = job.branch as string;
    expect(out(join(folder, "web"), "log", "--format=%s", `dev..${branch}`)).toBe(
      "feat(web): build the page and its API",
    );
    expect(out(join(folder, "api"), "log", "--format=%s", `dev..${branch}`).split("\n")).toEqual([
      "feat: add the health route",
      "feat(api): build the page and its API",
    ]);
    // D1 in one repo: the stray file in web/ was put back, never committed, kept in the trash.
    expect(existsSync(join(root, "web", "stray.txt"))).toBe(false);
    expect(out(join(folder, "web"), "show", "--name-only", "--format=", branch)).toBe("index.html");
    const trash = join(folder, ".oraknid", "trash");
    const trashed = readdirSync(trash, { recursive: true }).map(String);
    expect(trashed.some((p) => p.startsWith("web/") && p.endsWith("stray.txt"))).toBe(true);

    // The task's diff shows each repo's part under its folder.
    const tasks = (await api.jobs.get({ id })).tasks;
    const t1 = tasks.find((t) => t.title === PAGE);
    const diff = await api.tasks.diff({ taskId: t1?.id as string });
    expect(diff.from).toBe("commit");
    expect(diff.text).toContain("b/web/index.html");
    expect(diff.text).toContain("b/api/server.js");

    // The result lists each repo's branch and commits.
    const result = await api.jobs.result({ id });
    expect(result).toMatchObject({ branch, into: "dev", merged: false, cannotMerge: null });
    expect(result.repos.map((r) => [r.name, r.commits.length, r.merged])).toEqual([
      ["api", 2, false],
      ["web", 1, false],
    ]);

    // Rolled back to before the health route: only api's file goes, to the trash.
    const t2 = tasks.find((t) => t.title === HEALTH);
    await api.tasks.rollback({ taskId: t2?.id as string, attempt: 1 });
    expect(existsSync(join(root, "api", "health.js"))).toBe(false);
    expect(existsSync(join(root, "web", "index.html"))).toBe(true);
    git(join(root, "api"), "checkout", "-q", "--", ".");

    // Merge merges each repo's job branch into its own work branch; my checkouts stay as they are.
    const m = await api.jobs.merge({ id });
    expect(m.ok).toBe(true);
    expect(out(join(folder, "web"), "show", "dev:index.html")).toBe("<h1>site</h1>");
    expect(out(join(folder, "api"), "show", "dev:health.js")).toBe("export const ok = true;");
    expect(existsSync(join(folder, "web", "index.html"))).toBe(false);
    expect((await api.jobs.result({ id })).merged).toBe(true);
  }, 90_000);

  it("detects repos again, adds one (a folder, a new one), and a one-repo project stays as it was", async () => {
    const folder = twoRepos();
    const { api, project } = await harness(
      folder,
      () => [{ say: "DONE" }],
      () => ({ summary: "", tasks: [], jobVerify: [] }),
    );
    // A third repo appears in the folder: found again.
    repoAt(join(folder, "apps", "admin"), "admin");
    const found = await api.projects.detectRepos({ id: project.id });
    expect(found.map((r) => [r.name, r.folder])).toEqual([
      ["api", "api"],
      ["web", "web"],
      ["admin", "apps/admin"],
    ]);
    // A new empty one, made a repo; a folder that isn't one is refused.
    const added = await api.projects.addRepo({
      id: project.id,
      name: "docs-site",
      source: { kind: "new", folder: "docs" },
    });
    expect(added.repos.at(-1)).toMatchObject({ name: "docs-site", folder: "docs" });
    expect(existsSync(join(folder, "docs", ".git"))).toBe(true);
    mkdirSync(join(folder, "plain"));
    await expect(
      api.projects.addRepo({ id: project.id, source: { kind: "folder", folder: "plain" } }),
    ).rejects.toThrow(/is not a git repo/);
    await expect(
      api.projects.addRepo({ id: project.id, source: { kind: "folder", folder: "../x" } }),
    ).rejects.toThrow();
    const removed = await api.projects.removeRepo({ id: project.id, name: "docs-site" });
    expect(removed.repos.map((r) => r.name)).toEqual(["api", "web", "admin"]);

    // Renamed, its branches changed; a name taken, a bad branch, the same branch twice refused.
    const renamed = await api.projects.updateRepo({
      id: project.id,
      name: "admin",
      rename: "back-office",
      releaseBranch: "trunk",
      workBranch: "next",
    });
    expect(renamed.repos.at(-1)).toMatchObject({
      name: "back-office",
      folder: "apps/admin",
      releaseBranch: "trunk",
      workBranch: "next",
    });
    await expect(
      api.projects.updateRepo({ id: project.id, name: "back-office", rename: "web" }),
    ).rejects.toThrow(/named web already/);
    await expect(
      api.projects.updateRepo({ id: project.id, name: "web", workBranch: "bad..name" }),
    ).rejects.toThrow(/isn't a branch name/);
    await expect(
      api.projects.updateRepo({ id: project.id, name: "web", workBranch: "main" }),
    ).rejects.toThrow(/must be different/);
    await expect(
      api.projects.updateRepo({ id: project.id, name: "nope", rename: "x" }),
    ).rejects.toThrow(/No repo nope/);
    const listed = (await api.projects.list()).find((x) => x.id === project.id);
    expect(listed?.repos.map((r) => r.name)).toEqual(["api", "web", "back-office"]);

    // A folder that is a repo is one repo, as before: folder "", its link the project's.
    const one = mkdtempSync(join(tmpdir(), "oraknid-one-"));
    repoAt(one, "one");
    repoAt(join(one, "vendor-lib"), "lib");
    const p1 = await api.projects.create({ name: "one", workspacePath: one });
    expect(p1.repos).toEqual([
      {
        name: one.split("/").at(-1),
        folder: "",
        releaseBranch: "main",
        workBranch: "dev",
        github: null,
      },
    ]);
    // A project of one repo: its repo's branches changed are the project's too.
    await api.projects.updateRepo({
      id: p1.id,
      name: one.split("/").at(-1) as string,
      workBranch: "develop",
    });
    const p1b = (await api.projects.list()).find((x) => x.id === p1.id);
    expect([p1b?.releaseBranch, p1b?.workBranch]).toEqual(["main", "develop"]);
    // Adding the repo inside makes it a project of several, its own folder's repo first.
    const p2 = await api.projects.addRepo({
      id: p1.id,
      source: { kind: "folder", folder: "vendor-lib" },
    });
    expect(p2.repos.map((r) => [r.name, r.folder])).toEqual([
      [one.split("/").at(-1), ""],
      ["vendor-lib", "vendor-lib"],
    ]);
  }, 60_000);

  it("pushes each repo to its own link and checks each with --repo, asking for the links once", async () => {
    const folder = twoRepos();
    const gh = await fakeGitHub();
    const PUSH = "Push both repos to GitHub";
    const { d, api, leg, project } = await harness(
      folder,
      (t) =>
        t.system.includes(`# Your task: ${PUSH}`)
          ? t.turn === 1
            ? [
                { mcp: { server: "oraknid-github", tool: "repo_info" } },
                { mcp: { server: "oraknid-github", tool: "push", args: { repo: "web" } } },
                { mcp: { server: "oraknid-github", tool: "push", args: { repo: "api" } } },
                // A repo of several left unnamed can't be guessed.
                { mcp: { server: "oraknid-github", tool: "push", args: {} } },
                { say: "DONE" },
              ]
            : [{ say: "DONE" }]
          : [
              { write: "web/index.html", content: "<h1>site</h1>\n" },
              { write: "api/server.js", content: "export const port = 8080;\n" },
              { say: "DONE" },
            ],
      () => ({
        summary: "Build, then push.",
        tasks: [
          task("t1", PAGE, ["web/**", "api/**"], ["test -f web/index.html"]),
          // Planned around gh: brought to the links, a check per repo.
          {
            ...task("t2", PUSH, ["web/**", "api/**"], ["gh repo view"], ["t1"]),
            instructions: "Push the job branch of each repo to GitHub with gh.",
          },
        ],
        jobVerify: [],
      }),
      { github: { api: gh.api, web: gh.web } },
    );
    await api.github.addAccount({ token: TOKEN });
    const id = await newJob(api, project.id, "Build it and put both repos on GitHub");

    // The Eye asks once, a question per repo, the account being the only one.
    const asked = await eventually(async () =>
      (await api.projects.conversation({ id: project.id })).find((m) => m.questions?.length),
    );
    expect(asked.text).toContain("needs GitHub repos for **api** and **web**");
    const qs = asked.questions as Question[];
    expect(qs.map((q) => q.id)).toEqual(["repo:api", "repo:web", "visibility"]);
    expect(qs[0]?.options[0]?.label).toBe("Create a new repo: me/site-api");
    await api.projects.answer({
      id: project.id,
      messageId: asked.id,
      answers: [
        { questionId: "repo:api", options: [], text: "me/site-api" },
        { questionId: "repo:web", options: [], text: "me/site" },
      ],
    });
    expect((await until(api, id, ["completed", "blocked", "paused"])).state).toBe("completed");

    const repos = (await api.projects.list()).find((p) => p.id === project.id)?.repos ?? [];
    expect(repos.map((r) => [r.name, `${r.github?.owner}/${r.github?.name}`])).toEqual([
      ["api", "me/site-api"],
      ["web", "me/site"],
    ]);
    // Each repo's job branch is on its own GitHub repo, at the commit here.
    const branch = (await api.jobs.get({ id })).branch as string;
    expect(out(gh.bare("me/site"), "rev-parse", branch)).toBe(
      out(join(folder, "web"), "rev-parse", branch),
    );
    expect(out(gh.bare("me/site-api"), "rev-parse", branch)).toBe(
      out(join(folder, "api"), "rev-parse", branch),
    );
    expect(leg.mcpResults.map((r) => [r.tool, r.isError])).toEqual([
      ["repo_info", false],
      ["push", false],
      ["push", false],
      ["push", true],
    ]);
    expect(leg.mcpResults[0]?.text).toContain("api (api/): me/site-api");
    expect(leg.mcpResults[3]?.text).toContain("name one with repo");
    // Its gh check became one of Oraknid's own per repo.
    const t2 = (await api.jobs.get({ id })).tasks.find((t) => t.title === PUSH);
    expect(t2?.verify).toEqual([
      "oraknid github-repo --repo api",
      "oraknid github-repo --repo web",
    ]);
    const events = JSON.stringify(d.db.$client.prepare("select * from events").all());
    expect(events).not.toContain(TOKEN);

    // The built-in checks with --repo: each repo's link and branch, and a name that isn't one.
    const github = new GitHub(d.secrets, d.db, { api: gh.api, web: gh.web });
    const links = { api: repos[0]?.github ?? null, web: repos[1]?.github ?? null };
    const check = (command: string) =>
      runBuiltinCheck(command, {
        github,
        link: null,
        linkFor: (r) => (r ? (links[r as "api" | "web"] ?? `No repo ${r}.`) : "Name the repo."),
        localCommit: (b, r) => out(join(folder, r ?? "web"), "rev-parse", "--verify", "-q", b),
      });
    expect(await check(`oraknid github-branch ${branch} --repo web`)).toMatchObject({ ok: true });
    expect(await check(`oraknid github-branch ${branch} --repo=api`)).toMatchObject({ ok: true });
    expect(await check("oraknid github-repo --repo api")).toMatchObject({ ok: true });
    expect((await check("oraknid github-repo --repo nope"))?.output).toBe("No repo nope.");
    expect((await check("oraknid github-branch main --repo web"))?.ok).toBe(false);
    expect(parseBuiltinCheck("oraknid github-branch dev --repo web")).toEqual({
      kind: "branch",
      branch: "dev",
      repo: "web",
    });
  }, 90_000);
});

describe("tasks side by side across several repos (ADR-042, ADR-016)", () => {
  const WEB = "Write the page";
  const API = "Write the API entry";
  const BOTH = "Wire the page to the API";

  it("runs tasks of different repos together, each in its own folder of worktrees, and merges each repo", async () => {
    const folder = twoRepos();
    let bothTurns = 0;
    const { d, api, project, starts } = await harness(
      folder,
      (t) => {
        if (t.system.includes(`# Your task: ${WEB}`))
          return [
            { run: "sleep 1" },
            { write: "web/index.html", content: "<h1>site</h1>\n" },
            { say: "DONE" },
          ];
        if (t.system.includes(`# Your task: ${API}`))
          return [
            { run: "sleep 1" },
            { write: "api/server.js", content: "export const port = 8080;\n" },
            { say: "DONE" },
          ];
        if (t.system.includes(`# Your task: ${BOTH}`)) {
          bothTurns++;
          // The first time slow, so the page is merged first and its check then fails;
          // the redo adds what the check needs once the page is there.
          return bothTurns === 1
            ? [
                { run: "sleep 3" },
                { write: "web/wire.js", content: "fetch('/api');\n" },
                { write: "api/cors.js", content: "export const cors = true;\n" },
                { say: "DONE" },
              ]
            : [
                { write: "web/wire.js", content: "fetch('/api');\n" },
                { write: "web/wired.ok", content: "ok\n" },
                { write: "api/cors.js", content: "export const cors = true;\n" },
                { say: "DONE" },
              ];
        }
        return [{ say: "DONE" }];
      },
      () => ({
        summary: "The page and the API side by side, and the wiring across both.",
        tasks: [
          task("w", WEB, ["web/index.html"], ["test -f web/index.html"]),
          task("a", API, ["api/server.js"], ["test -f api/server.js"]),
          task(
            "b",
            BOTH,
            ["web/wire.js", "web/wired.ok", "api/cors.js"],
            // Passes alone; once the page is merged, it also needs wired.ok.
            [
              "test -f web/wire.js && test -f api/cors.js && { test ! -f web/index.html || test -f web/wired.ok; }",
            ],
          ),
        ],
        jobVerify: ["test -f web/index.html && test -f api/server.js && test -f web/wired.ok"],
      }),
    );
    await api.settings.setMaxTasksPerJob({ max: 3 });
    for (const leg of await api.legs.list()) await api.legs.update({ id: leg.id, maxSessions: 3 });
    const id = await newJob(api, project.id, "A page, an API, and the wiring");
    const done = await until(api, id, ["completed", "blocked", "paused", "waiting"], 60_000);
    expect(done.state, done.blockedReason ?? "").toBe("completed");

    // Side by side: the page's and the API's sessions overlapped, each in its own folder.
    const { sessions } = await import("../db/schema.ts");
    const { eq } = await import("drizzle-orm");
    const s = d.db.select().from(sessions).where(eq(sessions.jobId, id)).all();
    const of = (title: string) =>
      s.find((x) => x.taskId === done.tasks.find((t) => t.title === title)?.id);
    const w = of(WEB);
    const a = of(API);
    expect((w?.startedAt ?? 0) < (a?.endedAt ?? 0) && (a?.startedAt ?? 0) < (w?.endedAt ?? 0)).toBe(
      true,
    );
    const root = done.worktree as string;
    const cwds = starts.map((x) => x.cwd);
    expect(cwds.every((c) => c.startsWith(`${root}-t-`))).toBe(true);
    expect(new Set(cwds).size).toBeGreaterThanOrEqual(3);

    // Each repo's job branch has each task's work, merged one task at a time.
    const branch = done.branch as string;
    expect(out(join(folder, "web"), "show", `${branch}:index.html`)).toBe("<h1>site</h1>");
    expect(out(join(folder, "web"), "show", `${branch}:wired.ok`)).toBe("ok");
    expect(out(join(folder, "api"), "show", `${branch}:server.js`)).toBe(
      "export const port = 8080;",
    );
    expect(out(join(folder, "api"), "show", `${branch}:cors.js`)).toBe("export const cors = true;");
    // The wiring was taken back from both repos when its check failed once merged, and merged
    // once in each when redone: all or nothing.
    const issue = (await api.silk.list({ jobId: id })).find(
      (e) => e.title === `Not merged: ${BOTH}`,
    );
    expect(issue?.body).toContain("failed once merged");
    expect(bothTurns).toBeGreaterThanOrEqual(2);
    for (const r of ["web", "api"]) {
      const merges = out(join(folder, r), "log", "--merges", "--format=%s", `dev..${branch}`)
        .split("\n")
        .filter((m) => m === `merge: ${BOTH}`);
      expect(merges).toHaveLength(1);
    }
    // Every task's folder and branch is gone once merged.
    for (const r of ["web", "api"]) {
      expect(out(join(folder, r), "worktree", "list")).not.toMatch(/-t-/);
      expect(out(join(folder, r), "branch", "--list", "*--t-*")).toBe("");
    }
    expect(
      readdirSync(join(folder, ".oraknid", "worktrees")).filter((n) => n.includes("-t-")),
    ).toEqual([]);
  }, 120_000);
});

describe("several repos, small pieces", () => {
  it("finds repos two folders down, never inside each other or a submodule's", () => {
    const dir = twoRepos();
    repoAt(join(dir, "apps", "admin"), "admin");
    repoAt(join(dir, "web", "nested"), "nested");
    mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
    repoAt(join(dir, "node_modules", "x", "y"), "y");
    expect(findRepos(dir).map((r) => r.folder)).toEqual(["api", "apps/admin", "web"]);
  });

  it("reads which repos a scope names", () => {
    const repos = [{ folder: "web" }, { folder: "api" }, { folder: "apps/admin" }];
    const names = (scope: string[]) => reposOfScope(repos, scope).map((r) => r.folder);
    expect(names(["web/src/**"])).toEqual(["web"]);
    expect(names(["web/**", "api/x.ts"])).toEqual(["web", "api"]);
    expect(names(["**"])).toEqual(["web", "api", "apps/admin"]);
    expect(names(["apps/**"])).toEqual(["apps/admin"]);
    expect(names(["README.md"])).toEqual([]);
    expect(reposOfScope([{ folder: "" }, { folder: "api" }], ["src/**"])).toEqual([{ folder: "" }]);
  });

  it("moves a project's single GitHub link into its repo (migration 0031)", async () => {
    const data = mkdtempSync(join(tmpdir(), "oraknid-migrate-"));
    const file = join(data, "oraknid.db");
    // The database as it was before several repos: migrations up to 0030.
    const old = join(data, "drizzle");
    const src = join(import.meta.dirname, "..", "..", "drizzle");
    mkdirSync(join(old, "meta"), { recursive: true });
    const journal = JSON.parse(readFileSync(join(src, "meta", "_journal.json"), "utf8")) as {
      entries: { idx: number; tag: string }[];
    };
    const before = journal.entries.filter((e) => e.idx <= 30);
    for (const e of before) copyFileSync(join(src, `${e.tag}.sql`), join(old, `${e.tag}.sql`));
    writeFileSync(
      join(old, "meta", "_journal.json"),
      JSON.stringify({ ...journal, entries: before }),
    );
    const client = new Database(file);
    migrate(drizzle(client), { migrationsFolder: old });
    const link = {
      account: "me",
      owner: "me",
      name: "piano",
      visibility: "public",
      origin: "existing",
      ready: true,
      linkedAt: 1,
    };
    const insert = client.prepare(
      "insert into projects (id, name, workspace_path, is_git_repo, shadow, release_branch, work_branch, created_at, github) values (?, ?, ?, ?, ?, ?, ?, 0, ?)",
    );
    insert.run(
      "p1",
      "piano",
      "/home/me/oraknid-piano",
      1,
      0,
      "master",
      "dev",
      JSON.stringify(link),
    );
    insert.run("p2", "plain", "/home/me/notes", 1, 0, "main", "dev", null);
    insert.run("p3", "shadow", "/home/me/photos", 0, 1, "main", "dev", null);
    client.close();

    const db = await openDatabase({ file, backupsDir: join(data, "backups") });
    const rows = db.$client
      .prepare("select id, repos, server_roles from projects order by id")
      .all() as { id: string; repos: string; server_roles: string }[];
    closeDatabase(db);
    const repos = Object.fromEntries(rows.map((r) => [r.id, JSON.parse(r.repos)]));
    expect(repos.p1).toEqual([
      {
        name: "oraknid-piano",
        folder: "",
        releaseBranch: "master",
        workBranch: "dev",
        github: link,
      },
    ]);
    expect(repos.p2).toEqual([
      { name: "notes", folder: "", releaseBranch: "main", workBranch: "dev", github: null },
    ]);
    expect(repos.p3).toEqual([]);
    expect(rows.map((r) => r.server_roles)).toEqual(["{}", "{}", "{}"]);
  });
});

// ── Servers with roles, and choosing one (ADR-042) ──────────────────

const DEPLOY = "Deploy the site";

/** My servers, as rows: Oraknid reaches none of them in these tests. */
function addServers(d: Daemon, names: string[]) {
  return names.map((name, i) => {
    const id = ulid();
    d.db
      .insert(servers)
      .values({
        id,
        name,
        host: `${name}.example.com`,
        port: 22,
        user: "deploy",
        description: "",
        auth: "my-key",
        setup: "ready",
        createdAt: i,
      })
      .run();
    return id;
  });
}

async function deployHarness(goal: string, title = DEPLOY) {
  const folder = mkdtempSync(join(tmpdir(), "oraknid-deploy-"));
  repoAt(folder, "site");
  const h = await harness(
    folder,
    () => [{ say: "DONE" }],
    () => ({
      summary: "Deploy.",
      tasks: [task("t1", title, ["**"], ["true"])],
      jobVerify: [],
    }),
  );
  return { ...h, goal };
}

describe("choosing a server (ADR-042)", () => {
  it("knows the role or the name in my words", () => {
    const offer = (name: string, role: string, production = false, inProject = true) => ({
      server: { id: name, name } as never,
      role,
      production,
      inProject,
    });
    const list = [
      offer("vps-1", "staging"),
      offer("vps-2", "production", true),
      offer("box", "", false, false),
    ];
    expect(roleIn("deploy it to prod")).toBe("production");
    expect(roleIn("ship to staging please")).toBe("staging");
    expect(roleIn("deploy")).toBeNull();
    expect(namedServer(list, "deploy to production")?.offer.server.name).toBe("vps-2");
    expect(namedServer(list, "put it on vps-1")?.offer.server.name).toBe("vps-1");
    expect(namedServer(list, "put it on vps-20")).toBeNull();
    expect(namedServer(list, "try the box")?.offer.inProject).toBe(false);
    expect(namedServer(list, "deploy it")).toBeNull();
  });

  it("asks only to confirm the server I name, and saves it with its role", async () => {
    const { d, api, project, starts } = await deployHarness("Deploy the site to production");
    const [staging, prod] = addServers(d, ["vps-1", "vps-2"]) as [string, string];
    await api.projects.setServers({ id: project.id, serverIds: [staging, prod] });
    await api.projects.setServerRole({
      id: project.id,
      serverId: staging,
      role: { role: "staging", production: null },
    });
    await api.projects.setServerRole({
      id: project.id,
      serverId: prod,
      role: { role: "production", production: null },
    });
    const p = (await api.projects.list()).find((x) => x.id === project.id);
    expect(p?.serverRoles).toEqual({
      [staging]: { role: "staging", production: null },
      [prod]: { role: "production", production: null },
    });
    const id = await newJob(api, project.id, "Deploy the site to production");
    const asked = await eventually(async () =>
      (await api.projects.conversation({ id: project.id })).find((m) => m.questions?.length),
    );
    const qs = asked.questions as Question[];
    expect(qs).toHaveLength(1);
    expect(qs[0]).toMatchObject({
      id: "confirm",
      shape: "confirm",
      prompt: "Deploy to production, vps-2?",
      recommended: "yes",
    });
    await api.projects.answer({
      id: project.id,
      messageId: asked.id,
      answers: [{ questionId: "confirm", options: ["yes"], text: "" }],
    });
    expect((await until(api, id, ["completed", "blocked", "paused"])).state).toBe("completed");
    // One question, nothing else; the Leg was told which server is the job's.
    expect((await api.inbox.list({})).filter((i) => i.kind === "question")).toHaveLength(1);
    const pack = starts.find((s) => s.systemPrompt.includes(DEPLOY))?.systemPrompt ?? "";
    expect(pack).toContain("vps-2 — production (production: what runs there is live)");
    expect(pack).toContain("the server for this job's work");
  }, 60_000);

  it("asks with options when I name none, waits while I add one, and saves my choice with its role", async () => {
    const { d, api, project } = await deployHarness("Deploy the site");
    const [staging, live, other] = addServers(d, ["vps-1", "vps-2", "box"]) as [
      string,
      string,
      string,
    ];
    await api.projects.setServers({ id: project.id, serverIds: [staging, live] });
    await api.projects.setServerRole({
      id: project.id,
      serverId: live,
      role: { role: "live", production: true },
    });
    await api.projects.setServerRole({
      id: project.id,
      serverId: staging,
      role: { role: "staging", production: null },
    });
    const id = await newJob(api, project.id, "Deploy the site");
    const asked = await eventually(async () =>
      (await api.projects.conversation({ id: project.id })).find((m) => m.questions?.length),
    );
    const server = (asked.questions as Question[])[0];
    // The project's servers by role (production last), then my others, then Add a new server.
    expect(server?.options.map((o) => o.label)).toEqual([
      "vps-1 — staging",
      "vps-2 — live",
      "box",
      "Add a new server",
      "Go on without a server",
    ]);
    expect(server?.options[1]?.detail).toContain("production");
    expect(server?.recommended).toBe(staging);
    expect((asked.questions as Question[])[1]?.id).toBe("role");
    void other;
    // I want a new one: The Eye says where to add it and waits.
    await api.projects.answer({
      id: project.id,
      messageId: asked.id,
      answers: [{ questionId: "server", options: ["add"], text: "" }],
    });
    const waiting = await eventually(async () =>
      (await api.projects.conversation({ id: project.id })).find((m) =>
        m.text.includes("/servers?add=1"),
      ),
    );
    expect(waiting.questions?.[0]?.options.map((o) => o.label)).toEqual([
      "I've added it",
      "Go on without a server",
    ]);
    expect((await until(api, id, ["waiting"])).state).toBe("waiting");
    // Adding the server answers it: The Eye asks again, the new one recommended.
    const added = await api.servers.add({
      name: "vps-3",
      host: "vps-3.example.com",
      port: 22,
      user: "deploy",
      description: "",
      privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----",
    });
    const again = await eventually(async () =>
      (await api.projects.conversation({ id: project.id })).find(
        (m) => m.id !== asked.id && m.questions?.[0]?.id === "server",
      ),
    );
    expect(again.questions?.[0]?.recommended).toBe(added.id);
    await api.projects.answer({
      id: project.id,
      messageId: again.id,
      answers: [
        { questionId: "server", options: [added.id], text: "" },
        { questionId: "role", options: ["testing"], text: "" },
      ],
    });
    expect((await until(api, id, ["completed", "blocked", "paused"])).state).toBe("completed");
    const p = (await api.projects.list()).find((x) => x.id === project.id);
    expect(p?.serverIds).toContain(added.id);
    expect(p?.serverRoles[added.id]).toEqual({ role: "testing", production: null });
  }, 60_000);

  it("confirms production even when it is the project's only server, and uses a plain one without asking", async () => {
    const { d, api, project } = await deployHarness("Deploy the site");
    const [prod, test] = addServers(d, ["vps-2", "vps-t"]) as [string, string];
    await api.projects.setServerRole({
      id: project.id,
      serverId: prod,
      role: { role: "prod", production: null },
    });
    const id = await newJob(api, project.id, "Deploy the site");
    const asked = await eventually(async () =>
      (await api.projects.conversation({ id: project.id })).find((m) => m.questions?.length),
    );
    expect(asked.questions?.[0]).toMatchObject({
      shape: "confirm",
      prompt: "Deploy to prod, vps-2?",
    });
    await api.projects.answer({
      id: project.id,
      messageId: asked.id,
      answers: [{ questionId: "confirm", options: ["yes"], text: "" }],
    });
    expect((await until(api, id, ["completed", "blocked", "paused"])).state).toBe("completed");

    // A project whose only server is a test one: used, said, nothing asked.
    await api.projects.setServers({ id: project.id, serverIds: [test] });
    const before = (await api.inbox.list({})).length;
    const id2 = await newJob(api, project.id, "Deploy the site again");
    expect((await until(api, id2, ["completed", "blocked", "paused"])).state).toBe("completed");
    expect((await api.inbox.list({})).length).toBe(before);
    const talk = await api.projects.conversation({ id: project.id });
    expect(talk.some((m) => m.text.includes("I use **vps-t**, this project's only one"))).toBe(
      true,
    );
  }, 60_000);
});
