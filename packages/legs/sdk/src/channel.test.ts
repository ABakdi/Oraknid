import { describe, expect, it } from "vitest";
import { Channel } from "./channel.ts";

describe("Channel", () => {
  it("delivers in order, including items pushed before anyone reads", async () => {
    const c = new Channel<number>();
    c.push(1);
    c.push(2);
    const got: number[] = [];
    const reading = (async () => {
      for await (const n of c) got.push(n);
    })();
    c.push(3);
    c.end();
    await reading;
    expect(got).toEqual([1, 2, 3]);
  });

  it("ignores pushes after the end", async () => {
    const c = new Channel<number>();
    c.end();
    c.push(1);
    const got: number[] = [];
    for await (const n of c) got.push(n);
    expect(got).toEqual([]);
  });
});
