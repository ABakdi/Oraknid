import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { type Daemon, startDaemon } from "../daemon.ts";
import { jobs, projects } from "../db/schema.ts";
import { resolvePaths } from "../paths.ts";
import { fakeOs } from "../testing/fake-os.ts";
import { seedJob } from "../testing/fixtures.ts";

let daemon: Daemon | undefined;
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
});

async function start() {
  const dir = mkdtempSync(join(tmpdir(), "oraknid-inbox-"));
  daemon = await startDaemon({
    paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
    port: 0,
    dbFile: ":memory:",
    os: fakeOs().os,
    adapters: {},
  });
  return daemon;
}

function named(d: Daemon, jobId: string, project: string, job: string) {
  const row = d.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  d.db
    .update(projects)
    .set({ name: project })
    .where(eq(projects.id, row?.projectId as string))
    .run();
  d.db.update(jobs).set({ title: job }).where(eq(jobs.id, jobId)).run();
  return row?.projectId as string;
}

describe("the inbox across projects (Checkpoint 1 → F1-2)", () => {
  it("names each item's project and job, and filters and searches by them", async () => {
    const d = await start();
    const piano = seedJob(d.db, "running");
    const shop = seedJob(d.db, "running");
    const pianoProject = named(d, piano, "Piano", "A web piano");
    named(d, shop, "Shop", "Checkout page");
    const raise = (jobId: string, kind: "approval" | "question", title: string) =>
      d.inbox.open({
        jobId,
        kind,
        title,
        detail: "",
        options: ["Approve", "Deny"],
        raisedBy: "eye",
      });
    raise(piano, "approval", "Run `curl` to fetch the sound font?");
    raise(piano, "question", "Which octave first?");
    const pay = raise(shop, "approval", "Install stripe?");
    d.inbox.answer(pay, "Deny");

    const all = d.inbox.list();
    expect(all.map((i) => [i.projectName, i.jobTitle])).toContainEqual(["Shop", "Checkout page"]);
    expect(d.inbox.list({ projectId: pianoProject }).map((i) => i.title)).toEqual([
      "Run `curl` to fetch the sound font?",
      "Which octave first?",
    ]);
    expect(d.inbox.list({ jobId: shop }).map((i) => i.state)).toEqual(["answered"]);
    expect(d.inbox.list({ kind: "question" })).toHaveLength(1);
    expect(d.inbox.list({ state: "open", kind: "approval" })).toHaveLength(1);
    // Words may come from the project, the job or the item, in any order.
    expect(d.inbox.list({ q: "piano curl" }).map((i) => i.title)).toEqual([
      "Run `curl` to fetch the sound font?",
    ]);
    expect(d.inbox.list({ q: "checkout" })).toHaveLength(1);
    expect(d.inbox.list({ q: "nothing-like-this" })).toEqual([]);
  });

  it("takes only an approval's own options, records the device, and says when a question was withdrawn (Audit 1 → Q1-11)", async () => {
    const d = await start();
    const jobId = seedJob(d.db, "running");
    const ask = d.inbox.open({
      jobId,
      kind: "approval",
      title: "Run nmap?",
      detail: "",
      options: ["Approve", "Deny"],
      raisedBy: "eye",
    });
    expect(() => d.inbox.answer(ask, "sure")).toThrow("Answer with one of: Approve, Deny.");
    d.inbox.answer(ask, "Approve", "01J9Z3K8W2Q4V6X8Y0A1B2C3DV");
    expect(d.inbox.get(ask)?.answeredByDeviceId).toBe("01J9Z3K8W2Q4V6X8Y0A1B2C3DV");
    const gone = d.inbox.open({
      jobId,
      kind: "question",
      title: "Which?",
      detail: "",
      options: [],
      raisedBy: "eye",
    });
    d.inbox.withdraw(gone);
    expect(() => d.inbox.answer(gone, "this")).toThrow(/withdrawn/);
  });
});
