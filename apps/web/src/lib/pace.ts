/**
 * Live data at a pace the page can take (Web-UI → Performance): a ring
 * buffer that keeps the newest N of a stream, and a coalescer that folds a
 * burst of "reload!" into one call at most every so often, and none while
 * the page is out of sight.
 */

/** The newest `capacity` items pushed, oldest first; older ones are dropped. */
export class RingBuffer<T> {
  readonly #items: (T | undefined)[];
  #start = 0;
  #size = 0;

  constructor(readonly capacity: number) {
    if (capacity < 1) throw new Error("A ring buffer holds at least one item.");
    this.#items = new Array(capacity);
  }

  get size() {
    return this.#size;
  }

  push(item: T) {
    if (this.#size < this.capacity) {
      this.#items[(this.#start + this.#size) % this.capacity] = item;
      this.#size++;
      return;
    }
    // Full: the oldest goes.
    this.#items[this.#start] = item;
    this.#start = (this.#start + 1) % this.capacity;
  }

  clear() {
    this.#items.fill(undefined);
    this.#start = 0;
    this.#size = 0;
  }

  /** Oldest first. */
  toArray(): T[] {
    const out = new Array<T>(this.#size);
    for (let i = 0; i < this.#size; i++)
      out[i] = this.#items[(this.#start + i) % this.capacity] as T;
    return out;
  }
}

/** Whether this page is out of sight (another tab, a minimised window). */
export const pageHidden = () =>
  typeof document !== "undefined" && document.visibilityState === "hidden";

/** Called each time the page comes back into sight. */
export function onPageVisible(f: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  const listener = () => {
    if (document.visibilityState === "visible") f();
  };
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
}

export interface CoalesceOptions {
  /** At most one call in this many milliseconds. */
  everyMs: number;
  /** How long a first request waits for the rest of its burst. */
  settleMs?: number;
  /** Out of sight: nothing runs, the call waits for the page to come back. */
  hidden?: () => boolean;
  now?: () => number;
}

/**
 * Folds requests into calls of `fn`: the first request of a burst runs it
 * `settleMs` later (or once `everyMs` has passed since the last call, if
 * later), every request until then rides along. While the page is hidden
 * the call is kept for when it is seen again (`visible()`).
 */
export class Coalescer {
  readonly #fn: () => void;
  readonly #o: Required<Omit<CoalesceOptions, "hidden">> & { hidden: () => boolean };
  #timer: ReturnType<typeof setTimeout> | undefined;
  #last = Number.NEGATIVE_INFINITY;
  #owed = false;
  #stopped = false;

  constructor(fn: () => void, o: CoalesceOptions) {
    this.#fn = fn;
    this.#o = {
      settleMs: 100,
      hidden: pageHidden,
      now: () => Date.now(),
      ...o,
    };
  }

  /** Something changed: the call will come. */
  request() {
    if (this.#stopped || this.#timer !== undefined) return;
    if (this.#o.hidden()) {
      this.#owed = true;
      return;
    }
    const now = this.#o.now();
    const at = Math.max(now + this.#o.settleMs, this.#last + this.#o.everyMs);
    this.#timer = setTimeout(() => this.#fire(), at - now);
  }

  /** The page is seen again: a call owed while it was hidden runs now. */
  visible() {
    if (!this.#owed || this.#stopped) return;
    this.#owed = false;
    this.request();
  }

  /** Whether a call is waiting (scheduled, or owed for when the page is seen). */
  get pending() {
    return this.#timer !== undefined || this.#owed;
  }

  stop() {
    this.#stopped = true;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #fire() {
    this.#timer = undefined;
    if (this.#o.hidden()) {
      this.#owed = true;
      return;
    }
    this.#last = this.#o.now();
    this.#fn();
  }
}
