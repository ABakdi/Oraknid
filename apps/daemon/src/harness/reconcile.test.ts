import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeDatabase, type Db, openDatabase } from "../db/open.ts";
import { EventBus } from "../events/bus.ts";
import { InboxStore } from "../inbox/store.ts";
import { SilkStore } from "../silk/store.ts";
import { seedJob } from "../testing/fixtures.ts";
import { singleTree } from "../workspace/tree.ts";
import { AttemptLog } from "./log.ts";
import { reconcile, unresolved } from "./reconcile.ts";

// Uncertain actions reconciled (ADR-056 §1): the tree looked at — did the
// file change, is the commit there — and what it can't show asked of the
// agent; Oraknid's own commit found after a crash, the task not run again.

const open: Db[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const db of open.splice(0)) closeDatabase(db);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sh = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};

/** A repo with one commit, its tree as a task's, a checkpoint `ref` before the attempt. */
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "oraknid-reconcile-"));
  dirs.push(dir);
  const cwd = join(dir, "repo");
  spawnSync("mkdir", ["-p", cwd]);
  sh(cwd, "init", "-q", "-b", "main");
  sh(cwd, "config", "user.email", "t@example.com");
  sh(cwd, "config", "user.name", "T");
  writeFileSync(join(cwd, "a.txt"), "a\n");
  writeFileSync(join(cwd, "b.txt"), "b\n");
  sh(cwd, "add", ".");
  sh(cwd, "commit", "-q", "-m", "start");
  const tree = singleTree({ cwd, base: [] }, dir);
  const ref = "refs/oraknid/j/t/1";
  await tree.checkpoint(ref, "before");
  const db = await openDatabase({ file: ":memory:" });
  open.push(db);
  const bus = new EventBus(db);
  const silk = new SilkStore(db, bus, new InboxStore(db, bus));
  const jobId = seedJob(db);
  const log = new AttemptLog(db);
  return { cwd, tree, ref, db, silk, jobId, log, ws: { cwd, tree, tmpDir: dir, trash: dir } };
}

describe("reconciling what a restart left uncertain (ADR-056 §1)", () => {
  it("a file's change from the tree, a commit from the branch, the rest asked of the agent", async () => {
    const s = await setup();
    const before = { jobId: s.jobId, taskId: "t", attemptId: "a1" };
    const uncertain = (actionId: string, tool: string, input: string) =>
      s.log.append(before, "ActionUncertain", { actionId, tool, input });
    uncertain("w1", "Write", join(s.cwd, "a.txt"));
    uncertain("w2", "Edit", "b.txt");
    uncertain("c1", "Bash", "git commit -am wip");
    uncertain("s1", "Bash", "ssh prod 'systemctl restart app'");
    uncertain("l1", "Bash", "npm run build");
    // What happened before the crash: a.txt written, a commit made; b.txt untouched.
    writeFileSync(join(s.cwd, "a.txt"), "changed\n");
    sh(s.cwd, "commit", "-q", "-am", "wip");
    const trail = s.log.at({ jobId: s.jobId, taskId: "t", attemptId: "a2" });
    const found = await reconcile(s.log, trail, {
      taskId: "t",
      before: "a1",
      ws: s.ws,
      since: s.ref,
      aliases: ["prod"],
    });
    expect(found.map((e) => [e.data.actionId, e.data.finding])).toEqual([
      ["w1", "happened"],
      ["w2", "not-happened"],
      ["c1", "happened"],
      ["s1", "ask-agent"],
      ["l1", "ask-agent"],
    ]);
    expect(found[3]?.data.detail).toMatch(/on prod/);
    expect(unresolved(s.log, "a2").map((e) => e.data.actionId)).toEqual(["s1", "l1"]);
    // Reconciled once: a later attempt doesn't look again.
    const later = s.log.at({ jobId: s.jobId, taskId: "t", attemptId: "a3" });
    expect(
      await reconcile(s.log, later, {
        taskId: "t",
        before: "a1",
        ws: s.ws,
        since: s.ref,
        aliases: [],
      }),
    ).toEqual([]);
  });
});
