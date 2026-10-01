import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Event } from "@oraknid/contracts";
import { and, desc, eq, gt, like, lt, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/open.ts";
import { events } from "../db/schema.ts";
import { readSetting, writeSetting } from "../settings.ts";

// The audit log (Security → Audit log, BR-16): the append-only event
// stream, searchable, and exported daily as JSONL.

export const AuditQuery = z.object({
  jobId: z.string().optional(),
  /** A type or a type prefix ending with ".", e.g. "policy." */
  type: z.string().optional(),
  actor: z.string().optional(),
  /** Free text, matched in the payload. */
  text: z.string().optional(),
  beforeSeq: z.number().int().positive().optional(),
  limit: z.number().int().positive().max(500).default(100),
});
export type AuditQuery = z.infer<typeof AuditQuery>;

export function searchAudit(db: Db, q: AuditQuery): Event[] {
  const where: SQL[] = [];
  if (q.jobId) where.push(eq(events.jobId, q.jobId));
  if (q.type)
    where.push(q.type.endsWith(".") ? like(events.type, `${q.type}%`) : eq(events.type, q.type));
  if (q.actor) where.push(eq(events.actor, q.actor));
  if (q.text)
    where.push(or(like(events.payload, `%${q.text}%`), like(events.type, `%${q.text}%`)) as SQL);
  if (q.beforeSeq) where.push(lt(events.seq, q.beforeSeq));
  return db
    .select()
    .from(events)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(events.seq))
    .limit(q.limit)
    .all()
    .map((r) => ({
      seq: r.seq,
      at: r.at,
      type: r.type,
      topic: r.topic,
      jobId: r.jobId,
      payload: r.payload ?? null,
      actor: r.actor,
    }));
}

const LAST = "audit.exportedSeq";

/** Appends events not yet exported to `<dir>/<YYYY-MM-DD>.jsonl`, one file per day. Returns how many. */
export function exportAudit(db: Db, dir: string): number {
  const from = readSetting(db, LAST, z.number(), 0);
  const rows = db
    .select()
    .from(events)
    .where(gt(events.seq, from))
    .orderBy(events.seq)
    .limit(10_000)
    .all();
  if (rows.length === 0) return 0;
  mkdirSync(dir, { recursive: true });
  const byDay = new Map<string, string[]>();
  for (const r of rows) {
    const day = new Date(r.at).toISOString().slice(0, 10);
    const lines = byDay.get(day) ?? [];
    lines.push(
      JSON.stringify({
        seq: r.seq,
        at: new Date(r.at).toISOString(),
        actor: r.actor,
        type: r.type,
        jobId: r.jobId,
        payload: r.payload,
      }),
    );
    byDay.set(day, lines);
  }
  for (const [day, lines] of byDay)
    appendFileSync(join(dir, `${day}.jsonl`), `${lines.join("\n")}\n`);
  writeSetting(db, LAST, z.number(), (rows.at(-1) as (typeof rows)[number]).seq);
  return rows.length;
}

export function startAuditExport(db: Db, dir: string, intervalMs = 60_000) {
  const timer = setInterval(() => {
    try {
      exportAudit(db, dir);
    } catch (error) {
      console.error("audit export failed", error);
    }
  }, intervalMs);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
      exportAudit(db, dir);
    },
  };
}
