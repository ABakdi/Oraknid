import type { MachineHealth } from "@oraknid/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Parallel by default, admitted by resources (ADR-050): tasks at once, why a
// ready task waits, and the computer in danger.

vi.mock("@/lib/api", () => ({ api: {}, message: (e: unknown) => String(e) }));

const { atOnceLine, DangerBanner, HealthBody, TasksAtOnce } = await import("./machine-health");

afterEach(cleanup);

const health = (o: Partial<MachineHealth> = {}): MachineHealth => ({
  state: "ok",
  incidents: [],
  running: 4,
  limit: 6,
  limitIsAuto: true,
  pausedForRoom: [],
  reading: { memoryUsed: 0.5, cpu: 0.2, swapUsed: 0, memoryPressure: 0, diskFreeBytes: null },
  ...o,
});

describe("tasks at once in a job's header", () => {
  it("says how many run at once and why the others wait", () => {
    const tasks = [
      { state: "running", waitingReason: null },
      { state: "running", waitingReason: null },
      { state: "verifying", waitingReason: null },
      { state: "running", waitingReason: null },
      { state: "ready", waitingReason: "waiting for memory: 2.1 GB free, it may need 2.6 GB" },
      { state: "ready", waitingReason: "Claude busy with 3 sessions" },
      { state: "done", waitingReason: null },
    ];
    expect(atOnceLine(tasks)).toEqual({
      running: "4 tasks running at once",
      waiting: "2 waiting: waiting for memory: 2.1 GB free, it may need 2.6 GB",
    });
    render(<TasksAtOnce tasks={tasks} />);
    expect(screen.getByTestId("tasks-at-once").textContent).toContain("4 tasks running at once");
  });

  it("says one task, an overlap, and nothing at all when nothing runs or waits", () => {
    expect(
      atOnceLine([
        { state: "running" },
        { state: "ready", waitingReason: "overlaps “Write the login page”: both change src/auth" },
      ]),
    ).toEqual({
      running: "1 task running",
      waiting: "1 waiting: overlaps “Write the login page”: both change src/auth",
    });
    expect(atOnceLine([{ state: "done" }, { state: "pending" }])).toBeNull();
    const { container } = render(<TasksAtOnce tasks={[{ state: "done" }]} />);
    expect(container.textContent).toBe("");
  });
});

describe("the computer in danger", () => {
  it("shows a banner with what is happening and what Oraknid did, only in danger", () => {
    const danger = health({
      state: "danger",
      incidents: [
        {
          kind: "memory",
          level: "danger",
          message: "Memory and CPU are both nearly full (memory 96% used, CPU 98%).",
          did: "Paused “Build the API” to free memory; it resumes when memory is back.",
          since: 1,
        },
      ],
    });
    render(<DangerBanner health={danger} />);
    const banner = screen.getByRole("alert");
    expect(banner.textContent).toContain("Your computer is in danger");
    expect(banner.textContent).toContain("Memory and CPU are both nearly full");
    expect(banner.textContent).toContain("Paused “Build the API” to free memory");
    cleanup();
    render(<DangerBanner health={health({ state: "busy" })} />);
    expect(screen.queryByRole("alert")).toBeNull();
    render(<DangerBanner health={undefined} />);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the Overview's health: tasks at once, the reading, what was paused", () => {
    render(
      <HealthBody
        h={health({
          state: "busy",
          incidents: [
            {
              kind: "disk:the data folder",
              level: "warning",
              message: "The disk is nearly full: 1.2 GB free on the data folder.",
              did: null,
              since: 1,
            },
          ],
          pausedForRoom: [{ jobId: "J", taskId: "T", title: "Build the API" }],
        })}
      />,
    );
    expect(screen.getByText("Needs a look")).toBeTruthy();
    expect(
      screen.getByText("4 of at most 6 tasks running at once (decided by this computer)"),
    ).toBeTruthy();
    expect(screen.getByText(/Memory 50% used · CPU 20%/)).toBeTruthy();
    expect(screen.getByText(/1\.2 GB free on the data folder/)).toBeTruthy();
    expect(screen.getByText("Paused to make room: “Build the API”")).toBeTruthy();
  });
});
