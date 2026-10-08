import type { InboxItem, JobView, TaskView } from "@oraknid/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

// A project's work bar (Web-UI → Projects → The work bar): what runs,
// waits or is paused in the project, how far it is, and Start, Pause,
// Resume, Cancel and Open job right there.

const start = vi.fn(async (_: unknown) => ({}));
const pause = vi.fn(async (_: unknown) => ({}));
const resume = vi.fn(async (_: unknown) => ({}));
const cancel = vi.fn(async (_: unknown) => ({}));

vi.mock("@/lib/api", () => ({
  api: {
    jobs: {
      start: (x: unknown) => start(x),
      pause: (x: unknown) => pause(x),
      resume: (x: unknown) => resume(x),
      cancel: (x: unknown) => cancel(x),
    },
  },
  message: (e: unknown) => String(e),
}));
vi.mock("@/pages/inbox", () => ({
  InboxItemCard: ({ item }: { item: InboxItem }) => (
    <div data-testid="inbox-card">{item.title}</div>
  ),
}));

const { ProjectWorkBar, goingJobs, duration } = await import("./project-now");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const task = (id: string, state: TaskView["state"], over: Partial<TaskView> = {}) =>
  ({ id, jobId: "J", title: `Task ${id}`, state, waitingReason: null, ...over }) as TaskView;

const job = (id: string, state: JobView["state"], over: Partial<JobView> = {}) =>
  ({
    id,
    projectId: "P",
    title: `Job ${id}`,
    description: null,
    state,
    tasks: [],
    queuedAt: null,
    startedAt: null,
    finishedAt: null,
    createdAt: 1,
    blockedReason: null,
    pauseReason: null,
    ...over,
  }) as unknown as JobView;

const question = (jobId: string, title: string): InboxItem =>
  ({ id: `Q-${title}`, jobId, kind: "question", title, state: "open" }) as InboxItem;

const draw = (jobs: JobView[], questions: InboxItem[] = []) => {
  const { hook } = memoryLocation({ path: "/projects/P" });
  return render(
    <Router hook={hook}>
      <ProjectWorkBar jobs={jobs} questions={questions} />
    </Router>,
  );
};

