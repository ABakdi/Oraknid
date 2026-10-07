import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Daemon, startDaemon } from "../daemon.ts";
import { resolvePaths } from "../paths.ts";
import { fakeOs } from "../testing/fake-os.ts";
import { seedJob } from "../testing/fixtures.ts";

let daemon: Daemon | undefined;
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
});

async function start() {
  const fake = fakeOs({ keychain: true });
  const dir = mkdtempSync(join(tmpdir(), "oraknid-notify-"));
  daemon = await startDaemon({
    paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
    port: 0,
    dbFile: ":memory:",
    os: fake.os,
    adapters: {},
    emailDelayMs: 80,
  });
  await daemon.notifications.configureEmail(
    {
      host: "smtp.example.com",
      port: 465,
      secure: true,
      user: "me",
      from: "o@example.com",
      to: "me@example.com",
    },
    "pw",
  );
  return { d: daemon, sent: fake.sent };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const approval = (d: Daemon, jobId: string, title = "Claude wants to run `git push`") =>
  d.inbox.open({
    kind: "approval",
    jobId,
    raisedBy: "eye",
    title,
    detail: "",
    options: ["Approve", "Deny"],
  });

describe("notification routing", () => {
  it("tells me about an approval at once, and by email only if it still waits after the delay", async () => {
    const { d, sent } = await start();
    const job = seedJob(d.db, "running");
    approval(d, job);
    await wait(20);
    expect(sent.map((s) => s.channel)).toEqual(["desktop"]);
    expect(sent[0]?.n).toMatchObject({
      title: "Approval needed",
      urgency: "critical",
      tag: "inbox-approval",
    });
    await wait(120);
    expect(sent.map((s) => s.channel)).toEqual(["desktop", "email"]);
  });

  it("sends no email for an approval I answered in time", async () => {
    const { d, sent } = await start();
    const job = seedJob(d.db, "running");
    const id = approval(d, job);
    await wait(20);
    d.inbox.answer(id, "Approve");
    await wait(120);
    expect(sent.map((s) => s.channel)).toEqual(["desktop"]);
  });

  it("groups waiting approvals into one notification", async () => {
    const { d, sent } = await start();
    const job = seedJob(d.db, "running");
    approval(d, job, "first");
    approval(d, job, "second");
    await wait(20);
    expect(sent.at(-1)?.n.body).toBe("2 approvals waiting. Latest: second");
  });

  it("emails at once when a job completes", async () => {
    const { d, sent } = await start();
    const job = seedJob(d.db, "verifying");
    d.jobs.transition(job, "completed");
    await wait(20);
    expect(sent.map((s) => [s.channel, s.n.title])).toEqual([
      ["desktop", "Done: t"],
      ["email", "Done: t"],
    ]);
  });

  it("holds everything in quiet hours except approvals for running jobs, and sends the rest after", async () => {
    const { d, sent } = await start();
    const h = new Date().getHours();
    const pad = (n: number) => String(n % 24).padStart(2, "0");
    d.notifications.update({ quietHours: { from: `${pad(h)}:00`, to: `${pad(h + 1)}:00` } });
    const running = seedJob(d.db, "running");
    const finishing = seedJob(d.db, "verifying");
    approval(d, running);
    d.jobs.transition(finishing, "completed");
    await wait(20);
    expect(sent.map((s) => s.n.title)).toEqual(["Approval needed"]);
  });

  it("tells me about a new version of Oraknid on the desktop, not by email (ADR-048)", async () => {
    const { d, sent } = await start();
    d.bus.publish({
      type: "update.available",
      topic: "overview",
      jobId: null,
      payload: { tag: "v0.2.0", name: "Oraknid v0.2.0", version: "0.2.0" },
    });
    await wait(20);
    expect(sent.map((s) => s.channel)).toEqual(["desktop"]);
    expect(sent[0]?.n).toMatchObject({
      title: "Update available: v0.2.0",
      body: "Oraknid v0.2.0. Update from Settings → About & updates.",
      tag: "update",
    });
    expect(sent[0]?.n.url).toMatch(/\/settings\/about$/);
  });

  it("tells me the computer is in danger, through quiet hours, but not that it is busy with my work (ADR-050)", async () => {
    const { d, sent } = await start();
    const h = new Date().getHours();
    const pad = (n: number) => String(n % 24).padStart(2, "0");
    d.notifications.update({ quietHours: { from: `${pad(h)}:00`, to: `${pad(h + 1)}:00` } });
    d.bus.publish({
      type: "machine.incident",
      topic: "overview",
      jobId: null,
      payload: {
        kind: "memory",
        level: "danger",
        message: "Memory is nearly full (96% used, 0.6 GB left), and the computer is swapping.",
        did: "Paused “Build the API” to free memory; it resumes when memory is back.",
      },
    });
    d.bus.publish({
      type: "machine.incident",
      topic: "overview",
      jobId: null,
      payload: { kind: "busy", level: "warning", message: "Busy with your own work.", did: null },
    });
    await wait(20);
    expect(sent.map((s) => s.channel)).toEqual(["desktop"]);
    expect(sent[0]?.n).toMatchObject({
      title: "Your computer is in danger",
      body: "Memory is nearly full (96% used, 0.6 GB left), and the computer is swapping. Paused “Build the API” to free memory; it resumes when memory is back.",
      urgency: "critical",
      tag: "machine-memory",
    });
  });

  it("tells me when a job paused for quota resumes by itself (Budgets-and-Quotas)", async () => {
    const { d, sent } = await start();
    const job = seedJob(d.db, "running");
    d.bus.publish({
      type: "job.auto-resumed",
      topic: `job:${job}`,
      jobId: job,
      payload: { reason: "Its agents have quota again; it goes on by itself." },
    });
    await wait(20);
    expect(sent.map((s) => s.channel)).toEqual(["desktop"]);
    expect(sent[0]?.n).toMatchObject({
      body: "Its agents have quota again; it goes on by itself.",
      urgency: "normal",
    });
    expect(sent[0]?.n.title).toMatch(/^Resumed: /);
  });

  it("tells me once that the computer can't be kept awake, again only after it was held (Durability)", async () => {
    const { d, sent } = await start();
    const failed = { held: false, mode: null, why: null, problem: "logind refused the lock." };
    const publish = (payload: unknown) =>
      d.bus.publish({ type: "system.inhibitor", topic: "overview", jobId: null, payload });
    publish(failed);
    publish(failed);
    await wait(20);
    expect(sent.map((s) => s.n.title)).toEqual(["Can't keep the computer awake"]);
    expect(sent[0]?.n.body).toBe(
      "logind refused the lock. The jobs go on, but the computer may sleep.",
    );
    publish({ held: true, mode: "block", why: "1 job running", problem: null });
    publish(failed);
    await wait(20);
    expect(sent).toHaveLength(2);
  });

  it("follows my changes to the routing table", async () => {
    const { d, sent } = await start();
    d.notifications.update({
      routes: { "job.completed": { desktop: false, push: false, email: "never" } },
    });
    const job = seedJob(d.db, "verifying");
    d.jobs.transition(job, "completed");
    await wait(20);
    expect(sent).toEqual([]);
  });
});
