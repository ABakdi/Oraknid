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
