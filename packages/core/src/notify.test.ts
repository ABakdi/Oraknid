import { describe, expect, it } from "vitest";
import { DEFAULT_ROUTES, heldByQuietHours, inQuietHours, routeFor } from "./notify.ts";

describe("notification routing", () => {
  it("follows the spec's table by default, and my changes win", () => {
    expect(DEFAULT_ROUTES.approval).toEqual({ desktop: true, push: true, email: "after-15-min" });
    expect(DEFAULT_ROUTES["leg.unavailable"]).toEqual({
      desktop: false,
      push: false,
      email: "never",
    });
    expect(routeFor("budget", { budget: { desktop: false, push: true, email: "now" } })).toEqual({
      desktop: false,
      push: true,
      email: "now",
    });
  });

  it("knows quiet hours, across midnight too", () => {
    const at = (h: number, m = 0) => new Date(2026, 9, 1, h, m);
    const night = { from: "22:00", to: "07:00" };
    expect(inQuietHours(night, at(23))).toBe(true);
    expect(inQuietHours(night, at(6, 59))).toBe(true);
    expect(inQuietHours(night, at(7))).toBe(false);
    expect(inQuietHours({ from: "12:00", to: "13:00" }, at(12, 30))).toBe(true);
    expect(inQuietHours(null, at(3))).toBe(false);
  });

  it("holds everything in quiet hours except approvals for running jobs", () => {
    expect(heldByQuietHours("approval", true, true)).toBe(false);
    expect(heldByQuietHours("approval", false, true)).toBe(true);
    expect(heldByQuietHours("job.completed", true, true)).toBe(true);
    expect(heldByQuietHours("job.completed", true, false)).toBe(false);
  });
});