describe("the work bar of a project's page", () => {
  it("shows the job running: its state in words, its progress, the tasks worked on now and how long", () => {
    draw([
      job("A", "running", {
        startedAt: Date.now() - 12 * 60_000,
        tasks: [
          task("1", "done"),
          task("2", "skipped"),
          task("3", "running"),
          task("4", "pending"),
        ],
      }),
    ]);
    const bar = screen.getByRole("region", { name: "Current work" });
    expect(within(bar).getByText("Job A")).toBeTruthy();
    expect(within(bar).getByText("Running")).toBeTruthy();
    expect(within(bar).getByLabelText("2 of 4 tasks done")).toBeTruthy();
    expect(within(bar).getByText("2/4 tasks")).toBeTruthy();
    expect(within(bar).getByText("Now: Task 3")).toBeTruthy();
    expect(within(bar).getByText("12 min")).toBeTruthy();
    expect(
      within(bar).getByRole("link", { name: "Open the job “Job A”" }).getAttribute("href"),
    ).toBe("/projects/P/work/A");
    // A job going can be paused, not resumed or started.
    expect(within(bar).queryByRole("button", { name: /Resume/ })).toBeNull();
    expect(within(bar).queryByRole("button", { name: /Start/ })).toBeNull();
  });

  it("pauses a job going and resumes one paused", async () => {
    draw([job("A", "running"), job("B", "paused", { pauseReason: "Paused by me." })]);
    fireEvent.click(screen.getByRole("button", { name: "Pause “Job A”" }));
    await waitFor(() => expect(pause).toHaveBeenCalledWith({ id: "A" }));
    fireEvent.click(screen.getByRole("button", { name: "Resume “Job B”" }));
    await waitFor(() => expect(resume).toHaveBeenCalledWith({ id: "B" }));
    expect(screen.getByText("Resume when you're ready.")).toBeTruthy();
  });

  it("cancels only once I confirm, as the chat's Cancel does", async () => {
    draw([job("A", "running")]);
    fireEvent.click(screen.getByRole("button", { name: "Cancel “Job A”" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Cancel “Job A”?")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep it" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(cancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel “Job A”" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel the job" }),
    );
    await waitFor(() =>
      expect(cancel).toHaveBeenCalledWith({
        id: "A",
        reason: "Cancelled from the project's page.",
      }),
    );
  });

  it("starts a draft from the project's page, and opens it on New work", async () => {
    draw([job("D", "draft")]);
    expect(screen.getByText("A draft, not started")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Cancel/ })).toBeNull();
    expect(screen.getByRole("link", { name: "Open the draft “Job D”" }).getAttribute("href")).toBe(
      "/new/D",
    );
    fireEvent.click(screen.getByRole("button", { name: "Start “Job D”" }));
    await waitFor(() => expect(start).toHaveBeenCalledWith({ id: "D" }));
  });

  it("says why a job is blocked, clipped, and what to do", () => {
    const why = `The tests fail: ${"x".repeat(800)}`;
    draw([job("A", "blocked", { blockedReason: why })]);
    const reason = screen.getByTestId("work-reason");
    expect(reason.textContent?.startsWith("The tests fail: xxx")).toBe(true);
    expect((reason.textContent ?? "").length).toBeLessThan(220);
    expect((reason.getAttribute("title") ?? "").length).toBeLessThan(700);
    expect(screen.getByText("Fix what it says, then Resume.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resume “Job A”" })).toBeTruthy();
  });

  it("puts what a job asks me in reach, answered in place", () => {
    draw(
      [job("A", "interviewing")],
      [question("A", "Interview, round 1"), question("B", "Another job's")],
    );
    expect(screen.getByText("The Eye asks you about it first")).toBeTruthy();
    expect(screen.getByTestId("work-reason").textContent).toBe("It asks you: Interview, round 1");
    expect(screen.queryByTestId("inbox-card")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    expect(screen.getAllByTestId("inbox-card").map((x) => x.textContent)).toEqual([
      "Interview, round 1",
    ]);
  });

  it("lists several jobs, each with its own controls: working first, then waiting, blocked, paused, drafts", () => {
    draw([
      job("D", "draft", { createdAt: 6 }),
      job("P", "paused", { createdAt: 5 }),
      job("A", "running", { createdAt: 2 }),
      job("X", "blocked", { createdAt: 7 }),
      job("B", "waiting", { createdAt: 3 }),
      job("C", "completed", { createdAt: 4 }),
    ]);
    expect(screen.getByText("5 jobs not ended")).toBeTruthy();
    expect(screen.getByText("· 1 working")).toBeTruthy();
    const items = screen.getAllByTestId("work-item");
    expect(items.map((x) => within(x).getAllByRole("link")[0]?.textContent)).toEqual([
      "Job A",
      "Job B",
      "Job X",
      "Job P",
      "Job D",
    ]);
    expect(
      within(items[1] as HTMLElement).getByRole("button", { name: "Pause “Job B”" }),
    ).toBeTruthy();
    expect(
      within(items[2] as HTMLElement).getByRole("button", { name: "Resume “Job X”" }),
    ).toBeTruthy();
    expect(
      within(items[4] as HTMLElement).getByRole("button", { name: "Start “Job D”" }),
    ).toBeTruthy();
  });

  it("folds several jobs to their one line when asked, and opens them again", () => {
    const { hook } = memoryLocation({ path: "/projects/P/work/A" });
    render(
      <Router hook={hook}>
        <ProjectWorkBar
          jobs={[job("A", "running"), job("B", "paused")]}
          questions={[]}
          defaultFolded
        />
      </Router>,
    );
    const toggle = screen.getByRole("button", { name: /2 jobs not ended/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "Pause “Job A”" })).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Pause “Job A”" })).toBeTruthy();
  });

  it("says the last job in one line when nothing is going, and nothing before any job", () => {
    const { container } = draw([]);
    expect(container.textContent).toBe("");
    cleanup();
    draw([job("A", "completed", { finishedAt: Date.now() - 60_000 })]);
    expect(screen.getByText("Nothing running. Last:")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Job A" })).toBeTruthy();
  });

  it("orders and words what it shows", () => {
    expect(goingJobs([job("C", "cancelled"), job("A", "paused")]).map((j) => j.id)).toEqual(["A"]);
    expect(duration(45_000)).toBe("45 s");
    expect(duration(3 * 3600_000 + 5 * 60_000)).toBe("3 h 5 min");
    expect(duration(2 * 86400_000 + 4 * 3600_000)).toBe("2 d 4 h");
  });
});
