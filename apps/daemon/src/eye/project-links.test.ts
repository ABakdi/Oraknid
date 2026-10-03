import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobView, Question, WebPlan } from "@oraknid/contracts";
import { decide } from "@oraknid/core";
import type { SessionStart } from "@oraknid/leg-sdk";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import type { Router } from "../api/router.ts";
import { type Daemon, startDaemon } from "../daemon.ts";
import { settings } from "../db/schema.ts";
import { resolvePaths } from "../paths.ts";
import { fakeOs } from "../testing/fake-os.ts";
import { linkProject, seedJob } from "../testing/fixtures.ts";
import { type Action, scriptedLeg, type TurnContext } from "../testing/scripted-leg.ts";
import { judgeGitHub } from "../workspace/github-tool.ts";
import type { EyeBrain } from "./brain.ts";
import { linkFromAnswers, needsGitHub, needsServer } from "./links.ts";
import { policyFor } from "./policy.ts";

// ADR-038: a project's GitHub repo, chosen once in The Eye's conversation
// (ADR-037), used by Oraknid's own github tool. This reproduces the piano
// project's stalled task: "Create a GitHub repo for the piano project and
// push the dev branch", a public repo, the project linked to nothing.

let daemon: Daemon | undefined;
let stop: (() => void) | undefined;
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  stop?.();
  stop = undefined;
});

const TOKEN = "ghp-good-token-piano";
const WORK_TOKEN = "ghp-work-token-piano";

const git = (cwd: string, ...a: string[]) =>
  spawnSync("git", ["-c", "user.email=me@example.com", "-c", "user.name=Me", ...a], {
    cwd,
    encoding: "utf8",
  });

