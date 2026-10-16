import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import type { Router } from "../api/router.ts";
import { type Daemon, startDaemon } from "../daemon.ts";
import { silkMirror } from "../db/schema.ts";
import { resolvePaths } from "../paths.ts";
import { fakeOs } from "../testing/fake-os.ts";
import { seedJob } from "../testing/fixtures.ts";
import { handoffFromLog } from "./handoff.ts";
import { DISCARD, IMPORT } from "./store.ts";
import { summarizeShortened } from "./summarize.ts";

let daemon: Daemon | undefined;
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
});

async function start() {
  const dir = mkdtempSync(join(tmpdir(), "oraknid-silk-"));
  const workspace = mkdtempSync(join(tmpdir(), "oraknid-ws-"));
  daemon = await startDaemon({
    paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
    port: 0,
    dbFile: ":memory:",
    os: fakeOs().os,
    adapters: {},
  });
  const api = createORPCClient<RouterClient<Router>>(
    new RPCLink({
      url: `${daemon.url}/api`,
      headers: { authorization: `Bearer ${daemon.cliToken}` },
    }),
  );
  const jobId = seedJob(daemon.db, "running", workspace);
  const mirror = join(workspace, ".oraknid", "silk");
  return { d: daemon, api, jobId, workspace, mirror };
}

describe("Silk", () => {
  it("writes the mirror into the workspace after every change", async () => {
    const { d, jobId, mirror } = await start();
    const e = d.silk.add({
      jobId,
      kind: "decision",
      title: "Use SQLite",
      body: "WAL.",
      authoredBy: "eye",
    });
    const text = readFileSync(join(mirror, "decisions.md"), "utf8");
    expect(text).toContain(`## Use SQLite\n<!-- silk:${e.id} by:eye -->`);
    expect(existsSync(join(mirror, "README.md"))).toBe(true);
    expect(d.bus.since(0, [`job:${jobId}`], 50).map((x) => x.type)).toContain("silk.added");
  });

  it("lets me supersede anything, but nothing supersedes my entries automatically", async () => {
    const { d, api, jobId } = await start();
    const mine = await api.silk.add({
      jobId,
      kind: "decision",
      title: "Use pnpm",
      body: "Not npm.",
    });
    expect(mine.authoredBy).toBe("owner");
    expect(() =>
      d.silk.add({
        jobId,
        kind: "decision",
        title: "Use npm",
        body: "",
        authoredBy: "eye",
        supersedes: mine.id,
      }),
    ).toThrow("Only I can supersede an entry I wrote.");
    const edited = await api.silk.edit({ id: mine.id, title: "Use pnpm 9", body: "Not npm." });
    expect((await api.silk.list({ jobId })).map((x) => x.id)).toEqual([edited.id]);
    expect(await api.silk.list({ jobId, includeSuperseded: true })).toHaveLength(2);
  });

  it("asks before importing my hand edits, and keeps them on disk until I answer", async () => {
    const { d, api, jobId, mirror } = await start();
    const e = d.silk.add({
      jobId,
      kind: "decision",
      title: "Use SQLite",
      body: "WAL.",
      authoredBy: "eye",
    });
    const file = join(mirror, "decisions.md");
    writeFileSync(file, readFileSync(file, "utf8").replace("WAL.", "WAL and synchronous=FULL."));
    appendFileSync(file, "\n## Backups\nNightly, 7 kept.\n");

    expect(await api.silk.importMirror({ jobId })).toEqual(["decisions.md"]);
    // Asked once only.
    expect(await api.silk.importMirror({ jobId })).toEqual([]);
    const [question] = await api.inbox.list({ state: "open" });
    expect(question?.title).toBe("Import my edits to Silk (decisions.md)?");
    expect(question?.detail).toContain("Changed: **Use SQLite**");
    expect(question?.detail).toContain("New: **Backups**");

    // Another change meanwhile does not overwrite my edited file.
    d.silk.add({ jobId, kind: "decision", title: "Later", body: "x", authoredBy: "eye" });
    expect(readFileSync(file, "utf8")).toContain("synchronous=FULL");

    await api.inbox.answer({ id: question?.id as string, answer: IMPORT });
    const live = await api.silk.list({ jobId });
    expect(live.find((x) => x.title === "Use SQLite")).toMatchObject({
      body: "WAL and synchronous=FULL.",
      supersedes: e.id,
      authoredBy: "owner",
    });
    expect(live.find((x) => x.title === "Backups")).toMatchObject({ authoredBy: "owner" });
    const after = readFileSync(file, "utf8");
    expect(after).toContain("by:owner");
    expect(after).toContain("## Later");
  });

  it("puts Oraknid's version back when I discard my edits", async () => {
    const { d, api, jobId, mirror } = await start();
    d.silk.add({
      jobId,
      kind: "issue",
      title: "Flaky test",
      body: "sync.spec.ts",
      authoredBy: "eye",
    });
    const file = join(mirror, "issues.md");
    writeFileSync(file, `${readFileSync(file, "utf8")}\n## Scribble\nnot meant\n`);
    await api.silk.importMirror({ jobId });
    const [question] = await api.inbox.list({ state: "open" });
    await api.inbox.answer({ id: question?.id as string, answer: DISCARD });
    expect(readFileSync(file, "utf8")).not.toContain("Scribble");
    expect((await api.silk.list({ jobId })).map((x) => x.title)).toEqual(["Flaky test"]);
  });
});

