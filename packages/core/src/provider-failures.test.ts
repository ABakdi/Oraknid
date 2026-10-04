import { describe, expect, it } from "vitest";
import { providerFailure, restFor } from "./provider-failures.ts";

describe("provider failures (M13.22)", () => {
  it.each([
    ["Internal server error", "model", 5],
    ["Error from provider (Console): Upstream request failed: Model is unavailable.", "model", 30],
    ["OpenCode POST /api/session: 503 Service Unavailable", "model", 5],
    ["fetch failed (ECONNRESET)", "model", 5],
    ["Invalid API key provided", "leg", 15],
    ["401 Unauthorized", "leg", 15],
    ["Not logged in · Please run /login", "leg", 15],
    ["Individual quota reached. Please upgrade your subscription.", "leg", 15],
    [
      'Failed query: select "id", "session_id" from "session_message" where "session_message"."session_id" = ?',
      "leg",
      2,
    ],
    ["The session ended.", "leg", 2],
  ])("`%s` is its provider's, not the task's: rests the %s", (error, scope, minutes) => {
    const f = providerFailure(error);
    expect(f?.scope).toBe(scope);
    expect(f?.restMs).toBe(minutes * 60_000);
    expect(f?.reason.length).toBeLessThanOrEqual(160);
  });

  it.each([null, "", "The model refused: the task makes no sense", "I could not find the file"])(
    "`%s` is the task's own",
    (error) => {
      expect(providerFailure(error)).toBeNull();
    },
  );

  it("rests longer for each one in a row, at most four hours", () => {
    const f = providerFailure("Internal server error");
    if (!f) throw new Error("not a provider failure");
    expect([1, 2, 3].map((n) => restFor(f, n) / 60_000)).toEqual([5, 10, 20]);
    expect(restFor(f, 20)).toBe(4 * 3600_000);
  });
});
