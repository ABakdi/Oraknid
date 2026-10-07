import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import type { Router } from "../api/router.ts";
import { type Daemon, startDaemon } from "../daemon.ts";
import { jobs } from "../db/schema.ts";
import { runBuiltinCheck } from "../eye/builtin-checks.ts";
import { CI_ACTIONS } from "../helper/ci-actions.ts";
import type { HelperDeps } from "../helper/service.ts";
import { resolvePaths } from "../paths.ts";
import { type FakeGitHub, startFakeGitHub } from "../testing/fake-github.ts";
import { fakeOs } from "../testing/fake-os.ts";
import { seedJob } from "../testing/fixtures.ts";
import type { Ctx } from "../tui/actions.ts";
import { ciCommand } from "../tui/ci.ts";
import { plain } from "../tui/markdown.ts";
import type { Panel } from "../tui/panels.ts";
import { startCiWatch } from "./ci-watch.ts";
import { GitHub } from "./github.ts";
import { Ci, cutLog, dispatchInputs } from "./github-ci.ts";
import { githubCall, judgeGitHub } from "./github-tool.ts";

// GitHub Actions inside Oraknid (ADR-058), against the stand-in GitHub:
// never the real one, and no token ever printed.

let daemon: Daemon | undefined;
let gh: FakeGitHub | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  await gh?.close();
  gh = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const temp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};

async function harness() {
  gh = await startFakeGitHub();
  const dir = temp("oraknid-ci-");
  const fake = fakeOs({ keychain: true });
  daemon = await startDaemon({
    paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
    port: 0,
    dbFile: ":memory:",
    os: fake.os,
    adapters: {},
    github: { api: gh.api },
    // Watching from before the stand-in's runs, looked at only when a test says.
    ciWatch: { firstMs: 3_600_000, intervalMs: 3_600_000, now: () => Date.UTC(2026, 9, 1) },
  });
  const api = createORPCClient<RouterClient<Router>>(
    new RPCLink({
      url: `${daemon.url}/api`,
      headers: { authorization: `Bearer ${daemon.cliToken}` },
    }),
  );
  await api.github.addAccount({ token: "good-token" });
  const project = await api.projects.create({
    name: "Piano",
    workspacePath: temp("oraknid-ci-piano-"),
    initGit: true,
  });
  await api.projects.setGitHub({
    id: project.id,
    link: { account: "me", owner: "me", name: "piano", visibility: "public", origin: "existing" },
  });
  return { api, gh, d: daemon, projectId: project.id, sent: fake.sent };
}

const piano = { owner: "me", name: "piano" };

