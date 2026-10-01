import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { afterEach, describe, expect, it } from "vitest";
import type { Router } from "../api/router.ts";
import { type Daemon, startDaemon } from "../daemon.ts";
import { resolvePaths } from "../paths.ts";
import { fakeOs } from "../testing/fake-os.ts";
import { seedJob } from "../testing/fixtures.ts";
import { handoffFromLog } from "./handoff.ts";
import { DISCARD, IMPORT } from "./store.ts";

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
    const h = handoffFromLog({ goal: "Add login", logFile: log, cwd: ws, since: "HEAD" });
    expect(h).toContain("login.ts");
    expect(h).toContain("- `pnpm test auth` (failed)");
    expect(h).toContain("Redirect still failing.");
    expect(h).toMatch(/## Traps\n\n- `pnpm test auth` failed/);
  });
});
