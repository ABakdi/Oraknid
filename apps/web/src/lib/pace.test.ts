import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Coalescer, RingBuffer } from "./pace";

describe("RingBuffer", () => {
  it("keeps the newest items, oldest first", () => {
    const r = new RingBuffer<number>(3);
    for (let i = 1; i <= 7; i++) r.push(i);
    expect(r.toArray()).toEqual([5, 6, 7]);
    expect(r.size).toBe(3);
  });

  it("holds fewer than its capacity until full, and empties", () => {
    const r = new RingBuffer<string>(4);
    r.push("a");
    r.push("b");
    expect(r.toArray()).toEqual(["a", "b"]);
    r.clear();
    expect(r.toArray()).toEqual([]);
    r.push("c");
    expect(r.toArray()).toEqual(["c"]);
  });

  it("never grows past its capacity, whatever comes", () => {
    const r = new RingBuffer<number>(600);
    for (let i = 0; i < 100_000; i++) r.push(i);
    expect(r.size).toBe(600);
    expect(r.toArray()[0]).toBe(100_000 - 600);
  });
});

describe("Coalescer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("folds a burst into one call", () => {
    const fn = vi.fn();
    const c = new Coalescer(fn, { everyMs: 500, hidden: () => false, now: () => Date.now() });
    // An agent's text every 250 ms for 10 s: 40 events.
    for (let i = 0; i < 40; i++) {
      c.request();
      vi.advanceTimersByTime(250);
    }
    vi.advanceTimersByTime(1000);
    // At most one call per 500 ms: 20 over 10 s, not 40.
    expect(fn.mock.calls.length).toBeLessThanOrEqual(21);
    expect(fn.mock.calls.length).toBeGreaterThanOrEqual(19);
  });

  it("calls soon after a lone request, and never sooner than everyMs after the last", () => {
    const fn = vi.fn();
    const c = new Coalescer(fn, { everyMs: 2000, settleMs: 100, hidden: () => false });
    c.request();
    vi.advanceTimersByTime(99);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    c.request();
    vi.advanceTimersByTime(1500);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(500);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does nothing while the page is hidden, and calls once when it is seen", () => {
    const fn = vi.fn();
    let hidden = true;
    const c = new Coalescer(fn, { everyMs: 500, hidden: () => hidden });
    for (let i = 0; i < 100; i++) {
      c.request();
      vi.advanceTimersByTime(250);
    }
    expect(fn).not.toHaveBeenCalled();
    expect(c.pending).toBe(true);
    hidden = false;
    c.visible();
    vi.advanceTimersByTime(200);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(c.pending).toBe(false);
  });

  it("a page hidden once the call was scheduled still waits for it to be seen", () => {
    const fn = vi.fn();
    let hidden = false;
    const c = new Coalescer(fn, { everyMs: 500, hidden: () => hidden });
    c.request();
    hidden = true;
    vi.advanceTimersByTime(1000);
    expect(fn).not.toHaveBeenCalled();
    hidden = false;
    c.visible();
    vi.advanceTimersByTime(200);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("stops for good", () => {
    const fn = vi.fn();
    const c = new Coalescer(fn, { everyMs: 500, hidden: () => false });
    c.request();
    c.stop();
    c.request();
    vi.advanceTimersByTime(5000);
    expect(fn).not.toHaveBeenCalled();
  });
});
