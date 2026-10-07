import type { MetricsSample, ProcessMetrics } from "@oraknid/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Overview → Resources (Web-UI): per Leg and per process, and a sparkline
// opens its full chart over a time range.

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const asked: number[] = [];
vi.mock("@/lib/api", () => ({
  api: {
    metrics: {
      recent: async ({ since }: { since: number }) => {
        asked.push(since);
        return [];
      },
    },
  },
  message: (e: unknown) => String(e),
}));

const { groupProcesses, pointsOf, processMeasures, ResourcesCard, SYSTEM_MEASURES } = await import(
  "./overview-resources"
);

afterEach(cleanup);

const proc = (id: string, label: string, more: Partial<ProcessMetrics> = {}): ProcessMetrics => ({
  id,
  label,
  pid: 100,
  processes: 1,
  cpuPercent: 10,
  rssBytes: 100 << 20,
  readBytesPerSec: 0,
  writeBytesPerSec: 0,
  vramBytes: 0,
  ...more,
});
const PROCS = [
  proc("daemon", "Oraknid daemon", { cpuPercent: 2 }),
  proc("s1", "Claude · Build the piano", { cpuPercent: 50, processes: 3 }),
  proc("s2", "Claude · Fix the site", { cpuPercent: 20, readBytesPerSec: 2048 }),
  proc("s3", "Codex · Docs", { cpuPercent: 5 }),
  proc("model:m1", "Model · qwen3-8b", { cpuPercent: 30, vramBytes: 4 * 2 ** 30 }),
];
const SESSIONS = [
  { sessionId: "s1", legId: "L1" },
  { sessionId: "s2", legId: "L1" },
  { sessionId: "s3", legId: "L2" },
];
const LEGS = [
  { id: "L1", name: "Claude" },
  { id: "L2", name: "Codex" },
];

const sample = (at: number, cpu: number): MetricsSample => ({
  at,
  system: {
    cpuPercent: cpu,
    cores: 8,
    memoryUsedBytes: 8 * 2 ** 30,
    memoryTotalBytes: 16 * 2 ** 30,
    diskReadBytesPerSec: 0,
    diskWriteBytesPerSec: 1024,
    netRxBytesPerSec: 2048,
    netTxBytesPerSec: 0,
  },
  gpus: [],
  processes: PROCS,
});

describe("processes per Leg", () => {
  it("puts each session's process under its Leg, local models and Oraknid's own apart", () => {
    const groups = groupProcesses(PROCS, SESSIONS, LEGS);
    expect(groups.map((g) => g.name)).toEqual(["Claude", "Local models", "Codex", "Oraknid"]);
    const claude = groups[0];
    expect(claude?.processes.map((p) => p.id)).toEqual(["s1", "s2"]);
    expect(claude?.cpuPercent).toBe(70);
    expect(claude?.rssBytes).toBe(200 << 20);
    expect(claude?.ioBytesPerSec).toBe(2048);
    expect(groups[1]?.vramBytes).toBe(4 * 2 ** 30);
  });

  it("reads a measure's points from the samples, skipping where it has none", () => {
    const [cpu] = processMeasures({ id: "s1", label: "x" });
    const samples = [sample(1, 5), { ...sample(2, 6), processes: [] }, sample(3, 7)];
    expect(pointsOf(samples, cpu as never)).toEqual([
      { t: 1, v: 50 },
      { t: 3, v: 50 },
    ]);
    expect(pointsOf(samples, SYSTEM_MEASURES[0] as never).map((p) => p.v)).toEqual([5, 6, 7]);
  });
});

describe("the Resources card", () => {
  it("lists the processes per Leg with CPU, RAM, VRAM and disk", () => {
    render(<ResourcesCard samples={[sample(Date.now(), 12)]} sessions={SESSIONS} legs={LEGS} />);
    const groups = screen.getByTestId("process-groups");
    expect(within(groups).getByText("Claude")).toBeTruthy();
    expect(within(groups).getByText("Local models")).toBeTruthy();
    const rows = screen.getAllByTestId("process-row");
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.textContent).join("\n")).toContain("VRAM 4.0 GiB");
    expect(rows.map((r) => r.textContent).join("\n")).toContain("2 KiB/s ↓");
  });

  it("opens a sparkline's full chart, and asks the daemon for the range I pick", async () => {
    const now = Date.now();
    render(
      <ResourcesCard
        samples={[sample(now - 2000, 10), sample(now - 1000, 12)]}
        sessions={SESSIONS}
        legs={LEGS}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "CPU: the full chart" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Now: 12%")).toBeTruthy();
    await waitFor(() => expect(asked).toHaveLength(1));
    expect(now - (asked[0] as number)).toBeGreaterThan(14 * 60_000);
    fireEvent.click(within(dialog).getByRole("button", { name: "1 hour" }));
    await waitFor(() => expect(asked).toHaveLength(2));
    expect(now - (asked[1] as number)).toBeGreaterThan(59 * 60_000);
    cleanup();
    // A process's number opens its own chart.
    render(<ResourcesCard samples={[sample(now, 12)]} sessions={SESSIONS} legs={LEGS} />);
    fireEvent.click(screen.getAllByTitle("RAM over time")[0] as HTMLElement);
    expect(
      within(await screen.findByRole("dialog")).getByText("Claude · Build the piano · RAM"),
    ).toBeTruthy();
  });
});
