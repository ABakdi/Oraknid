import { describe, expect, it } from "vitest";
import { textToHtml } from "./mail-composer";

describe("the composer (ADR-032)", () => {
  it("turns a quoted reply into paragraphs and a quote, escaping what was written", () => {
    expect(textToHtml("Thanks <b>!\n\nOn Friday, Bob wrote:\n> Lunch?\n> At noon")).toBe(
      "<p>Thanks &lt;b&gt;!</p><p></p><p>On Friday, Bob wrote:</p><blockquote><p>Lunch?<br>At noon</p></blockquote>",
    );
  });
});
