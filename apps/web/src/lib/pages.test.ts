import { describe, expect, it } from "vitest";
import { newestEvents } from "./live";
import { mergePages } from "./pages";

describe("mergePages", () => {
  it("puts earlier pages above the live one, each message once", () => {
    const older = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const latest = [{ id: "c" }, { id: "d" }];
    expect(mergePages(older, latest).map((x) => x.id)).toEqual(["a", "b", "c", "d"]);
    expect(mergePages([], latest)).toBe(latest);
  });
});

describe("newestEvents", () => {
  const ev = (seq: number) => ({
    seq,
    at: seq,
    type: "session.text",
    topic: "job:x",
    jobId: null,
    payload: null,
    actor: "oraknid",
  });

  it("joins the seed and what came since, newest first, each once, at most `limit`", () => {
    const seed = [ev(5), ev(4), ev(3)];
    const fresh = [ev(5), ev(6), ev(7)];
    expect(newestEvents(seed, fresh, 4).map((e) => e.seq)).toEqual([7, 6, 5, 4]);
  });
});
