import type { Event } from "@oraknid/contracts";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { condense, eventKind, eventTitle, legOf } from "@/lib/events";
import { filterActivity, OverviewActivity } from "./overview-activity";

// The Overview's Activity stream (Web-UI → Overview): in words, filterable
// by job, Leg and kind, a Leg's output condensed to a line that opens.

afterEach(cleanup);

let seq = 0;
const ev = (type: string, payload: unknown, more: Partial<Event> = {}): Event => ({
  seq: ++seq,
  at: Date.UTC(2026, 9, 7, 10, 0, seq),
  type,
  topic: "overview",
  jobId: null,
  payload,
  actor: "oraknid",
  ...more,
});

const LONG = `I read the tests first.\n${"Then I changed the router so the page loads. ".repeat(6)}`;
const EVENTS = [
  ev("session.text", { sessionId: "s1", text: LONG }, { jobId: "J1", actor: "leg:L1" }),
  ev("task.state", { taskId: "t1", to: "running" }, { jobId: "J1", actor: "eye" }),
  ev("leg.health", { legId: "L2", to: "rate-limited" }),
  ev("inbox.opened", { title: "Run npm install" }, { jobId: "J2" }),
  ev("job.waiting-for-something", {}, { jobId: "J2" }),
];

describe("events in words", () => {
  it("names each kind and title, the Leg, and condenses long output", () => {
    expect(EVENTS.map(eventKind)).toEqual(["output", "task", "leg", "inbox", "job"]);
    expect(EVENTS.map(eventTitle)).toEqual([
      "Said",
      "Task",
      "Leg health",
      "Asks you",
      "Job waiting for something",
    ]);
    expect(EVENTS.map(legOf)).toEqual(["L1", null, "L2", null, null]);
    expect(condense(LONG)).toBe("I read the tests first. …");
    expect(condense("short")).toBeNull();
    expect(condense("x".repeat(200))).toBe(`${"x".repeat(140)}…`);
  });

  it("filters by job, by Leg and by kind", () => {
    const keys = (f: Parameters<typeof filterActivity>[1]) =>
      filterActivity(EVENTS, f).map((e) => e.type);
    expect(keys({ job: "J1", leg: "", kind: "" })).toEqual(["session.text", "task.state"]);
    expect(keys({ job: "", leg: "L2", kind: "" })).toEqual(["leg.health"]);
    expect(keys({ job: "", leg: "", kind: "inbox" })).toEqual(["inbox.opened"]);
    expect(keys({ job: "J1", leg: "L1", kind: "output" })).toEqual(["session.text"]);
    expect(keys({ job: "J2", leg: "L1", kind: "" })).toEqual([]);
  });
});

describe("the Activity card", () => {
  const jobs = [
    { id: "J1", title: "Build the piano" },
    { id: "J2", title: "Fix the site" },
  ];
  const legs = [
    { id: "L1", name: "Claude" },
    { id: "L2", name: "Codex" },
  ];

  it("shows each event in words, with its Leg and job, never its raw type as the title", () => {
    render(<OverviewActivity events={EVENTS} jobs={jobs} legs={legs} />);
    const lines = screen.getAllByTestId("activity-line");
    expect(lines).toHaveLength(5);
    const first = lines[0] as HTMLElement;
    expect(within(first).getByText("Said")).toBeTruthy();
    expect(within(first).getByText("Claude")).toBeTruthy();
    expect(within(first).getByText("Build the piano")).toBeTruthy();
    expect(screen.queryByText("session.text")).toBeNull();
  });

  it("condenses a Leg's output to a line that opens to all of it", () => {
    render(<OverviewActivity events={EVENTS} jobs={jobs} legs={legs} />);
    const line = screen.getAllByTestId("activity-line")[0] as HTMLDetailsElement;
    expect(line.tagName).toBe("DETAILS");
    expect(within(line).getByText("I read the tests first. …")).toBeTruthy();
    fireEvent.click(within(line).getByText("I read the tests first. …"));
    expect(line.textContent).toContain("Then I changed the router");
  });

  it("filters with its three selects, and says when nothing matches", () => {
    render(<OverviewActivity events={EVENTS} jobs={jobs} legs={legs} />);
    fireEvent.change(screen.getByLabelText("Only this job"), { target: { value: "J2" } });
    expect(screen.getAllByTestId("activity-line")).toHaveLength(2);
    fireEvent.change(screen.getByLabelText("Only this kind"), { target: { value: "inbox" } });
    expect(screen.getAllByTestId("activity-line")).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Only this Leg"), { target: { value: "L1" } });
    expect(screen.queryAllByTestId("activity-line")).toHaveLength(0);
    expect(screen.getByText("Nothing matches.")).toBeTruthy();
  });
});
