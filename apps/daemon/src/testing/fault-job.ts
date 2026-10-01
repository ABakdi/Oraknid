// Child process for the fault-injection suite (engine/faults.test.ts).
// Runs a scripted job against a database file in `dir`, recovering first
// like the daemon does at start. ORAKNID_FAULT makes it SIGKILL itself at
// one boundary.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../db/open.ts";
import { SideEffects } from "../engine/effects.ts";
import { JobStore } from "../engine/jobs.ts";
import { StepJournal } from "../engine/journal.ts";
import { recover } from "../engine/recovery.ts";
import { JobRunner } from "../engine/runner.ts";
import { EventBus } from "../events/bus.ts";
import { InboxStore } from "../inbox/store.ts";
import { seedJob } from "./fixtures.ts";

const dir = process.argv[2] as string;
const db = await openDatabase({ file: join(dir, "o.db"), backupsDir: join(dir, "backups") });
const bus = new EventBus(db);
const jobs = new JobStore(db, bus);
const journal = new StepJournal(db);
const inbox = new InboxStore(db, bus);
const effects = new SideEffects(db, bus, inbox);

const workLog = join(dir, "work.log");
const sentLog = join(dir, "sent.log");
const apiStore = join(dir, "api.json");
const lines = (f: string) =>
  existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : [];
const api = (): Record<string, number> =>
  existsSync(apiStore) ? JSON.parse(readFileSync(apiStore, "utf8")) : {};

// An API that honours idempotency keys, and a mailbox that does not but can be checked.
effects.reconciler("api.call", async (e) =>
  e.idempotencyKey in api() ? "happened" : "did-not-happen",
);
effects.reconciler("mail.send", async (e) =>
  lines(sentLog).includes(e.idempotencyKey) ? "happened" : "did-not-happen",
);

const runner = new JobRunner({
  jobs,
  journal,
  effects,
  inbox,
  bus,
  program: async (ctx) => {
    if (ctx.state() === "draft") ctx.setState("planning");
    for (const i of [1, 2, 3, 4]) {
      await ctx.step(`s${i}`, { i }, async () => {
        appendFileSync(workLog, `s${i}\n`);
        return i * 10;
      });
    }
    await ctx.effect({ key: "api", action: "api.call", payload: {} }, async (key) => {
      const store = api();
      if (!(key in store)) {
        store[key] = 1;
        writeFileSync(apiStore, JSON.stringify(store));
      }
      return "ok";
    });
    await ctx.effect({ key: "mail", action: "mail.send", payload: {} }, async (key) => {
      appendFileSync(sentLog, `${key}\n`);
      return "sent";
    });
    if (ctx.state() === "planning") ctx.setState("running");
    ctx.setState("verifying");
    ctx.setState("completed");
  },
});

const idFile = join(dir, "job-id");
if (!existsSync(idFile)) writeFileSync(idFile, seedJob(db));
const jobId = readFileSync(idFile, "utf8");

await recover({ db, bus, jobs, journal, effects, runner });
if (jobs.require(jobId).state === "draft") runner.start(jobId);

const end = Date.now() + 10_000;
while (!["completed", "blocked", "waiting", "cancelled"].includes(jobs.require(jobId).state)) {
  if (Date.now() > end) break;
  await new Promise((r) => setTimeout(r, 10));
}
const job = jobs.require(jobId);
process.stdout.write(JSON.stringify({ state: job.state, reason: job.blockedReason }));
process.exit(0);
