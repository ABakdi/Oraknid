import type { Event, NewEvent } from "@oraknid/contracts";
import { scrubDeep } from "@oraknid/core";
import { and, asc, count, desc, gt, inArray } from "drizzle-orm";
import { cutStrings, EVENT_STRING_MAX } from "../db/caps.ts";
import type { Db } from "../db/open.ts";
import { events } from "../db/schema.ts";

export type Listener = (event: Event) => void;

/**
 * The append-only event stream. An event is committed to the database
 * first (BR-8), then handed to live listeners, so a listener never sees
 * an event that a crash could lose.
 */
export class EventBus {
  readonly #db: Db;
  readonly #listeners = new Set<Listener>();
  readonly #now: () => number;
  /** Events published inside `atomically`, announced after it commits. */
  #pending: Event[] | null = null;

  /** Scrubs secrets from every payload before it is stored (BR-13). */
  scrub: (text: string) => string = (t) => t;

  constructor(db: Db, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  #closed = false;

  /** After shutdown nothing can be stored: late publishers (a notification finishing) are dropped. */
  close() {
    this.#closed = true;
  }

  publish(event: NewEvent): Event {
    if (this.#closed) {
      return {
        seq: 0,
        at: this.#now(),
        type: event.type,
        topic: event.topic,
        jobId: event.jobId,
        payload: event.payload ?? null,
        actor: event.actor ?? "oraknid",
      };
    }
    const row = this.#db
      .insert(events)
      .values({
        at: this.#now(),
        type: event.type,
        topic: event.topic,
        jobId: event.jobId,
        payload:
          event.payload === undefined || event.payload === null
            ? null
            : // Round-tripped first: what is stored is plain JSON, as before. Each string
              // scrubbed, then cut to its cap: a tool's whole output is no event's (Size caps).
              cutStrings(
                scrubDeep(JSON.parse(JSON.stringify(event.payload)), (s) => this.scrub(s)),
                EVENT_STRING_MAX,
              ),
        actor: event.actor ?? "oraknid",
      })
      .returning()
      .get();
    const committed = toEvent(row);
    if (this.#pending) {
      this.#pending.push(committed);
      return committed;
    }
    this.#announce(committed);
    return committed;
  }

  /**
   * Runs `fn` in one database transaction. Events it publishes are
   * committed with it and announced only after the commit, so a rolled
   * back transition is never heard (BR-8).
   */
  atomically<T>(fn: () => T): T {
    if (this.#pending) return fn(); // already inside one
    this.#pending = [];
    let events: Event[] = [];
    try {
      const result = this.#db.$client.transaction(fn)();
      events = this.#pending;
      return result;
    } finally {
      this.#pending = null;
      for (const e of events) this.#announce(e);
    }
  }

  #announce(committed: Event) {
    for (const listener of this.#listeners) {
      try {
        listener(committed);
      } catch (error) {
        // One broken listener must not stop the others or the publisher.
        console.error("event listener failed", error);
      }
    }
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  lastSeq(): number {
    const row = this.#db
      .select({ seq: events.seq })
      .from(events)
      .orderBy(desc(events.seq))
      .limit(1)
      .get();
    return row?.seq ?? 0;
  }

  /** Events after `seq` on the given topics, oldest first, at most `limit`. */
  since(seq: number, topics: readonly string[], limit: number): Event[] {
    if (topics.length === 0) return [];
    return this.#db
      .select()
      .from(events)
      .where(and(gt(events.seq, seq), inArray(events.topic, [...topics])))
      .orderBy(asc(events.seq))
      .limit(limit)
      .all()
      .map(toEvent);
  }

  /** How many events after `seq` on the given topics. */
  countSince(seq: number, topics: readonly string[]): number {
    if (topics.length === 0) return 0;
    const row = this.#db
      .select({ n: count() })
      .from(events)
      .where(and(gt(events.seq, seq), inArray(events.topic, [...topics])))
      .get();
    return row?.n ?? 0;
  }
}

function toEvent(row: typeof events.$inferSelect): Event {
  return {
    seq: row.seq,
    at: row.at,
    type: row.type,
    topic: row.topic,
    jobId: row.jobId,
    payload: row.payload ?? null,
    actor: row.actor,
  };
}
