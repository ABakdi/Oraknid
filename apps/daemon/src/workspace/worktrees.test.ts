import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { closeDatabase, type Db, openDatabase } from "../db/open.ts";
import { events, jobs } from "../db/schema.ts";
import { EventBus } from "../events/bus.ts";
import { seedJob } from "../testing/fixtures.ts";
import { createWorktree } from "./git.ts";
import { cleanFinishedWorktrees, jobWorktrees, removeJobWorktree } from "./worktrees.ts";

// A job's worktree removed when I ask (Sandboxing → Worktrees, ADR-006).

const sh = (cwd: string, ...a: string[]) =>
  spawnSync("git", a, { cwd, encoding: "utf8" }).stdout.trim();

const dirs: string[] = [];
const dbs: Db[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) closeDatabase(db);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function setup() {
  const repo = mkdtempSync(join(tmpdir(), "oraknid-wt-"));
  dirs.push(repo);
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "config", "user.email", "me@example.com");
  sh(repo, "config", "user.name", "Me");
  writeFileSync(join(repo, "a.txt"), "one\n");
  sh(repo, "add", ".");
  sh(repo, "commit", "-qm", "start");
  const db = await openDatabase({ file: ":memory:" });
  dbs.push(db);
  const bus = new EventBus(db);
  // One project, this repo; its jobs made from the first one's row.
  const first = seedJob(db, "completed");
  const base = db.select().from(jobs).where(eq(jobs.id, first)).get();
  if (!base) throw new Error("no job");
  db.$client
    .prepare(
      "update projects set workspace_path = ?, release_branch = 'main', work_branch = 'main' where id = ?",
    )
    .run(repo, base.projectId);
  let n = 0;
  /** A finished job with its worktree; `work` commits on its branch, `dirty` leaves a file. */
  const job = (o: { state?: string; work?: boolean; dirty?: boolean } = {}) => {
    const id = n++ === 0 ? first : `${first.slice(0, -2)}${String(n).padStart(2, "0")}`;
    if (id !== first)
      db.insert(jobs)
        .values({ ...base, id })
        .run();
    db.update(jobs)
      .set({ state: o.state ?? "completed" })
      .where(eq(jobs.id, id))
      .run();
    const wt = createWorktree(repo, id, "x", { release: "main", work: "main" });
    db.update(jobs).set({ worktree: wt.path, branch: wt.branch }).where(eq(jobs.id, id)).run();
    if (o.work) {
      writeFileSync(join(wt.path, "b.txt"), "two\n");
      sh(wt.path, "add", ".");
      sh(wt.path, "commit", "-qm", "work");
    }
    if (o.dirty) writeFileSync(join(wt.path, "c.txt"), "three\n");
    return { id, ...wt };
  };
  return { db, bus, repo, job };
}

describe("a finished job's worktree", () => {
  it("is listed with its size and what removing it loses", async () => {
    const s = await setup();
    const j = s.job({ work: true, dirty: true });
    const [w] = jobWorktrees(s.db);
    expect(w).toMatchObject({ jobId: j.id, branch: j.branch, unmerged: 1, uncommitted: 1 });
    expect(w?.bytes).toBeGreaterThan(0);
  });

  it("is not removed with unmerged or uncommitted work unless I confirm; the branch stays", async () => {
    const s = await setup();
    const j = s.job({ work: true });
    expect(() => removeJobWorktree(s.db, s.bus, j.id, false)).toThrow(
      /has 1 commit not merged into main \(the branch oraknid\/x-\w+ stays\): confirm to remove its worktree anyway\./,
    );
    expect(existsSync(j.path)).toBe(true);
    removeJobWorktree(s.db, s.bus, j.id, true);
    expect(existsSync(j.path)).toBe(false);
    expect(sh(s.repo, "branch", "--list", j.branch)).toContain(j.branch);
    expect(sh(s.repo, "worktree", "list")).not.toContain(j.path);
    const e = s.db.select().from(events).where(eq(events.type, "job.worktree-removed")).all();
    expect(e).toHaveLength(1);
    expect(e[0]?.actor).toBe("owner");
  });

  it("is never removed while its job can still go on", async () => {
    const s = await setup();
    const j = s.job({ state: "paused" });
    expect(() => removeJobWorktree(s.db, s.bus, j.id, true)).toThrow(/hasn't ended/);
    expect(existsSync(j.path)).toBe(true);
    expect(jobWorktrees(s.db)).toEqual([]);
  });

  it("cleaning up removes the finished ones with nothing to lose, and names the others", async () => {
    const s = await setup();
    const clean = s.job();
    const dirty = s.job({ dirty: true });
    const r = cleanFinishedWorktrees(s.db, s.bus);
    expect(r.removed).toBe(1);
    expect(r.kept.map((k) => k.jobId)).toEqual([dirty.id]);
    expect(existsSync(clean.path)).toBe(false);
    expect(existsSync(dirty.path)).toBe(true);
  });
});
