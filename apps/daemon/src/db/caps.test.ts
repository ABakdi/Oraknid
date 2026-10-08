import { describe, expect, it } from "vitest";
import { cutShort, cutStrings, EVENT_STRING_MAX, isCutShort } from "./caps.ts";

describe("cutShort", () => {
  it("leaves a text that fits", () => {
    expect(cutShort("short", 100)).toBe("short");
  });

  it("keeps the start and the end of a long output, and says how long it was", () => {
    const text = `START ${"x".repeat(3_200_000)} the error at the END`;
    const cut = cutShort(text, 20_000);
    expect(cut.length).toBeLessThanOrEqual(20_000);
    expect(cut.startsWith("START")).toBe(true);
    expect(cut.endsWith("the error at the END")).toBe(true);
    expect(cut).toContain(`(cut short; ${text.length.toLocaleString("en-US")} characters)`);
    expect(isCutShort(cut)).toBe(true);
  });

  it("keeps only the start when asked", () => {
    const cut = cutShort(`${"a".repeat(1000)}END`, 600, "head");
    expect(cut.length).toBeLessThanOrEqual(600);
    expect(cut.endsWith("(cut short; 1,003 characters)")).toBe(true);
    expect(cut).not.toContain("END");
  });

  it("is the same when cut again", () => {
    const once = cutShort("y".repeat(100_000), 20_000);
    expect(cutShort(once, 20_000)).toBe(once);
  });
});

describe("cutStrings", () => {
  it("cuts each string of a payload past the cap, wherever it is", () => {
    const payload = {
      sessionId: "s",
      output: "o".repeat(270_754),
      input: { command: "c".repeat(87_880), cwd: "/p" },
      lines: ["fine", "l".repeat(40_000)],
      ok: true,
    };
    const cut = cutStrings(payload, EVENT_STRING_MAX);
    expect(cut.sessionId).toBe("s");
    expect(cut.ok).toBe(true);
    expect(cut.input.cwd).toBe("/p");
    expect(cut.output.length).toBeLessThanOrEqual(EVENT_STRING_MAX);
    expect(cut.input.command.length).toBeLessThanOrEqual(EVENT_STRING_MAX);
    expect(cut.lines[0]).toBe("fine");
    expect(cut.lines[1]?.length).toBeLessThanOrEqual(EVENT_STRING_MAX);
    expect(JSON.stringify(cut).length).toBeLessThan(4 * EVENT_STRING_MAX);
  });

  it("returns the very same value when nothing is past the cap", () => {
    const payload = { a: "x", b: [1, { c: "y" }] };
    expect(cutStrings(payload, 10)).toBe(payload);
  });
});
