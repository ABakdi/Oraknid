import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ChartsData, ChartsView, StatsCharts, span } from "./stats-charts";

// The charts beyond tokens over time (Web-UI → Charts).

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const DAY = 86400_000;
const T0 = Date.parse("2026-10-01T00:00:00.000Z");

const data: ChartsData = {
  bucketMs: DAY,
  throughput: [
    { t: T0, done: 3, failed: 1 },
    { t: T0 + DAY, done: 2, failed: 0 },
  ],
  byLeg: [
    {
      legId: "L1",
      leg: "Work",
      kind: "claude-code",
      succeeded: 3,
      failed: 1,
      other: 0,
      tokens: 90_000,
      ms: 3 * 3600_000,
      tokensPerVerified: 30_000,
      msPerVerified: 3600_000,
    },
    {
      legId: "L2",
      leg: "Ollama",
      kind: "openai-compatible",
      succeeded: 0,
      failed: 0,
      other: 0,
      tokens: 100,
      ms: 1000,
      tokensPerVerified: null,
      msPerVerified: null,
    },
  ],
  byKind: [{ kind: "code", succeeded: 1, failed: 2, other: 1 }],
  money: { total: 0, points: [] },
  burn: {
    limit: 100_000,
    hard: true,
    used: 90_000,
    points: [
      { t: T0, used: 40_000 },
      { t: T0 + DAY, used: 90_000 },
    ],
  },
};

const empty: ChartsData = {
  bucketMs: 3600_000,
  throughput: [],
  byLeg: [],
  byKind: [],
  money: { total: 0, points: [] },
  burn: null,
};

const charts = vi.fn(async (_: unknown) => data);
vi.mock("@/lib/api", () => ({
  message: (e: unknown) => String(e),
  api: {
    stats: { charts: (x: unknown) => charts(x) },
    legs: { list: async () => [] },
  },
}));

afterEach(cleanup);

const card = (title: string) => {
  const heading = screen.getByText(title);
  return heading.closest("[data-slot=card]") as HTMLElement;
};

describe("the charts (Web-UI → Charts)", () => {
  it("says a span of time shortly", () => {
    expect(span(45_000)).toBe("45s");
    expect(span(12 * 60_000)).toBe("12m");
    expect(span(65 * 60_000)).toBe("1h 5m");
    expect(span(2 * 3600_000)).toBe("2h");
  });

  it("draws throughput, success by Leg and by kind, the Legs compared and the burn", () => {
    render(<ChartsView data={data} burnTitle="The job's budget burn" />);
    // Throughput: its totals in the legend.
    const tp = card("Tasks done, per day");
    expect(within(tp).getByText("Tasks verified").nextSibling?.textContent).toBe("5");
    expect(within(tp).getByText("Attempts failed").nextSibling?.textContent).toBe("1");
    // By Leg: each with its avatar and its share verified; one still running.
    const legs = card("Success and failure by Leg");
    expect(within(legs).getByRole("img", { name: "Work" }).textContent).toBe("WO");
    expect(within(legs).getByText("75% of 4")).toBeTruthy();
    expect(within(legs).getByText("running")).toBeTruthy();
    // By kind.
    expect(within(card("Success and failure by task kind")).getByText("25% of 4")).toBeTruthy();
    // Legs compared: tokens and time per verified task, a dash before any.
    const cmp = card("Legs compared");
    expect(within(cmp).getByText("30k")).toBeTruthy();
    expect(within(cmp).getByText("1h")).toBeTruthy();
    expect(within(cmp).getAllByText("—")).toHaveLength(3);
    // Burn against the hard limit.
    const burn = card("The job's budget burn");
    expect(within(burn).getByText("Hard limit")).toBeTruthy();
    expect(within(burn).getByText(/90%/)).toBeTruthy();
    // No money counted: no cost chart.
    expect(screen.queryByText("Cost")).toBeNull();
  });

  it("shows the cost once money is counted", () => {
    render(
      <ChartsView data={{ ...data, money: { total: 1.5, points: [{ t: T0, money: 1.5 }] } }} />,
    );
    expect(within(card("Cost")).getByText("$1.50 spent")).toBeTruthy();
  });

  it("says when there is nothing yet, and leaves out the burn where there is no budget", () => {
    render(<ChartsView data={empty} />);
    expect(screen.getByText("Tasks done, per hour")).toBeTruthy();
    expect(screen.getAllByText("Nothing yet.")).toHaveLength(4);
    expect(screen.queryByText("Budget burn")).toBeNull();
  });

  it("says when no token limit is set", () => {
    render(
      <ChartsView
        data={{
          ...data,
          burn: { used: 5, points: [{ t: T0, used: 5 }], limit: null, hard: false },
        }}
      />,
    );
    expect(screen.getByText("No token limit is set.")).toBeTruthy();
  });

  it("loads a scope's numbers from the daemon", async () => {
    render(<StatsCharts projectId="P" since={5} bucketMs={DAY} topics={[]} />);
    await waitFor(() => expect(screen.getByTestId("stats-charts")).toBeTruthy());
    expect(charts).toHaveBeenCalledWith({
      jobId: undefined,
      projectId: "P",
      since: 5,
      bucketMs: DAY,
    });
  });
});
