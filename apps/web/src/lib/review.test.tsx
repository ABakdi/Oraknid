import type { Event, ReviewNote } from "@oraknid/contracts";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The review page's pieces (ADR-064): devices, fitting, pins, and a new
// tab when the daemon says a review is ready.

const listeners = new Set<(e: Event) => void>();
vi.mock("./live", () => ({
  live: {
    subscribe: () => () => {},
    on: (l: (e: Event) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  },
}));
const toast = Object.assign(vi.fn(), { success: vi.fn() });
vi.mock("sonner", () => ({ toast }));

const { byDevice, customDevice, DEVICES, fitScale, pinsFor, screenFor, turn, useReviewOpener } =
  await import("./review");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  toast.mockClear();
  toast.success.mockClear();
  localStorage.clear();
});

const laptop = { name: "Laptop", width: 1440, height: 900, orientation: "landscape" as const };
const phone = { name: "Phone", width: 390, height: 844, orientation: "portrait" as const };
const note = (id: string, over: Partial<ReviewNote> = {}): ReviewNote => ({
  id,
  reviewId: "R",
  round: 1,
  kind: "change",
  text: id,
  device: laptop,
  element: { selector: `#${id}`, text: "", tag: "div", box: { x: 0, y: 0, width: 1, height: 1 } },
  page: "/",
  hasScreenshot: false,
  console: [],
  requests: [],
  source: "page",
  createdAt: 1,
  editedAt: null,
  ...over,
});

describe("devices and fitting", () => {
  it("has the presets, turns them, and takes a size of my own within bounds", () => {
    expect(DEVICES.map((d) => `${d.name} ${d.width}×${d.height}`)).toEqual([
      "Phone 390×844",
      "Phone 844×390",
      "Tablet 820×1180",
      "Tablet 1180×820",
      "Laptop 1440×900",
      "Desktop 1920×1080",
    ]);
    expect(turn(phone)).toEqual({ ...phone, width: 844, height: 390, orientation: "landscape" });
    expect(customDevice(1000, 700)).toMatchObject({
      width: 1000,
      height: 700,
      orientation: "landscape",
    });
    expect(customDevice(50, 700)).toBeNull();
    expect(customDevice(Number.NaN, 700)).toBeNull();
  });

  it("scales the frame down to fit the stage, never up", () => {
    expect(fitScale({ width: 1920, height: 1080 }, { width: 984, height: 1000 })).toBeCloseTo(
      0.5,
      2,
    );
    expect(fitScale({ width: 390, height: 844 }, { width: 1400, height: 900 })).toBe(1);
    expect(fitScale({ width: 390, height: 844 }, { width: 0, height: 0 })).toBe(1);
  });
});

describe("pins and groups", () => {
  it("pins this round's notes on an element, on this device and page, numbered as listed", () => {
    const notes = [
      note("a"),
      note("b", { device: phone }),
      note("c", { element: null, kind: "general" }),
      note("d", { page: "/settings" }),
      note("e", { round: 0 }),
      note("f"),
    ];
    const pins = pinsFor(notes, 1, laptop, "/", "f");
    expect(pins.map((p) => [p.id, p.n, p.active])).toEqual([
      ["a", 1, false],
      ["f", 5, true],
    ]);
  });

  it("groups notes by device, the general ones last", () => {
    const g = byDevice([note("a"), note("b", { device: null }), note("c", { device: phone })]);
    expect(g.map((x) => [x.label, x.notes.length])).toEqual([
      ["Laptop 1440×900", 1],
      ["Phone 390×844", 1],
      ["Any device", 1],
    ]);
  });
});

function Opener() {
  useReviewOpener();
  return null;
}
const opened = (id: string, at = Date.now(), seq = 7): Event => ({
  seq,
  at,
  type: "review.opened",
  topic: "inbox",
  jobId: null,
  payload: { id, kind: "design", url: `/review/${id}` },
  actor: "oraknid",
});
const emit = (e: Event) => {
  for (const l of listeners) l(e);
};

describe("opening a review in a new tab", () => {
  it("opens it once, and offers it when the browser blocks the tab", () => {
    const open = vi.spyOn(window, "open").mockReturnValue({} as Window);
    render(<Opener />);
    emit(opened("R1"));
    emit(opened("R1"));
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith("/review/R1", "review-R1");
    open.mockReturnValue(null);
    emit(opened("R2", Date.now(), 8));
    expect(toast).toHaveBeenCalledWith(
      "A design is ready for your review",
      expect.objectContaining({ action: expect.objectContaining({ label: "Open" }) }),
    );
  });

  it("doesn't open one replayed long after it opened", () => {
    const open = vi.spyOn(window, "open").mockReturnValue({} as Window);
    render(<Opener />);
    emit(opened("R3", Date.now() - 5 * 60_000));
    expect(open).not.toHaveBeenCalled();
  });
});

describe("the screen that fits a device (2026-10-10)", () => {
  const screens = (profiles: string[], index = false) => ({
    index,
    screens: profiles.map((p) => ({ path: `/${p}.html`, name: p, profile: p as "other" })),
  });
  const at = (i: number) => DEVICES[i] as (typeof DEVICES)[number];
  it("picks the design's page for each device", () => {
    const keys = screens(["desktop", "phone-landscape", "phone-portrait"]);
    expect(DEVICES.map((d) => screenFor(keys, d))).toEqual([
      "/phone-portrait.html",
      "/phone-landscape.html",
      "/phone-portrait.html",
      "/desktop.html",
      "/desktop.html",
      "/desktop.html",
    ]);
    const all = screens(["phone", "tablet", "laptop", "desktop"]);
    expect(DEVICES.map((d) => screenFor(all, d))).toEqual([
      "/phone.html",
      "/phone.html",
      "/tablet.html",
      "/tablet.html",
      "/laptop.html",
      "/desktop.html",
    ]);
  });
  it("leaves the frame alone without pages per device", () => {
    expect(screenFor(null, at(0))).toBeNull();
    expect(screenFor(screens(["about", "contact"].map(() => "other")), at(0))).toBeNull();
    // Pages for a phone only, an index.html: a desktop shows the index.
    expect(screenFor(screens(["phone-portrait"], true), at(5))).toBe("/");
  });
});
