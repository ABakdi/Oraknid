import type { JobView } from "@oraknid/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Jobs-and-Projects → A job's name and description: the job's header and its rows.

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const renamed: unknown[] = [];
vi.mock("@/lib/api", () => ({
  api: {
    jobs: {
      rename: async (x: unknown) => {
        renamed.push(x);
      },
    },
  },
  message: (e: unknown) => String(e),
}));

const { JobGoal, JobTitle } = await import("./job-heading");
const { WorkRow, workflowJobs } = await import("./project-work");

afterEach(() => {
  cleanup();
  renamed.length = 0;
});

const GOAL = "now you shoudl take a look and make sure everything is im…\n\nand push it";

const job = (o: Partial<JobView> = {}) =>
  ({
    id: "J1",
    projectId: "P1",
    title: "Ship Phase 2 to GitHub",
    description: "Pushes Phase 2 to the project's GitHub repo.",
    namedBy: "eye",
    describedAs: "purpose",
    goal: GOAL,
    state: "running",
    tasks: [],
    tokens: 1200,
    branch: "oraknid/job-1",
    startedAt: Date.now(),
    queuedAt: null,
    blockedReason: null,
    pauseReason: null,
    ...o,
  }) as JobView;

describe("the job's header", () => {
  it("shows the name and the description, and renames with the pencil", async () => {
    render(<JobTitle job={job()} />);
    expect(screen.getByRole("heading").textContent).toBe("Ship Phase 2 to GitHub");
    expect(screen.getByText("Pushes Phase 2 to the project's GitHub repo.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Rename the job" }));
    const name = await screen.findByLabelText("Name");
    expect((name as HTMLInputElement).value).toBe("Ship Phase 2 to GitHub");
    fireEvent.change(name, { target: { value: "  Phase 2,   pushed " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    // Only what changed is sent.
    await waitFor(() => expect(renamed).toEqual([{ id: "J1", title: "Phase 2, pushed" }]));
  });

  it("sends a description cleared, and nothing when nothing changed", async () => {
    render(<JobTitle job={job()} />);
    fireEvent.click(screen.getByRole("button", { name: "Rename the job" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    await new Promise((r) => setTimeout(r, 10));
    expect(renamed).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Rename the job" }));
    fireEvent.change(await screen.findByLabelText("Description"), { target: { value: " " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(renamed).toEqual([{ id: "J1", description: "" }]));
  });

  it("says a job not named yet will be", () => {
    render(<JobTitle job={job({ title: "now you shoudl…", description: null, namedBy: null })} />);
    expect(screen.getByText(/names and describes it as soon as a model can/)).toBeTruthy();
  });

  it("folds my goal, as I wrote it, under the description", () => {
    render(<JobGoal goal={GOAL} />);
    const toggle = screen.getByRole("button", { name: "What I asked" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("job-goal")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("job-goal").textContent).toBe(GOAL);
    fireEvent.click(toggle);
    expect(screen.queryByTestId("job-goal")).toBeNull();
  });
});

describe("a job's rows", () => {
  it("shows Work's row with its name and description", () => {
    render(
      <ol>
        <WorkRow
          job={job({ state: "completed", describedAs: "outcome", description: "Pushed." })}
        />
      </ol>,
    );
    expect(screen.getByRole("link", { name: "Ship Phase 2 to GitHub" })).toBeTruthy();
    expect(screen.getByTestId("job-description").textContent).toBe("Pushed.");
  });

  it("leaves the description out of a row without one", () => {
    render(
      <ol>
        <WorkRow job={job({ description: null })} />
      </ol>,
    );
    expect(screen.queryByTestId("job-description")).toBeNull();
  });

  it("gives the Workflow's boxes the description", () => {
    expect(workflowJobs([job()])[0]?.description).toBe(
      "Pushes Phase 2 to the project's GitHub repo.",
    );
  });
});
