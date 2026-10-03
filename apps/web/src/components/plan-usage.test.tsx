import type { LegPlanUsage, PlanWindowView } from "@oraknid/contracts";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { asOf, PlanUsageRows, planRows, resetIn, windowMark } from "./plan-usage";

// ADR-039: a Leg's plan usage in front of me.

const NOW = Date.parse("2026-10-03T12:00:00.000Z");
const MIN = 60_000;

const win = (name: string, utilization: number | null, observedAt = NOW - 4 * MIN) =>
  ({
    name,
    label: name === "five_hour" ? "5 hours" : name === "seven_day" ? "Week" : "Week, Opus",
    scope: name === "seven_day_opus" ? "model" : "account",
    utilization,
    resetsAt: NOW + 90 * MIN,
    estimated: false,
    observedAt,
    source: "usage",
    tokens: [],
  }) as PlanWindowView;

const leg = (name: string, kind: LegPlanUsage["kind"], windows: PlanWindowView[]) =>
  ({
    legId: name,
    name,
    kind,
    health: "healthy",
    windows,
    checkedAt: null,
    note: windows.length ? null : "A local model: no limits.",
  }) as LegPlanUsage;

const usage = [
  leg("Work", "claude-code", [win("five_hour", 0.3), win("seven_day", 0.55)]),
  leg("Ollama", "openai-compatible", []),
  leg("Max", "claude-code", [
    win("five_hour", 0.2, NOW - 2 * 3600_000),
    win("seven_day_opus", 1),
    win("seven_day", 0.85),
  ]),
  leg("Fresh", "claude-code", []),
];

describe("the Plan usage card (ADR-039)", () => {
  it("puts the Leg closest to a limit first, each Leg's fullest window first, and leaves out Legs with nothing to show", () => {
    const rows = planRows(usage);
    expect(rows.map((r) => r.name)).toEqual(["Max", "Work", "Fresh"]);
    expect(rows[0]?.windows.map((w) => w.name)).toEqual([
      "seven_day_opus",
      "seven_day",
      "five_hour",
    ]);
  });

  it("marks a window near its limit from 80% and at it from 100%", () => {
    expect(windowMark({ utilization: 0.79 })).toBeNull();
    expect(windowMark({ utilization: 0.8 })).toBe("near");
    expect(windowMark({ utilization: 1 })).toBe("at");
    expect(windowMark({ utilization: null })).toBeNull();
  });

  it("says when a window resets in hours, or days and hours past a day", () => {
    expect(resetIn(NOW + 90 * MIN, NOW)).toBe("in 1 h 30 min");
    expect(resetIn(NOW + (3 * 24 + 4) * 60 * MIN, NOW)).toBe("in 3 d 4 h");
    // Never "5 d 24 h".
    expect(resetIn(NOW + (5 * 24 + 23.8) * 60 * MIN, NOW)).toBe("in 6 d 0 h");
  });

  it("says how old each Leg's figures are, from its newest window", () => {
    expect(asOf(NOW - 20_000, NOW)).toBe("as of just now");
    expect(asOf(NOW - 4 * MIN, NOW)).toBe("as of 4 min ago");
    const { container } = render(<PlanUsageRows usage={usage} now={NOW} />);
    const rows = [...container.querySelectorAll("li[data-leg]")];
    expect(rows.map((r) => r.getAttribute("data-leg"))).toEqual(["Max", "Work", "Fresh"]);
    expect(rows.map((r) => r.querySelector("[data-age]")?.textContent)).toEqual([
      "as of 4 min ago",
      "as of 4 min ago",
      "",
    ]);
    const max = rows[0] as Element;
    expect(max.textContent).toContain("at limit");
    expect(
      [...max.querySelectorAll("[data-window]")].map((w) => w.getAttribute("data-window")),
    ).toEqual(["seven_day_opus", "seven_day", "five_hour"]);
    expect(max.querySelector("[data-window=seven_day]")?.textContent).toContain("85%");
    expect(max.querySelector("[data-window=seven_day]")?.textContent).toContain(
      "resets in 1 h 30 min",
    );
    // A Leg not read yet says so rather than showing nothing.
    expect(rows[2]?.textContent).toContain("A local model");
  });
});
