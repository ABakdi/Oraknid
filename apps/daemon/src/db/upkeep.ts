import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import {
  cutShort,
  cutStrings,
  EVENT_STRING_MAX,
  EYE_MESSAGE_MAX,
  INBOX_DETAIL_MAX,
  REASON_MAX,
  SILK_BODY_MAX,
} from "./caps.ts";
import type { Db } from "./open.ts";

/** The mark migration 0043 leaves for this to run once. */
export const CLIP_OVERSIZED = "upkeep.clipOversizedRows";

/** One text column to cut to its cap. */
interface TextColumn {
  table: string;
  key: string;
  column: string;
  max: number;
  keep: "head-tail" | "head";
}

const TEXTS: TextColumn[] = [
  { table: "eye_messages", key: "id", column: "text", max: EYE_MESSAGE_MAX, keep: "head-tail" },
  { table: "inbox_items", key: "id", column: "detail", max: INBOX_DETAIL_MAX, keep: "head-tail" },
  { table: "silk_entries", key: "id", column: "body", max: SILK_BODY_MAX, keep: "head-tail" },
  { table: "jobs", key: "id", column: "blocked_reason", max: REASON_MAX, keep: "head" },
  { table: "jobs", key: "id", column: "pause_reason", max: REASON_MAX, keep: "head" },
];

export interface ClipReport {
  /** Rows cut short, by table and column ("events.payload": 3). */
  cut: Record<string, number>;
  /** Where the originals went, if any was cut. */
  archive: string | null;
}

/**
 * Migration 0043's work (Persistence-and-Recovery → Size caps): rows written
 * before the caps that are past them are cut short as new ones are, with a
 * note of their length; each original goes first, whole, to
 * `<archiveDir>/oversized-rows-<time>.ndjson` (one JSON line per row:
 * table, key, column, the original), so nothing is lost. Runs once, while
 * the migration's mark is there, then removes it. A crash before the end
 * leaves the mark: it runs again, and a row already cut is left as it is.
 */
export function clipOversizedRows(
  db: Db,
  archiveDir: string,
  now: () => number = Date.now,
): ClipReport | null {
  const c = db.$client;
  const marked = c.prepare("select 1 from settings where key = ?").get(CLIP_OVERSIZED);
  if (!marked) return null;

  type Change = {
    table: string;
    key: string;
    id: unknown;
    column: string;
    was: string;
    now: string;
  };
  const changes: Change[] = [];
  for (const t of TEXTS) {
    const rows = c
      .prepare(
        `select ${t.key} as id, ${t.column} as value from ${t.table} where length(${t.column}) > ?`,
      )
      .all(t.max) as { id: unknown; value: string }[];
    for (const r of rows)
      changes.push({
        table: t.table,
        key: t.key,
        id: r.id,
        column: t.column,
        was: r.value,
        now: cutShort(r.value, t.max, t.keep),
      });
  }
  // An event's payload is JSON: each string in it is cut, as the bus does now.
  const events = c
    .prepare("select seq as id, payload as value from events where length(payload) > ?")
    .all(EVENT_STRING_MAX) as { id: number; value: string }[];
  for (const r of events) {
    let payload: unknown;
    try {
      payload = JSON.parse(r.value);
    } catch {
      continue;
    }
    const cut = cutStrings(payload, EVENT_STRING_MAX);
    if (cut === payload) continue;
    changes.push({
      table: "events",
      key: "seq",
      id: r.id,
      column: "payload",
      was: r.value,
      now: JSON.stringify(cut),
    });
  }

  let archive: string | null = null;
  if (changes.length) {
    // The originals first, on disk and synced: the rows change only once they are kept.
    mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
    archive = join(
      archiveDir,
      `oversized-rows-${new Date(now()).toISOString().replace(/[:.]/g, "-")}.ndjson`,
    );
    const fd = openSync(archive, "a", 0o600);
    try {
      for (const ch of changes)
        writeSync(
          fd,
          `${JSON.stringify({ table: ch.table, key: ch.key, id: ch.id, column: ch.column, original: ch.was })}\n`,
        );
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  const cut: Record<string, number> = {};
  c.transaction(() => {
    for (const ch of changes) {
      c.prepare(`update ${ch.table} set ${ch.column} = ? where ${ch.key} = ?`).run(ch.now, ch.id);
      const name = `${ch.table}.${ch.column}`;
      cut[name] = (cut[name] ?? 0) + 1;
    }
    c.prepare("delete from settings where key = ?").run(CLIP_OVERSIZED);
  })();
  return { cut, archive };
}