/**
 * The loop of 2026-10-16 (ADR-072): the mirror was committed on the job's
 * branch, a merge whose checks failed was taken back with `git reset
 * --hard`, git put the older mirror back, and its own entries were offered
 * to me as my edits, seven times.
 */
describe("Oraknid's own state is not my edit (ADR-072)", () => {
  const git = (cwd: string, ...a: string[]) => {
    const r = spawnSync(
      "git",
      ["-c", "user.email=o@o", "-c", "user.name=o", "-c", "core.fsmonitor=false", ...a],
      { cwd, encoding: "utf8" },
    );
    if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  /** The mirror as the version before ADR-072 wrote it: no end markers. */
  const asBefore = (mirror: string) => {
    for (const f of ["issues.md", "progress.md", "facts.md"]) {
      const p = join(mirror, f);
      writeFileSync(p, readFileSync(p, "utf8").replace(/<!-- \/silk:\w+ -->\n/g, ""));
    }
  };
  /** Entries like the job's: bodies that start with a heading of their own. */
  const entriesOfTheJob = (d: Daemon, jobId: string) => {
    const a = d.silk.add({
      jobId,
      kind: "issue",
      title: "Uncertain after a restart: Construct the main application routing and viewports",
      body: "## Uncertain after a restart\nThese actions started and their result was never seen: look whether they happened before doing them again.\n- Bash `pnpm build`",
      authoredBy: "eye",
    });
    d.silk.add({
      jobId,
      kind: "progress",
      title: "Routing",
      body: "Started.",
      authoredBy: "eye",
    });
    return a;
  };
  const openQuestions = async (api: Awaited<ReturnType<typeof start>>["api"]) =>
    (await api.inbox.list({ state: "open" })).filter((i) => i.title.startsWith("Import my edits"));

  it("asks nothing when git puts back a mirror Oraknid wrote, and writes Silk's again", async () => {
    const { d, api, jobId, workspace, mirror } = await start();
    git(workspace, "init", "-q", "-b", "main");
    entriesOfTheJob(d, jobId);
    // Committed, as the version before ADR-072 did ("feat: recover: The job's work").
    git(workspace, "add", "-A", "-f", ".");
    git(workspace, "commit", "-qm", "feat: recover: The job's work");
    const before = git(workspace, "rev-parse", "HEAD");
    // Silk moves on: the mirror is rewritten, the tree is "dirty" with Oraknid's own files.
    const progress = d.silk.current(jobId).find((e) => e.title === "Routing");
    d.silk.add({
      jobId,
      kind: "progress",
      title: "Routing",
      body: "Done.",
      authoredBy: "eye",
      supersedes: progress?.id ?? null,
    });
    d.silk.add({
      jobId,
      kind: "issue",
      title: "Reconciled after a restart: Construct the main application routing and viewports",
      body: "## Reconciled after a restart\nOraknid looked at what the last attempt left uncertain.\n- Bash `pnpm build`: it happened",
      authoredBy: "eye",
    });
    // The steward's merge is taken back.
    git(workspace, "reset", "-q", "--hard", before);
    expect(readFileSync(join(mirror, "progress.md"), "utf8")).toContain("Started.");
    expect(d.silk.checkMirror(jobId)).toEqual([]);
    expect(await openQuestions(api)).toEqual([]);
    // Written again as Silk has it.
    expect(readFileSync(join(mirror, "progress.md"), "utf8")).toContain("Done.");
    expect(readFileSync(join(mirror, "issues.md"), "utf8")).toContain("Reconciled after a restart");
  });

  it("asks nothing for a mirror written before ADR-072, its entries cut at their headings", async () => {
    const { d, api, jobId, workspace, mirror } = await start();
    git(workspace, "init", "-q", "-b", "main");
    entriesOfTheJob(d, jobId);
    asBefore(mirror);
    git(workspace, "add", "-A", "-f", ".");
    git(workspace, "commit", "-qm", "feat: recover: The job's work");
    const before = git(workspace, "rev-parse", "HEAD");
    d.silk.add({ jobId, kind: "fact", title: "Node 24", body: "Pinned.", authoredBy: "eye" });
    // No version of the old one was remembered: a job from before the migration.
    d.db.update(silkMirror).set({ written: [] }).run();
    git(workspace, "reset", "-q", "--hard", before);
    d.silk.refreshMirror(jobId);
    expect(await openQuestions(api)).toEqual([]);
    expect(readFileSync(join(mirror, "issues.md"), "utf8")).toContain("<!-- /silk:");
    expect(readFileSync(join(mirror, "facts.md"), "utf8")).toContain("Node 24");
  });

  it("still asks about a real edit of mine, once, and never again once answered", async () => {
    const { d, api, jobId, mirror } = await start();
    entriesOfTheJob(d, jobId);
    const file = join(mirror, "issues.md");
    const mine = `${readFileSync(file, "utf8")}\n## Flaky login test\nRetries hide it.\n`;
    writeFileSync(file, mine);
    expect(d.silk.checkMirror(jobId)).toEqual(["issues.md"]);
    expect(d.silk.checkMirror(jobId)).toEqual([]);
    const [q] = await openQuestions(api);
    expect(q?.detail).toContain("New: **Flaky login test**");
    expect(q?.detail).not.toContain("Uncertain after a restart");
    await api.inbox.answer({ id: q?.id as string, answer: DISCARD });
    expect(readFileSync(file, "utf8")).not.toContain("Flaky login test");
    // The same edits again (a reset put them back, a sync tool, an editor's undo): not asked again.
    writeFileSync(file, mine);
    expect(d.silk.checkMirror(jobId)).toEqual([]);
    expect(await openQuestions(api)).toEqual([]);
    expect(readFileSync(file, "utf8")).not.toContain("Flaky login test");
    // Other edits are asked about.
    writeFileSync(file, `${mine}\n## Another\nReal.\n`);
    expect(d.silk.checkMirror(jobId)).toEqual(["issues.md"]);
  });

  it("takes back, on start, a question whose edits were all Oraknid's own", async () => {
    const { d, api, jobId, mirror } = await start();
    entriesOfTheJob(d, jobId);
    asBefore(mirror);
    // The question the version before ADR-072 asked about that file.
    const itemId = d.inbox.open({
      kind: "question",
      jobId,
      raisedBy: "eye",
      title: "Import my edits to Silk (issues.md)?",
      detail:
        "- Changed: **Uncertain after a restart: Construct the main application routing and viewports**\n- New: **Uncertain after a restart**",
      options: [IMPORT, DISCARD],
      defaultOption: null,
    });
    d.db
      .update(silkMirror)
      .set({ pendingItemId: itemId, written: [] })
      .where(and(eq(silkMirror.jobId, jobId), eq(silkMirror.file, "issues.md")))
      .run();
    expect(d.silk.healMirror(jobId)).toEqual(["issues.md"]);
    expect(await openQuestions(api)).toEqual([]);
    expect(d.inbox.get(itemId)?.state).toBe("withdrawn");
    expect(readFileSync(join(mirror, "issues.md"), "utf8")).toContain("<!-- /silk:");
    // A real edit's question stays.
    const file = join(mirror, "issues.md");
    writeFileSync(file, `${readFileSync(file, "utf8")}\n## Mine\nA real one.\n`);
    expect(d.silk.checkMirror(jobId)).toEqual(["issues.md"]);
    expect(d.silk.healMirror(jobId)).toEqual([]);
    expect(await openQuestions(api)).toHaveLength(1);
  });
});

describe("handoff rebuilt from a session log", () => {
  it("names the changed files, the commands and the failed ones as traps", () => {
    const ws = mkdtempSync(join(tmpdir(), "oraknid-git-"));
    const git = (...a: string[]) => spawnSync("git", a, { cwd: ws });
    git("init", "-q");
    git(
      "-c",
      "user.email=o@o",
      "-c",
      "user.name=o",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "start",
    );
    writeFileSync(join(ws, "login.ts"), "export const x = 1;\n");
    git("add", "login.ts");
    const log = join(ws, "s.ndjson");
    const lines = [
      { type: "tool.called", id: "1", tool: "Bash", input: { command: "pnpm test auth" } },
      { type: "tool.result", id: "1", ok: false, output: "FAIL" },
      { type: "turn.ended", reason: "interrupted", text: "Redirect still failing.", error: null },
    ];
    writeFileSync(log, lines.map((l) => JSON.stringify(l)).join("\n"));
    const h = handoffFromLog({
      goal: "Add login",
      logFile: log,
      diffStat: spawnSync("git", ["diff", "--stat", "HEAD"], { cwd: ws, encoding: "utf8" }).stdout,
    });
    expect(h).toContain("login.ts");
    expect(h).toContain("- `pnpm test auth` (failed)");
    expect(h).toContain("Redirect still failing.");
    expect(h).toMatch(/## Traps\n\n- `pnpm test auth` failed/);
  });
});

describe("summaries of shortened entries (M1.9)", () => {
  it("replaces what a pack had to shorten with one entry per kind, never my entries", async () => {
    const { d, jobId, workspace } = await start();
    const add = (title: string, authoredBy: "eye" | "owner" = "eye") =>
      d.silk.add({ jobId, kind: "fact", title, body: `${title}.`, authoredBy }).id;
    const ids = [add("Node 24"), add("pnpm 10"), add("Tests use Vitest"), add("Mine", "owner")];
    const asked: string[][] = [];
    const brain = {
      summarize: async ({ entries }: { entries: { title: string }[] }) => {
        asked.push(entries.map((e) => e.title));
        return { title: "The toolchain", body: "Node 24, pnpm 10, Vitest." };
      },
    } as never;
    const [made] = await summarizeShortened({ silk: d.silk, brain }, jobId, workspace, ids);
    expect(asked).toEqual([["Node 24", "pnpm 10", "Tests use Vitest"]]);
    expect(made?.covers).toEqual(ids.slice(0, 3));
    expect(d.silk.current(jobId).map((e) => e.title)).toEqual(["Mine", "The toolchain"]);
    // Covered entries are no longer current: nothing is summarised twice.
    expect(await summarizeShortened({ silk: d.silk, brain }, jobId, workspace, ids)).toEqual([]);
    expect(() =>
      d.silk.add({
        jobId,
        kind: "fact",
        title: "x",
        body: "x",
        authoredBy: "eye",
        covers: [ids[3] as string],
      }),
    ).toThrow("Only I can supersede an entry I wrote.");
  });
});

describe("the mirror is in the Leg's reach (Audit 1 → S1-06)", () => {
  it("never follows a link a Leg planted there", async () => {
    const { d, jobId, mirror } = await start();
    d.silk.add({ jobId, kind: "decision", title: "A", body: "a", authoredBy: "eye" });
    const secret = join(mkdtempSync(join(tmpdir(), "oraknid-secret-")), "secret.txt");
    writeFileSync(secret, "do not read\n");
    rmSync(join(mirror, "decisions.md"));
    symlinkSync(secret, join(mirror, "decisions.md"));
    expect(d.silk.checkMirror(jobId)).toEqual([]);
    d.silk.add({ jobId, kind: "decision", title: "B", body: "b", authoredBy: "eye" });
    expect(readFileSync(secret, "utf8")).toBe("do not read\n");
  });
});
