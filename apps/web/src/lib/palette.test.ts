import { beforeEach, describe, expect, it } from "vitest";
import { fuzzyScore, type PaletteEntry, recentItems, remember, searchPalette } from "./palette";

// The command palette's search (Web-UI → Layout): fuzzy, every group shown,
// the places I opened lately first.

const e = (key: string, label: string, more: Partial<PaletteEntry> = {}): PaletteEntry => ({
  key,
  group: "Projects",
  label,
  href: `/x/${key}`,
  ...more,
});

describe("fuzzy matching", () => {
  it("finds letters in order, words anywhere, and ranks a plain match first", () => {
    expect(fuzzyScore("pno", "Piano")).toBeGreaterThan(0);
    expect(fuzzyScore("onp", "Piano")).toBe(0);
    expect(fuzzyScore("site api", "The API of my site")).toBeGreaterThan(0);
    expect(fuzzyScore("site xyz", "The API of my site")).toBe(0);
    expect(fuzzyScore("piano", "Piano")).toBeGreaterThan(fuzzyScore("pno", "Piano"));
    // A word's start counts more than its middle.
    expect(fuzzyScore("set", "Settings")).toBeGreaterThan(fuzzyScore("set", "Reset"));
    expect(fuzzyScore("", "anything")).toBe(1);
  });
});

describe("searching the palette", () => {
  const entries = [
    e("a", "Piano"),
    e("b", "Pinball", { sub: "a game" }),
    e("c", "Website", { keywords: "piano shop" }),
    e("d", "Settings", { group: "Go to" }),
  ];

  it("returns everything without a query, and the best matches first with one", () => {
    expect(searchPalette(entries, "  ")).toEqual(entries);
    const found = searchPalette(entries, "piano").map((x) => x.key);
    expect(found[0]).toBe("a");
    // Found by its words too.
    expect(found).toContain("c");
    expect(found).not.toContain("d");
    expect(searchPalette(entries, "game").map((x) => x.key)).toEqual(["b"]);
  });

  it("puts what I chose lately higher", () => {
    const plain = searchPalette(entries, "pi").map((x) => x.key);
    expect(plain[0]).not.toBe("b");
    expect(searchPalette(entries, "pi", ["b"]).map((x) => x.key)[0]).toBe("b");
  });

  it("keeps a few of each group, so one long list doesn't hide the others", () => {
    const many = Array.from({ length: 20 }, (_, i) => e(`j${i}`, `Job ${i}`, { group: "Jobs" }));
    const found = searchPalette([...many, e("p", "Jobs page", { group: "Go to" })], "job");
    expect(found.filter((x) => x.group === "Jobs")).toHaveLength(8);
    expect(found.some((x) => x.group === "Go to")).toBe(true);
  });
});

describe("recent items", () => {
  beforeEach(() => localStorage.clear());

  it("remembers the places I open, newest first, once each, at most eight", () => {
    expect(recentItems()).toEqual([]);
    remember(e("a", "Piano", { sub: "~/Dev/piano" }));
    remember(e("b", "Pinball"));
    remember(e("a", "Piano", { sub: "~/Dev/piano" }));
    expect(recentItems().map((r) => r.key)).toEqual(["a", "b"]);
    expect(recentItems()[0]).toEqual({
      key: "a",
      label: "Piano",
      sub: "~/Dev/piano",
      href: "/x/a",
    });
    for (let i = 0; i < 12; i++) remember(e(`k${i}`, `K${i}`));
    expect(recentItems()).toHaveLength(8);
    // A control (no address) isn't a place to go back to.
    remember({ key: "do:x", group: "Controls", label: "Do", run: () => {} });
    expect(recentItems().some((r) => r.key === "do:x")).toBe(false);
  });

  it("survives what isn't a list in storage", () => {
    localStorage.setItem("oraknid.palette.recent", "{oops");
    expect(recentItems()).toEqual([]);
  });
});
