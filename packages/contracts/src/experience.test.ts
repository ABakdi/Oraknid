import { describe, expect, it } from "vitest";
import { deviceOf, Experience, experienceDevices, experienceMarkdown } from "./experience.ts";

describe("the experience section (ADR-064 §4)", () => {
  const e = Experience.parse({
    feel: "A hardware synth.",
    layouts: [
      { device: "Phone (landscape)", layout: "Keys across." },
      { device: "iPad", layout: "Two panels." },
      { device: "Desktop", layout: "Everything." },
      { device: "a fridge", layout: "?" },
    ],
    criteria: ["Knobs, not number fields."],
  });

  it("names the devices it lays out, known ones only; none: phone and desktop", () => {
    expect(experienceDevices(e)).toEqual(["phone-landscape", "tablet", "desktop"]);
    expect(experienceDevices(null)).toEqual(["phone", "desktop"]);
    expect(deviceOf("Mobile")).toBe("phone");
    expect(deviceOf("laptop 13 inch")).toBe("laptop");
  });

  it("is written as the spec's section, criteria last", () => {
    const md = experienceMarkdown(e);
    expect(md).toMatch(/^\*\*Feel\*\*\nA hardware synth\./);
    expect(md).toMatch(/\*\*Experience acceptance criteria\*\*\n- Knobs, not number fields\.$/);
    expect(md).not.toContain("**Controls**");
  });
});
