/**
 * A push-based async queue: producers push, one consumer iterates. Ends
 * when `end()` is called, after delivering everything pushed before it.
 */
export class Channel<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  #waiting: ((r: IteratorResult<T>) => void) | null = null;
  #ended = false;

  push(item: T) {
    if (this.#ended) return;
    if (this.#waiting) {
      const w = this.#waiting;
      this.#waiting = null;
      w({ value: item, done: false });
    } else this.#items.push(item);
  }

  end() {
    this.#ended = true;
    if (this.#waiting && this.#items.length === 0) {
      const w = this.#waiting;
      this.#waiting = null;
      w({ value: undefined as never, done: true });
    }
  }

  get ended() {
    return this.#ended;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.#items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.#ended) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => {
          this.#waiting = resolve;
        });
      },
    };
  }
}