describe("GitHub Actions in Oraknid (ADR-058)", () => {
  it("lists runs by branch, a run's jobs and steps, the failing step named", async () => {
    const { api } = await harness();
    const all = await api.ci.runs(piano);
    expect(all.items.map((r) => r.id)).toEqual([102, 101]);
    expect(all.stale).toBe(false);
    const dev = await api.ci.runs({ ...piano, branch: "dev" });
    expect(dev.items).toHaveLength(1);
    expect(dev.items[0]).toMatchObject({
      id: 102,
      name: "CI",
      branch: "dev",
      status: "completed",
      conclusion: "failure",
      actor: "me",
      event: "push",
      attempt: 1,
      durationMs: 90_000,
    });
    const run = await api.ci.run({ ...piano, runId: 102 });
    expect(run.jobs.map((j) => [j.name, j.conclusion, j.failingStep])).toEqual([
      ["build", "success", null],
      ["test", "failure", "Run tests"],
    ]);
    expect(run.jobs[1]?.steps.map((s) => s.name)).toEqual([
      "Set up job",
      "Run actions/checkout@v4",
      "Install",
      "Run tests",
      "Complete job",
    ]);
  });

  it("fetches a log through the daemon, cut by step, the failing step first, searchable", async () => {
    const { api, gh } = await harness();
    const log = await api.ci.log({ ...piano, jobId: 1003 });
    expect(log.sections.map((s) => [s.name, s.failing])).toEqual([
      ["Run tests", true],
      ["Set up job", false],
      ["Run actions/checkout@v4", false],
      ["Install", false],
      ["Complete job", false],
    ]);
    const failing = log.sections[0];
    expect(failing?.lines[0]).toBe("##[group]Run pnpm test");
    // Colours are gone; the error is there.
    expect(failing?.lines).toContain("AssertionError: expected 100 to be 120");
    expect(failing?.lines.at(-1)).toBe("##[error]Process completed with exit code 1.");
    expect(log.sections[2]?.lines).toEqual([
      "##[group]Run actions/checkout@v4",
      "Syncing repository: me/piano",
      "##[endgroup]",
    ]);
    const found = await api.ci.log({ ...piano, jobId: 1003, q: "assertionerror" });
    expect(found.matchCount).toBe(1);
    expect(found.sections[0]?.matches).toHaveLength(1);
    // The signed address got no token; the log was asked once (a finished job's log is kept).
    expect(gh.ci.tokenOnBlob).toBe(false);
    expect(gh.hits.filter((h) => h.startsWith("GET /blobs/log-1003"))).toHaveLength(1);
  });

  it("lists artifacts and downloads one through a one-time link", async () => {
    const { api, gh, d } = await harness();
    const list = await api.ci.artifacts({ ...piano, runId: 102 });
    expect(list.map((a) => [a.name, a.expired])).toEqual([
      ["coverage", false],
      ["old-build", true],
    ]);
    const link = await api.ci.artifactLink({ ...piano, artifactId: 501 });
    const res = await fetch(`${d.url}${link.url}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("coverage.zip");
    expect(await res.text()).toBe("PK\u0003\u0004fake-zip-501");
    // Good once.
    expect((await fetch(`${d.url}${link.url}`)).status).toBe(404);
    expect(gh.ci.tokenOnBlob).toBe(false);
    const expired = await api.ci.artifactLink({ ...piano, artifactId: 502 });
    const gone = await fetch(`${d.url}${expired.url}`);
    expect(gone.status).toBe(400);
    expect(((await gone.json()) as { message: string }).message).toMatch(/expired/);
  });

  it("re-runs, cancels and runs a workflow by hand with its inputs, audited", async () => {
    const { api, gh, d } = await harness();
    const audited: string[] = [];
    d.bus.subscribe((e) => {
      if (e.type.startsWith("ci.")) audited.push(e.type);
    });
    await api.ci.rerun({ ...piano, runId: 102, failedOnly: true });
    expect(gh.ci.changes).toEqual(["rerun-failed-jobs 102"]);
    expect((await api.ci.run({ ...piano, runId: 102 })).attempt).toBe(2);
    await expect(api.ci.cancel({ ...piano, runId: 101 })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    const wfs = await api.ci.workflows(piano);
    expect(wfs.map((w) => [w.name, w.dispatch])).toEqual([
      ["CI", false],
      ["Deploy", true],
    ]);
    expect(wfs[1]?.inputs).toEqual([
      {
        name: "environment",
        description: "Where to",
        required: false,
        type: "choice",
        default: "staging",
        options: ["staging", "production"],
      },
      {
        name: "dry_run",
        description: "",
        required: false,
        type: "boolean",
        default: "true",
        options: [],
      },
      {
        name: "note",
        description: "Why",
        required: true,
        type: "string",
        default: null,
        options: [],
      },
    ]);
    await expect(
      api.ci.dispatch({ ...piano, workflowId: 12, ref: "main", inputs: {} }),
    ).rejects.toThrow("Deploy needs note to run.");
    await expect(
      api.ci.dispatch({ ...piano, workflowId: 11, ref: "main", inputs: {} }),
    ).rejects.toThrow(/can't be run by hand/);
    await expect(
      api.ci.dispatch({
        ...piano,
        workflowId: 12,
        ref: "main",
        inputs: { note: "x", color: "red" },
      }),
    ).rejects.toThrow("Deploy takes no input color.");
    await api.ci.dispatch({
      ...piano,
      workflowId: 12,
      ref: "main",
      inputs: { note: "ship it", environment: "staging" },
    });
    expect(gh.ci.changes.at(-1)).toBe(
      'dispatch 12 main {"note":"ship it","environment":"staging"}',
    );
    const pushed = gh.ci.push({ branch: "dev", sha: "f".repeat(40) });
    await api.ci.cancel({ ...piano, runId: pushed.id });
    expect(gh.ci.changes.at(-1)).toBe(`cancel ${pushed.id}`);
    expect(audited).toEqual(["ci.rerun", "ci.dispatched", "ci.cancelled"]);
  });

  it("says a branch's badge: passing, failing with its step, running, none", async () => {
    const { api, gh, d, projectId } = await harness();
    expect(await api.ci.badge({ ...piano, branch: "main" })).toMatchObject({
      state: "passing",
      failing: null,
    });
    expect(await api.ci.badge({ ...piano, branch: "dev" })).toMatchObject({
      state: "failing",
      failing: "test → Run tests",
    });
    expect((await api.ci.badge({ ...piano, branch: "nowhere" })).state).toBe("none");
    const project = await api.ci.project({ id: projectId });
    expect(project).toHaveLength(1);
    expect(project[0]).toMatchObject({
      repo: expect.any(String),
      fullName: "me/piano",
      releaseBranch: "main",
      workBranch: "dev",
      release: { state: "passing" },
      work: { state: "failing" },
    });
    // A new commit's run in progress: running (a fresh read, nothing kept).
    gh.ci.push({ branch: "main", sha: "a".repeat(40) });
    const fresh = new Ci(new GitHub(d.secrets, d.db, { api: gh.api }));
    expect((await fresh.badge({ ...piano, account: "me" }, "main")).state).toBe("running");
  });

  it("asks again with the ETag (free when unchanged), and backs off when GitHub says wait", async () => {
    const { d: db, gh } = await harness();
    const github = new GitHub(db.secrets, db.db, { api: gh.api });
    const ci = new Ci(github);
    const r = { ...piano, account: "me" };
    await ci.runs(r, { branch: "dev" });
    // A tiny time to keep: GitHub is asked again, with the ETag, and answers 304.
    await github.read("/repos/me/piano/actions/runs?per_page=20&page=1&branch=dev", "me", {
      ttl: 0,
    });
    const left = github.limits().find((l) => l.account === "me")?.remaining;
    await github.read("/repos/me/piano/actions/runs?per_page=20&page=1&branch=dev", "me", {
      ttl: 0,
    });
    expect(github.limits().find((l) => l.account === "me")?.remaining).toBe(left);
    // The allowance used up: once refused, nothing more is asked until it fills again.
    gh.setRemaining("me", 0);
    await expect(ci.runs(r, { branch: "main" })).rejects.toThrow(/allowance for me is used up/);
    const asked = gh.hits.length;
    const stale = await github.read<{ total_count: number }>(
      "/repos/me/piano/actions/runs?per_page=20&page=1&branch=dev",
      "me",
      { ttl: 0 },
    );
    expect(stale.stale).toBe(true);
    expect(stale.retryAt).toBeGreaterThan(Date.now());
    await expect(ci.rerun(r, 102, true)).rejects.toThrow(/allowance for me is used up/);
    expect(gh.hits.length).toBe(asked);
  });

  it("tells a failing run on the release or work branch once, through the routing table", async () => {
    const { d, gh, sent } = await harness();
    const events: Record<string, unknown>[] = [];
    d.bus.subscribe((e) => {
      if (e.type === "ci.failed") events.push(e.payload as Record<string, unknown>);
    });
    expect(await d.ciWatch?.tick()).toBe(1);
    expect(events[0]).toMatchObject({
      fullName: "me/piano",
      branch: "dev",
      runId: 102,
      failing: "test → Run tests",
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(sent.map((s) => [s.channel, s.n.title])).toEqual([
      ["desktop", "CI failed: Piano · dev"],
    ]);
    expect(sent[0]?.n.body).toBe("CI failed on me/piano: test → Run tests.");
    // Told once, a restart included (what was told is kept); a run re-run and failing again is told again.
    expect(await d.ciWatch?.tick()).toBe(0);
    const run = gh.ci.runs.find((x) => x.id === 102);
    if (run) run.attempt = 2;
    const again = startCiWatch({
      db: d.db,
      bus: d.bus,
      ci: new Ci(new GitHub(d.secrets, d.db, { api: gh.api })),
      projects: d.projects,
      firstMs: 3_600_000,
      intervalMs: 3_600_000,
    });
    expect(await again.tick()).toBe(1);
    expect(await again.tick()).toBe(0);
    again.stop();
    expect(events.map((e) => e.attempt)).toEqual([1, 2]);
  });

  it("holds the notification in quiet hours", async () => {
    const { d, sent } = await harness();
    const h = new Date().getHours();
    const pad = (n: number) => String(n % 24).padStart(2, "0");
    d.notifications.update({ quietHours: { from: `${pad(h)}:00`, to: `${pad(h + 1)}:00` } });
    await d.ciWatch?.tick();
    await new Promise((r) => setTimeout(r, 30));
    expect(sent).toEqual([]);
  });

  it("serves its OpenAPI document to paired devices only", async () => {
    const { d } = await harness();
    expect((await fetch(`${d.url}/api/openapi.json`)).status).toBe(401);
    const res = await fetch(`${d.url}/api/openapi.json`, {
      headers: { authorization: `Bearer ${d.cliToken}` },
    });
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      openapi: string;
      info: { title: string };
      paths: Record<string, unknown>;
    };
    expect(doc.openapi).toMatch(/^3\./);
    expect(doc.info.title).toBe("Oraknid");
    for (const p of ["/ci/runs", "/ci/rerun", "/github/repoList", "/jobs/create", "/system/status"])
      expect(Object.keys(doc.paths)).toContain(p);
  });
});

describe("the github tool's CI (ADR-058)", () => {
  it("reads freely and asks before a re-run", async () => {
    const { d, gh, projectId } = await harness();
    const github = new GitHub(d.secrets, d.db, { api: gh.api });
    const jobId = seedJob(d.db, "running");
    d.db.update(jobs).set({ projectId }).where(eq(jobs.id, jobId)).run();
    expect(judgeGitHub(d.db, jobId, "ci_runs", {})).toBeUndefined();
    expect(judgeGitHub(d.db, jobId, "ci_log", {})).toBeUndefined();
    expect(judgeGitHub(d.db, jobId, "ci_rerun", { run_id: 102 })).toBe("external-write");
    const deps = { db: d.db, bus: d.bus, github, projects: d.projects };
    expect(await githubCall(deps, jobId, "ci_runs", { branch: "dev" })).toMatch(
      /run 102: CI on dev at [0-9a-f]{7}, completed \(failure\), attempt 1/,
    );
    const log = await githubCall(deps, jobId, "ci_log", { branch: "dev" });
    expect(log).toMatch(/test failed at Run tests/);
    expect(log).toContain("untrusted DATA");
    expect(log).toContain("AssertionError: expected 100 to be 120");
    expect(await githubCall(deps, jobId, "ci_rerun", { run_id: 102 })).toBe(
      "Run 102 on me/piano runs again (its failed jobs).",
    );
    expect(gh.ci.changes).toEqual(["rerun-failed-jobs 102"]);
  });
});

describe("the helper's CI actions (ADR-058)", () => {
  it("lists runs and reads a failing log freely, and asks before a re-run", async () => {
    const { d, gh } = await harness();
    const github = new GitHub(d.secrets, d.db, { api: gh.api });
    const deps = { github, projects: d.projects, bus: d.bus } as unknown as HelperDeps;
    const list = await CI_ACTIONS.list_ci_runs?.run(deps, { project: "piano" } as never);
    expect(list?.result).toBe("2 runs of me/piano.");
    expect(list?.data).toMatch(/run 102: CI "A change on dev" on dev at [0-9a-f]{7} \(push\)/);
    const log = await CI_ACTIONS.ci_failing_log?.run(deps, { repo: "me/piano" } as never);
    expect(log?.result).toBe("CI run 102: test failed at Run tests.");
    expect(log?.data).toContain("AssertionError: expected 100 to be 120");
    const rerun = CI_ACTIONS.rerun_ci;
    expect(rerun?.kind).toBeUndefined();
    expect(rerun?.confirm(rerun.input.parse({ project: "piano", runId: 102 }) as never)).toBe(true);
    expect(CI_ACTIONS.list_ci_runs?.confirm({} as never)).toBe(false);
    await rerun?.run(deps, rerun.input.parse({ project: "piano", runId: 102 }) as never);
    expect(gh.ci.changes).toEqual(["rerun-failed-jobs 102"]);
  });
});

describe("/ci in the terminal app (ADR-058)", () => {
  it("lists the project's runs, and a run's jobs with the failing step's last lines", async () => {
    const { api, projectId } = await harness();
    const project = await api.projects.get({ id: projectId });
    const panels: Panel[] = [];
    const ctx = {
      api,
      push: (p: Panel) => panels.push(p),
      flash: (t: string) => panels.push({ key: "flash", title: t }),
      now: () => Date.UTC(2026, 9, 2, 13),
    } as unknown as Ctx;
    await ciCommand(ctx, () => project)();
    const list = panels[0];
    expect(list?.items?.map((i) => plain(i.label))).toEqual([
      expect.stringMatching(/^✗ failed {2}CI dev [0-9a-f]{7}$/),
      expect.stringMatching(/^✓ passed {2}CI main [0-9a-f]{7}$/),
    ]);
    await list?.onPick?.(0);
    const run = (panels[1]?.lines ?? []).map(plain);
    expect(run).toContain("    ✗ failed  Run tests");
    expect(run).toContain("The last lines of test → Run tests:");
    expect(run.at(-1)).toBe("##[error]Process completed with exit code 1.");
  });
});

describe("oraknid github-ci, The Eye's check (ADR-058)", () => {
  const link = {
    account: "me",
    owner: "me",
    name: "piano",
    visibility: "public" as const,
    origin: "existing" as const,
    ready: true,
    linkedAt: 1,
  };

  async function check(command: string, here: string | null = null) {
    const { d, gh } = await harness();
    const github = new GitHub(d.secrets, d.db, { api: gh.api });
    return {
      gh,
      run: () =>
        runBuiltinCheck(command, {
          github,
          link,
          localCommit: () => here,
          ci: new Ci(github),
          ciPollMs: 20,
        }),
    };
  }

  it("passes when the branch's runs passed", async () => {
    const { run } = await check("oraknid github-ci --branch main");
    const r = await run();
    expect(r).toMatchObject({ ok: true });
    expect(r?.output).toMatch(/^CI passed on main of me\/piano at [0-9a-f]{7}: CI\.$/);
  });

  it("fails with the failing step's last lines", async () => {
    const { run } = await check("oraknid github-ci dev");
    const r = await run();
    expect(r?.ok).toBe(false);
    expect(r?.output).toMatch(/^CI failed on dev of me\/piano at [0-9a-f]{7}: test → Run tests\./);
    expect(r?.output).toContain("The last lines of Run tests:");
    expect(r?.output).toContain("AssertionError: expected 100 to be 120");
    expect(r?.signature).toBe("builtin:ci:failing:me/piano:CI:test:Run tests");
  });

  it("waits for the commit here, and passes once its run does", async () => {
    const sha = "b".repeat(40);
    const { run, gh } = await check("oraknid github-ci --branch dev --timeout 1", sha);
    const pushed = gh.ci.push({ branch: "dev", sha });
    setTimeout(() => gh.ci.finish(pushed.id, "success"), 150);
    const r = await run();
    expect(r?.output).toBe(`CI passed on dev of me/piano at bbbbbbb: CI.`);
  });

  it("fails when it still runs at the timeout, or nothing ran", async () => {
    const sha = "c".repeat(40);
    const { run, gh } = await check("oraknid github-ci --branch dev --timeout=0.005", sha);
    gh.ci.push({ branch: "dev", sha });
    const r = await run();
    expect(r?.ok).toBe(false);
    expect(r?.output).toMatch(
      /^CI is still running on dev of me\/piano at ccccccc after 0.005 minutes: CI\.$/,
    );
  });

  it("fails when no run came for the commit here", async () => {
    const none = await check("oraknid github-ci --branch dev --timeout 0.002", "d".repeat(40));
    expect((await none.run())?.output).toMatch(
      /^No CI run for ddddddd on dev of me\/piano after 0.002 minutes: is it pushed/,
    );
  });

  it("fails at once on a repository with no workflows", async () => {
    const { run, gh } = await check("oraknid github-ci --branch main");
    gh.ci.noWorkflows();
    expect((await run())?.output).toBe(
      "me/piano has no GitHub Actions workflows: nothing runs on a push.",
    );
  });
});

describe("a job's log cut by step", () => {
  const step = (number: number, name: string, startedAt: string, conclusion = "success") => ({
    number,
    name,
    status: "completed" as const,
    conclusion: conclusion as "success",
    startedAt,
    completedAt: startedAt,
  });

  it("starts the next step at a group line when several began in the same second", () => {
    const log = cutLog(
      [
        "2026-10-02T12:00:00.1Z Runner",
        "2026-10-02T12:00:01.1Z ##[group]Run a",
        "2026-10-02T12:00:01.2Z a says",
        "2026-10-02T12:00:01.5Z ##[group]Run b",
        "2026-10-02T12:00:01.6Z b says",
        "2026-10-02T12:00:03.0Z ##[group]Run c",
        "2026-10-02T12:00:03.1Z c fails",
      ].join("\n"),
      {
        id: 1,
        name: "j",
        steps: [
          step(1, "Set up job", "2026-10-02T12:00:00Z"),
          step(2, "a", "2026-10-02T12:00:01Z"),
          step(3, "b", "2026-10-02T12:00:01Z"),
          step(4, "c", "2026-10-02T12:00:03Z", "failure"),
        ],
      },
    );
    expect(log.sections.map((s) => [s.name, s.lines])).toEqual([
      ["c", ["##[group]Run c", "c fails"]],
      ["Set up job", ["Runner"]],
      ["a", ["##[group]Run a", "a says"]],
      ["b", ["##[group]Run b", "b says"]],
    ]);
  });

  it("keeps the last lines of a long step, saying how many it left out", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `2026-10-02T12:00:00.1Z line ${i}`);
    const log = cutLog(
      lines.join("\n"),
      { id: 1, name: "j", steps: [step(1, "only", "2026-10-02T12:00:00Z")] },
      { lines: 10 },
    );
    expect(log.sections[0]).toMatchObject({ cut: 20 });
    expect(log.sections[0]?.lines[0]).toBe("line 20");
  });
});

describe("a workflow's inputs", () => {
  it("reads workflow_dispatch in its forms", () => {
    expect(dispatchInputs("on: push")).toBeNull();
    expect(dispatchInputs("on: workflow_dispatch")).toEqual([]);
    expect(dispatchInputs("on: [push, workflow_dispatch]")).toEqual([]);
    expect(dispatchInputs("on:\n  workflow_dispatch:\n")).toEqual([]);
    expect(
      dispatchInputs(
        "on:\n  workflow_dispatch:\n    inputs:\n      level:\n        type: number\n        default: 3\n",
      ),
    ).toEqual([
      {
        name: "level",
        description: "",
        required: false,
        type: "number",
        default: "3",
        options: [],
      },
    ]);
    expect(dispatchInputs("not: [valid")).toBeNull();
  });
});
