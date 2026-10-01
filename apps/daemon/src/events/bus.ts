import type { Event, NewEvent } from "@oraknid/contracts";
import { and, asc, count, desc, gt, inArray } from "drizzle-orm";
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

  constructor(db: Db, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  publish(event: NewEvent): Event {
    const row = this.#db
      .insert(events)
      .values({
        at: this.#now(),
        type: event.type,
        topic: event.topic,
        jobId: event.jobId,
        payload: event.payload ?? null,
      })
      .returning()
      .get();
    const committed = toEvent(row);
    for (const listener of this.#listeners) {
      try {
        listener(committed);
      } catch (error) {
        // One broken listener must not stop the others or the publisher.
        console.error("event listener failed", error);
      }
    }
    return committed;
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
  };
}