/** A stand-in for GitHub: its API, and bare repos under `web` that the clone URLs point to. */
async function fakeGitHub() {
  const web = mkdtempSync(join(tmpdir(), "oraknid-links-gh-"));
  const repos = new Map<string, { private: boolean }>([["me/old-site", { private: false }]]);
  mkdirSync(join(web, "me", "old-site.git"), { recursive: true });
  git(join(web, "me", "old-site.git"), "init", "-q", "--bare", "-b", "main");
  const calls: { method: string; url: string; body: unknown }[] = [];
  const users: Record<string, string> = {
    [`Bearer ${TOKEN}`]: "me",
    [`Bearer ${WORK_TOKEN}`]: "work",
  };
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      calls.push({ method: req.method ?? "", url: req.url ?? "", body });
      res.setHeader("content-type", "application/json");
      const login = users[req.headers.authorization ?? ""];
      if (!login) {
        res.statusCode = 401;
        return res.end('{"message":"Bad credentials"}');
      }
      if (req.url === "/user") return res.end(JSON.stringify({ login }));
      if (req.url?.startsWith("/user/repos") && req.method === "GET")
        return res.end(
          JSON.stringify(
            [...repos]
              .filter(([n]) => n.startsWith(`${login}/`))
              .map(([full, r]) => ({
                full_name: full,
                name: full.split("/")[1],
                private: r.private,
                description: null,
                pushed_at: "2026-10-03T00:00:00Z",
              })),
          ),
        );
      if (req.url === "/user/repos" && req.method === "POST") {
        const b = body as { name: string; private: boolean; auto_init: boolean };
        const full = `${login}/${b.name}`;
        if (repos.has(full)) {
          res.statusCode = 422;
          return res.end('{"message":"Repository creation failed."}');
        }
        repos.set(full, { private: b.private });
        const bare = join(web, `${full}.git`);
        mkdirSync(bare, { recursive: true });
        git(bare, "init", "-q", "--bare", "-b", "main");
        res.statusCode = 201;
        return res.end(
          JSON.stringify({ full_name: full, clone_url: `https://github.com/${full}.git` }),
        );
      }
      // A branch of a repo, as the built-in check reads it (ADR-038): its commit in the bare repo.
      const br = /^\/repos\/([^/]+\/[^/]+)\/branches\/(.+)$/.exec(req.url ?? "");
      if (br && repos.has(br[1] as string)) {
        const sha = git(
          join(web, `${br[1]}.git`),
          "rev-parse",
          "--verify",
          "-q",
          `refs/heads/${decodeURIComponent(br[2] as string)}`,
        ).stdout.trim();
        if (!sha) {
          res.statusCode = 404;
          return res.end('{"message":"Branch not found"}');
        }
        return res.end(JSON.stringify({ name: br[2], commit: { sha } }));
      }
      const repo = /^\/repos\/([^/]+\/[^/]+)(\/pulls)?$/.exec(req.url ?? "");
      if (repo && repos.has(repo[1] as string)) {
        const full = repo[1] as string;
        if (repo[2] && req.method === "POST") {
          res.statusCode = 201;
          return res.end(
            JSON.stringify({ number: 1, html_url: `https://github.com/${full}/pull/1` }),
          );
        }
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
  return {
    api: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    web,
    repos,
    calls,
    bare: (full: string) => join(web, `${full}.git`),
  };
}

/** The piano project's folder: master and dev, a commit on each. */
function pianoRepo() {
  const dir = mkdtempSync(join(tmpdir(), "oraknid-piano-"));
  git(dir, "init", "-q", "-b", "master");
  writeFileSync(join(dir, "index.html"), "<h1>piano</h1>\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "start");
  git(dir, "checkout", "-qb", "dev");
  writeFileSync(join(dir, "keys.js"), "export const keys = 88;\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "keys");
  git(dir, "checkout", "-q", "master");
  return dir;
}

const PUSH_TASK = "Create a GitHub repo for the piano project and push the dev branch";
const PLAN: WebPlan = {
  summary: "Put the piano on GitHub.",
  tasks: [
    {
      key: "t1",
      title: PUSH_TASK,
      instructions: "Create the repository on GitHub and push the dev branch to it.",
      kind: "implement",
      dependsOn: [],
      scope: ["**"],
      verify: ["true"],
      requiredCapabilities: ["implementation"],
      difficulty: "low",
    },
  ],
  jobVerify: [],
};

async function harness(
  script: (t: TurnContext) => Action[],
  o: { plan?: WebPlan; triage?: () => unknown } = {},
) {
  const gh = await fakeGitHub();
  const dir = mkdtempSync(join(tmpdir(), "oraknid-links-"));
  const leg = scriptedLeg(script);
  const starts: SessionStart[] = [];
  const start = leg.adapter.start.bind(leg.adapter);
  leg.adapter.start = (s) => {
    starts.push(s);
    return start(s);
  };
  const brain = {
    plan: async () => o.plan ?? PLAN,
    replan: async () => o.plan ?? PLAN,
    summarize: async () => ({ title: "s", body: "s" }),
    evaluate: async () => ({ accepted: true, reason: "ok", missing: [] }),
    repairCheck: async ({ command }: { command: string }) => ({
      broken: false,
      command,
      reason: "",
    }),
    triage: async () =>
      o.triage?.() ?? { intent: "question", reply: "Fine.", silk: null, tasks: [] },
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
    github: { api: gh.api, web: gh.web },
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
  const folder = pianoRepo();
  const project = await api.projects.create({ name: "oraknid-piano", workspacePath: folder });
  return { d: daemon, api, leg, gh, starts, folder, projectId: project.id };
}

type Api = Awaited<ReturnType<typeof harness>>["api"];

async function until(api: Api, id: string, states: string[], ms = 15_000): Promise<JobView> {
  const end = Date.now() + ms;
  for (;;) {
    const j = await api.jobs.get({ id });
    if (states.includes(j.state)) return j;
    if (Date.now() > end) throw new Error(`job stayed ${j.state} (${j.blockedReason ?? ""})`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function eventually<T>(fn: () => Promise<T | undefined | null | false>, ms = 10_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

const isPush = (t: TurnContext) => t.message.includes(PUSH_TASK) || t.system.includes(PUSH_TASK);

describe("a project's GitHub repo, chosen once (ADR-038)", () => {
  it("asks which repo for the piano's stalled push, saves my answer, and the github tool creates the repo and pushes", async () => {
    const { d, api, leg, gh, starts, folder, projectId } = await harness((t) =>
      isPush(t) && t.turn === 1
        ? [
            { mcp: { server: "oraknid-github", tool: "repo_info" } },
            { mcp: { server: "oraknid-github", tool: "create_repo" } },
            { mcp: { server: "oraknid-github", tool: "push", args: { branch: "dev" } } },
            // Anywhere else still asks (BR-5): I deny it below.
            {
              mcp: {
                server: "oraknid-github",
                tool: "push",
                args: { branch: "dev", repo: "someone/else" },
              },
            },
            { say: "DONE" },
          ]
        : [{ say: "DONE" }],
    );
    // My one token from before several accounts: named by its account, kept where it is.
    await d.secrets.set("github.token", TOKEN);
    expect(await api.github.accounts({ check: true })).toEqual([{ login: "me", error: null }]);
    const stored = d.db.select().from(settings).where(eq(settings.key, "github.accounts")).get();
    expect(stored?.value).toEqual([
      { login: "me", secret: "github.token", addedAt: expect.any(Number) },
    ]);

    // I ask for the work in the project's conversation; it has no GitHub link.
    const started = await api.projects.talk({
      id: projectId,
      text: "go ahead: put it on GitHub, a PUBLIC repo, and push the dev branch",
    });
    const jobId = started.jobId;
    expect((await api.projects.list()).find((p) => p.id === projectId)?.github).toBeNull();

    // The Eye asks with options in its conversation, and the job waits for my answer.
    const asked = await eventually(async () =>
      (await api.projects.conversation({ id: projectId })).find((m) => m.questions?.length),
    );
    expect(asked.text).toContain(`“${PUSH_TASK}” needs a GitHub repo`);
    expect(asked.text).toContain("I'll use **me**, your only GitHub account.");
    const qs = asked.questions as Question[];
    expect(qs.map((q) => q.id)).toEqual(["repo", "visibility"]);
    expect(qs[0]?.options.map((o) => o.label)).toEqual([
      "Create a new repo: me/oraknid-piano",
      "me/old-site",
    ]);
    expect(qs[0]).toMatchObject({ recommended: "new", allowOther: true });
    // I said public: that is what it recommends.
    expect(qs[1]).toMatchObject({ recommended: "public" });
    expect((await until(api, jobId, ["waiting"])).state).toBe("waiting");
    const item = (await api.inbox.list({ state: "open" })).find((i) => i.id === asked.itemId);
    expect(item?.questions?.map((q) => q.id)).toEqual(["repo", "visibility"]);

    // I answer there: a new repo; visibility left as recommended.
    await api.projects.answer({
      id: projectId,
      messageId: asked.id,
      answers: [{ questionId: "repo", options: ["new"], text: "" }],
    });

    // The Eye saves it to the project and goes on; the Leg's push elsewhere asks me.
    const approval = await eventually(
      async () => (await api.inbox.list({ state: "open", kind: "approval" }))[0],
    );
    expect(approval.title).toContain("mcp__github__push");
    expect(approval.detail).toContain("someone/else");
    await api.inbox.answer({ id: approval.id, answer: "Deny" });
    expect((await until(api, jobId, ["completed", "blocked"])).state).toBe("completed");

    const link = (await api.projects.list()).find((p) => p.id === projectId)?.github;
    expect(link).toMatchObject({
      account: "me",
      owner: "me",
      name: "oraknid-piano",
      visibility: "public",
      origin: "new",
      ready: true,
    });
    // Created public and empty, then dev pushed: the same commit as mine.
    expect(gh.repos.get("me/oraknid-piano")).toEqual({ private: false });
    expect(
      gh.calls.find((c) => c.method === "POST" && c.url === "/user/repos")?.body,
    ).toMatchObject({ name: "oraknid-piano", private: false, auto_init: false });
    const local = git(folder, "rev-parse", "dev").stdout.trim();
    expect(git(gh.bare("me/oraknid-piano"), "rev-parse", "dev").stdout.trim()).toBe(local);
    expect(leg.mcpResults.map((r) => [r.tool, r.isError])).toEqual([
      ["repo_info", false],
      ["create_repo", false],
      ["push", false],
      ["push", true],
    ]);
    expect(leg.mcpResults[0]?.text).toContain("doesn't exist yet");
    // Only one question for the link and one approval for the push elsewhere: nothing else asked.
    expect((await api.inbox.list({})).map((i) => i.kind).sort()).toEqual(["approval", "question"]);

    // My answer shows as a short list, then The Eye's word that it linked it.
    const talk = await api.projects.conversation({ id: projectId });
    const mine = talk.find((m) => m.replyTo === asked.id);
    expect(mine?.text).toBe(
      "- Which repository? Or type owner/name of one that exists, or a name for a new one. — Create a new repo: me/oraknid-piano\n- If it's a new repo, who can see it? — Public",
    );
    expect(mine?.answers).toEqual([
      { questionId: "repo", options: ["new"], text: "" },
      { questionId: "visibility", options: ["public"], text: "" },
    ]);
    expect(talk.some((m) => m.text.startsWith("Linked: **me/oraknid-piano** (public"))).toBe(true);

    // The Leg was told to use the tool, never gh or a token; the token reached no Leg.
    const pack = starts.find((s) => s.systemPrompt.includes(PUSH_TASK))?.systemPrompt ?? "";
    expect(pack).toContain("Do every GitHub action with the `github` tool");
    expect(pack).toContain("Never install or run the `gh` CLI");
    const seen = JSON.stringify(starts, (_k, v) => (typeof v === "function" ? undefined : v));
    expect(seen).not.toContain(TOKEN);
    expect(readFileSync(join(folder, ".git", "config"), "utf8")).not.toContain(TOKEN);
    const everything = JSON.stringify(d.db.$client.prepare("select * from events").all());
    expect(everything).not.toContain(TOKEN);
    expect(everything).toContain("github.pushed");
  }, 60_000);

  it("asks for the account too when there are several, and takes a repo I type", async () => {
    const { d, api, projectId, gh } = await harness(() => [{ say: "DONE" }]);
    await api.github.addAccount({ token: TOKEN });
    await api.github.addAccount({ token: WORK_TOKEN });
    expect((await api.github.accounts({})).map((a) => a.login)).toEqual(["me", "work"]);
    // Kept under their accounts' names, never in Oraknid's database.
    expect(await d.secrets.get("github.token.work")).toBe(WORK_TOKEN);
    expect(JSON.stringify(d.db.$client.prepare("select * from settings").all())).not.toContain(
      WORK_TOKEN,
    );
    const { jobId } = await api.projects.talk({ id: projectId, text: "push it" });
    const asked = await eventually(async () =>
      (await api.projects.conversation({ id: projectId })).find((m) => m.questions?.length),
    );
    expect(asked.questions?.map((q) => q.id)).toEqual(["account", "repo", "visibility"]);
    expect(asked.questions?.[0]).toMatchObject({ recommended: "me", allowOther: false });
    expect(asked.questions?.[2]).toMatchObject({ recommended: "private" });
    // Answered from the inbox this time: it shows in the conversation all the same.
    await api.inbox.answer({
      id: asked.itemId as string,
      answers: [
        { questionId: "account", options: ["work"], text: "" },
        { questionId: "repo", options: [], text: "me/old-site" },
      ],
    });
    await until(api, jobId, ["completed", "blocked"]);
    expect((await api.projects.list()).find((p) => p.id === projectId)?.github).toMatchObject({
      account: "work",
      owner: "me",
      name: "old-site",
      origin: "existing",
      ready: true,
    });
    const talk = await api.projects.conversation({ id: projectId });
    expect(talk.find((m) => m.replyTo === asked.id)?.text).toContain(
      "a name for a new one. — me/old-site",
    );
    // Nothing was created.
    expect(gh.calls.some((c) => c.method === "POST")).toBe(false);
    // Changed in the project's Settings: saved again as it is, it stays ready.
    await api.projects.setGitHub({
      id: projectId,
      link: { account: "me", owner: "me", name: "old-site", visibility: "public", origin: "new" },
    });
    expect((await api.projects.list()).find((p) => p.id === projectId)?.github?.ready).toBe(true);
    // An account Oraknid doesn't have is refused.
    await api.projects.setGitHub({ id: projectId, link: null });
    expect((await api.projects.list()).find((p) => p.id === projectId)?.github).toBeNull();
    await expect(
      api.projects.setGitHub({
        id: projectId,
        link: { account: "nobody", owner: "me", name: "x", visibility: "private", origin: "new" },
      }),
    ).rejects.toThrow(/No GitHub account nobody/);
    await api.github.removeAccount({ login: "work" });
    expect(await d.secrets.get("github.token.work")).toBeUndefined();
  }, 60_000);
});

// After the piano job (2026-10-03): merging into the work branch and pushing
// are Oraknid's own steps when the job ends, never tasks for a Leg.
describe("the repo's part is Oraknid's", () => {
  it("merges the job into dev and pushes dev at the end, as I asked, and says so", async () => {
    const plan: WebPlan = {
      summary: "A metronome, then on GitHub.",
      tasks: [
        {
          key: "t1",
          title: "Add a metronome",
          instructions: "Write metronome.txt.",
          kind: "implement",
          dependsOn: [],
          scope: ["metronome.txt"],
          verify: ["test -f metronome.txt"],
          requiredCapabilities: ["implementation"],
          difficulty: "low",
        },
      ],
      // Oraknid's own check: run after the push, on the project's real dev.
      jobVerify: ["oraknid github-branch dev"],
      ending: { merge: true, push: true },
    };
    const { d, api, leg, gh, folder, projectId } = await harness(
      () => [{ write: "metronome.txt", content: "tick\n" }, { say: "DONE" }],
      {
        plan,
        triage: () => ({
          intent: "task",
          reply: "Oraknid pushes it.",
          silk: null,
          tasks: [],
          ending: { push: true },
        }),
      },
    );
    await d.secrets.set("github.token", TOKEN);
    await api.github.accounts({ check: true });
    const started = await api.projects.talk({
      id: projectId,
      text: "Add a metronome, commit it into dev and push dev to GitHub, a public repo",
    });
    // The link is asked once, at the end: no task is about GitHub.
    const asked = await eventually(async () =>
      (await api.projects.conversation({ id: projectId })).find(
        (m) => m.questions?.length && m.itemId,
      ),
    );
    expect(asked.text).toContain("“Push the job's work to GitHub” needs a GitHub repo");
    expect((await api.jobs.get({ id: started.jobId })).tasks.map((t) => t.title)).toEqual([
      "Add a metronome",
    ]);
    await api.projects.answer({
      id: projectId,
      messageId: asked.id,
      answers: [{ questionId: "repo", options: ["new"], text: "" }],
    });
    const job = await until(api, started.jobId, ["completed", "blocked"]);
    expect(job.state, job.blockedReason ?? "").toBe("completed");
    // dev has the job's work, merged by Oraknid; GitHub's dev is the same commit.
    expect(git(folder, "log", "--format=%s", "dev").stdout).toContain("feat: add a metronome");
    const local = git(folder, "rev-parse", "dev").stdout.trim();
    expect(git(gh.bare("me/oraknid-piano"), "rev-parse", "dev").stdout.trim()).toBe(local);
    // The Leg never did any of it.
    expect(leg.mcpResults).toEqual([]);
    // The summary says where it is, and leaves me nothing to merge.
    const talk = await api.projects.conversation({ id: projectId });
    const summary = talk.find((m) => m.action?.report?.kind === "job-done")?.action?.report;
    expect(summary?.facts).toContainEqual({ label: "Merged into", value: "dev", href: null });
    expect(summary?.facts).toContainEqual({
      label: "Pushed",
      value: "dev → me/oraknid-piano",
      href: "https://github.com/me/oraknid-piano/tree/dev",
    });
    expect(summary?.todo.filter((x) => /Merge|github-branch/.test(x))).toEqual([]);
    expect(
      d.bus.since(0, [`job:${started.jobId}`], 2000).find((e) => e.type === "job.merged")?.actor,
    ).toBe("eye");

    // Asked again once the job has ended: done at once, said in the reply.
    await api.projects.talk({ id: projectId, text: "push it to GitHub again" });
    const reply = await eventually(async () =>
      (await api.projects.conversation({ id: projectId })).find((m) =>
        m.action?.did.includes("Pushed dev to me/oraknid-piano"),
      ),
    );
    expect(reply.text).toBe(
      "I pushed **dev** to [me/oraknid-piano](https://github.com/me/oraknid-piano/tree/dev).",
    );
  }, 60_000);
});

describe("the github tool's policy (ADR-038)", () => {
  it("lets the linked repo's work through and asks for the rest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oraknid-links-policy-"));
    daemon = await startDaemon({
      paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
      port: 0,
      dbFile: ":memory:",
      os: fakeOs({ keychain: true }).os,
      adapters: {},
    });
    const db = daemon.db;
    const jobId = seedJob(db, "running");
    const verdict = (name: string, args: Record<string, unknown> = {}) => {
      const judged = judgeGitHub(db, jobId, name, args);
      const policy = policyFor(db, jobId, "/w");
      policy.mcp = new Map(judged ? [[`mcp__github__${name}`, judged]] : []);
      return decide({ tool: `mcp__github__${name}`, command: null, path: null }, policy);
    };
    // No link yet: a push goes nowhere I chose, so it asks.
    expect(verdict("push", { branch: "dev" })).toMatchObject({ verdict: "ask", gated: "push" });
    const projectId = (await daemon.jobs.get(jobId))?.projectId as string;
    linkProject(db, projectId, {
      account: "me",
      owner: "me",
      name: "piano",
      visibility: "public",
      origin: "new",
      ready: false,
      linkedAt: 0,
    });
    expect(verdict("create_repo").verdict).toBe("allow");
    expect(verdict("push", { branch: "dev" }).verdict).toBe("allow");
    expect(verdict("push", { branch: "dev", repo: "ME/Piano" }).verdict).toBe("allow");
    expect(verdict("open_pull_request", { head: "dev", title: "x" }).verdict).toBe("allow");
    expect(verdict("push", { branch: "dev", force: true })).toMatchObject({ gated: "push" });
    expect(verdict("push", { branch: "dev", repo: "me/other" })).toMatchObject({ gated: "push" });
    expect(verdict("open_pull_request", { repo: "me/other" })).toMatchObject({
      gated: "external-write",
    });
    expect(verdict("delete_repo")).toMatchObject({ verdict: "ask", gated: "external-write" });
    linkProject(db, projectId, {
      account: "me",
      owner: "me",
      name: "piano",
      visibility: "public",
      origin: "new",
      ready: true,
      linkedAt: 0,
    });
    // Created already: creating another asks.
    expect(verdict("create_repo")).toMatchObject({ verdict: "ask" });
  });

  it("knows a task that needs GitHub or a server, and reads my answers into a link", () => {
    expect(needsGitHub({ title: PUSH_TASK, instructions: "" })).toBe(true);
    expect(needsGitHub({ title: "Open a pull request", instructions: "" })).toBe(true);
    expect(needsGitHub({ title: "Add a metronome", instructions: "Write metronome.js" })).toBe(
      false,
    );
    expect(needsServer({ title: "Deploy the site to the VPS", instructions: "" })).toBe(true);
    expect(needsServer({ title: "Start the dev server", instructions: "npm run dev" })).toBe(false);
    const questions: Question[] = [
      {
        id: "repo",
        shape: "single",
        prompt: "Which?",
        options: [
          { id: "new", label: "Create a new repo: me/piano" },
          { id: "e1", label: "me/old-site" },
        ],
        recommended: "new",
        allowOther: true,
      },
      {
        id: "visibility",
        shape: "single",
        prompt: "Who?",
        options: [
          { id: "private", label: "Private" },
          { id: "public", label: "Public" },
        ],
        recommended: "private",
        allowOther: false,
      },
    ];
    expect(
      linkFromAnswers(
        questions,
        [{ questionId: "repo", options: ["e1"], text: "" }],
        "",
        ["me"],
        "piano",
      ),
    ).toEqual({
      account: "me",
      owner: "me",
      name: "old-site",
      visibility: "private",
      origin: "existing",
    });
    expect(
      linkFromAnswers(
        questions,
        [{ questionId: "repo", options: [], text: "grand piano!" }],
        "",
        ["me"],
        "piano",
      ),
    ).toMatch(/isn't a repository name/);
    // In words only (an old client): an owner/name and "public" are read from them.
    expect(linkFromAnswers(questions, null, "use me/keys, public please", ["me"], "piano")).toEqual(
      { account: "me", owner: "me", name: "keys", visibility: "public", origin: "existing" },
    );
  });
});
