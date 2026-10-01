import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, type Db, openDatabase } from "../db/open.ts";
import { EventBus } from "./bus.ts";

let db: Db;
beforeEach(async () => {
  db = await openDatabase({ file: ":memory:" });
});
afterEach(() => closeDatabase(db));

const ev = (topic: string, type = "test") => ({ type, topic, jobId: null, payload: { topic } });

describe("EventBus", () => {
  it("numbers events in order, starting at 1", () => {
    const bus = new EventBus(db, () => 42);
    expect(bus.lastSeq()).toBe(0);
    const a = bus.publish(ev("overview"));
    const b = bus.publish(ev("inbox"));
    expect([a.seq, b.seq]).toEqual([1, 2]);
    expect(a.at).toBe(42);
    expect(bus.lastSeq()).toBe(2);
  });

  it("commits before notifying, so a listener can read the event back", () => {
    const bus = new EventBus(db);
    const seen: number[] = [];
    bus.subscribe((e) => seen.push(bus.since(e.seq - 1, ["overview"], 10).length));
    bus.publish(ev("overview"));
    expect(seen).toEqual([1]);
  });

  it("keeps notifying other listeners when one throws", () => {
    const bus = new EventBus(db);
    const seen: string[] = [];
    bus.subscribe(() => {
      throw new Error("boom");
    });
    bus.subscribe((e) => seen.push(e.topic));
    const original = console.error;
    console.error = () => {};
    try {
      bus.publish(ev("overview"));
    } finally {
      console.error = original;
    }
    expect(seen).toEqual(["overview"]);
  });

  it("replays only the requested topics after a given seq", () => {
    const bus = new EventBus(db);
    bus.publish(ev("overview"));
    bus.publish(ev("inbox"));
    bus.publish(ev("overview"));
    bus.publish(ev("metrics"));
    expect(bus.since(1, ["overview", "metrics"], 10).map((e) => e.seq)).toEqual([3, 4]);
    expect(bus.countSince(0, ["overview"])).toBe(2);
    expect(bus.since(0, ["overview", "inbox", "metrics"], 2).map((e) => e.seq)).toEqual([1, 2]);
    expect(bus.since(0, [], 10)).toEqual([]);
  });

  it("stops notifying after unsubscribe", () => {
    const bus = new EventBus(db);
    let n = 0;
    const off = bus.subscribe(() => n++);
    bus.publish(ev("overview"));
    off();
    bus.publish(ev("overview"));
    expect(n).toBe(1);
  });
});
