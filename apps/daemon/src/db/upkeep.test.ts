import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "../events/bus.ts";
import { InboxStore } from "../inbox/store.ts";
import { SilkStore } from "../silk/store.ts";
import { seedJob } from "../testing/fixtures.ts";
import {
  EVENT_STRING_MAX,
  EYE_MESSAGE_MAX,
  INBOX_DETAIL_MAX,
  REASON_MAX,
  SILK_BODY_MAX,
} from "./caps.ts";
import { closeDatabase, type Db, openDatabase } from "./open.ts";
import { eyeMessages, inboxItems, jobs, settings, silkEntries } from "./schema.ts";
import { CLIP_OVERSIZED, clipOversizedRows } from "./upkeep.ts";

// Migration 0043 (Persistence-and-Recovery → Size caps): rows from before the caps cut
// short once, their originals kept whole in <data>/archive/.

let dir: string;
let db: Db;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "oraknid-upkeep-"));
  db = await openDatabase({ file: join(dir, "oraknid.db"), backupsDir: join(dir, "backups") });
});
afterEach(() => closeDatabase(db));

const dump = (n: number, label: string) => `${label} ${"x".repeat(n)} END`;

describe("migration 0043: oversized rows", () => {
  it("leaves its mark on a database it migrates", () => {
    expect(db.select().from(settings).where(eq(settings.key, CLIP_OVERSIZED)).get()?.value).toBe(
      "pending",
    );
  });

  it("cuts every oversized row short, keeps the originals whole, and runs once", () => {
    const jobId = seedJob(db, "blocked");
    const projectId = db.select().from(jobs).where(eq(jobs.id, jobId)).get()?.projectId ?? "";
    const c = db.$client;
    const bigReason = dump(3_200_000, "git failed");
    c.prepare("update jobs set blocked_reason = ? where id = ?").run(bigReason, jobId);
    const messageId = ulid();
    c.prepare(
      "insert into eye_messages (id, job_id, project_id, author, text, created_at) values (?, ?, ?, 'eye', ?, 1)",
    ).run(messageId, jobId, projectId, dump(3_200_000, "Blocked:"));
    const small = ulid();
    c.prepare(
      "insert into eye_messages (id, job_id, project_id, author, text, created_at) values (?, ?, ?, 'owner', 'hello', 2)",
    ).run(small, jobId, projectId);
    const silkId = ulid();
    c.prepare(
      "insert into silk_entries (id, job_id, kind, title, body, covers, authored_by, created_at) values (?, ?, 'progress', 'Done', ?, '[]', '\"eye\"', 1)",
    ).run(silkId, jobId, dump(1_500_000, "Verified"));
    const itemId = ulid();
    c.prepare(
      "insert into inbox_items (id, kind, job_id, raised_by, title, detail, options, state, created_at) values (?, 'question', ?, '\"eye\"', 'Q', ?, '[]', 'open', 1)",
    ).run(itemId, jobId, dump(100_000, "detail"));
    const ins = c.prepare(
      "insert into events (at, type, topic, job_id, payload, actor) values (1, ?, ?, ?, ?, 'oraknid')",
    );
    ins.run(
      "job.state",
      `job:${jobId}`,
      jobId,
      JSON.stringify({ from: "running", to: "blocked", reason: bigReason }),
    );
    const plain = JSON.stringify({ sessionId: "s", text: "hello" });
    ins.run("session.text", `job:${jobId}`, jobId, plain);

    const report = clipOversizedRows(db, join(dir, "archive"), () => Date.UTC(2026, 9, 8));
    expect(report?.cut).toEqual({
      "eye_messages.text": 1,
      "inbox_items.detail": 1,
      "silk_entries.body": 1,
      "jobs.blocked_reason": 1,
      "events.payload": 1,
    });

    // Cut short, with the note, under the caps.
    const m = db.select().from(eyeMessages).where(eq(eyeMessages.id, messageId)).get();
    expect(m?.text.length).toBeLessThanOrEqual(EYE_MESSAGE_MAX);
    expect(m?.text).toMatch(/^Blocked:/);
    expect(m?.text).toMatch(/END$/);
    expect(m?.text).toContain("(cut short; 3,200,013 characters)");
    expect(db.select().from(eyeMessages).where(eq(eyeMessages.id, small)).get()?.text).toBe(
      "hello",
    );
    expect(
      db.select().from(silkEntries).where(eq(silkEntries.id, silkId)).get()?.body.length,
    ).toBeLessThanOrEqual(SILK_BODY_MAX);
    expect(
      db.select().from(inboxItems).where(eq(inboxItems.id, itemId)).get()?.detail.length,
    ).toBeLessThanOrEqual(INBOX_DETAIL_MAX);
    expect(
      db.select().from(jobs).where(eq(jobs.id, jobId)).get()?.blockedReason?.length,
    ).toBeLessThanOrEqual(REASON_MAX);
    const payloads = (
      c.prepare("select payload from events order by seq").all() as { payload: string }[]
    ).map((r) => r.payload);
    const state = JSON.parse(payloads[0] as string) as { reason: string; to: string };
    expect(state.to).toBe("blocked");
    expect(state.reason.length).toBeLessThanOrEqual(EVENT_STRING_MAX);
    expect(payloads[1]).toBe(plain);

    // The originals, whole, one line each, mine only.
    const archive = report?.archive as string;
    expect(readdirSync(join(dir, "archive"))).toEqual([
      "oversized-rows-2026-10-08T00-00-00-000Z.ndjson",
    ]);
    expect(statSync(archive).mode & 0o777).toBe(0o600);
    const lines = readFileSync(archive, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(5);
    const original = lines.find((l) => l.table === "eye_messages");
    expect(original).toMatchObject({ key: "id", id: messageId, column: "text" });
    expect(original.original).toBe(dump(3_200_000, "Blocked:"));
    const event = lines.find((l) => l.table === "events");
    expect(JSON.parse(event.original).reason).toBe(bigReason);

    // Once: the mark is gone, and a second run does nothing.
    expect(
      db.select().from(settings).where(eq(settings.key, CLIP_OVERSIZED)).get(),
    ).toBeUndefined();
    expect(clipOversizedRows(db, join(dir, "archive"))).toBeNull();
  });

  it("archives nothing when no row is oversized", () => {
    seedJob(db);
    const report = clipOversizedRows(db, join(dir, "archive"));
    expect(report).toEqual({ cut: {}, archive: null });
  });
});

describe("caps where rows are written", () => {
  it("cut what the event bus, Silk and the inbox store", () => {
    const jobId = seedJob(db, "running");
    const bus = new EventBus(db);
    const e = bus.publish({
      type: "session.tool.result",
      topic: `job:${jobId}`,
      jobId,
      payload: { sessionId: "s", ok: true, output: dump(270_000, "out") },
    });
    const output = (e.payload as { output: string }).output;
    expect(output.length).toBeLessThanOrEqual(EVENT_STRING_MAX);
    expect(output).toMatch(/^out/);
    expect(output).toMatch(/END$/);

    const inbox = new InboxStore(db, bus);
    const silk = new SilkStore(db, bus, inbox);
    const entry = silk.add({
      jobId,
      kind: "progress",
      title: "Done",
      body: dump(1_500_000, "Verified"),
      authoredBy: "eye",
    });
    expect(entry.body.length).toBeLessThanOrEqual(SILK_BODY_MAX);
    const id = inbox.open({
      kind: "question",
      jobId,
      raisedBy: "eye",
      title: "Q",
      detail: dump(100_000, "detail"),
      options: [],
    });
    expect(
      db.select().from(inboxItems).where(eq(inboxItems.id, id)).get()?.detail.length,
    ).toBeLessThanOrEqual(INBOX_DETAIL_MAX);
  });
});
