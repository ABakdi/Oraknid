import type { JobView, ProjectView } from "@oraknid/contracts";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Route, Router, Switch } from "wouter";
import { memoryLocation } from "wouter/memory-location";

// Projects (Web-UI → Projects): the list, full width, each project saying
// what it does now; a click opens the project as a page of its own, with
// its work bar and a way back; deep links and old addresses keep working.

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const project = (id: string, name: string, over: Partial<ProjectView> = {}): ProjectView => ({
  id,
  name,
  workspacePath: `/home/me/${name}`,
  isGitRepo: true,
  shadow: false,
  releaseBranch: "main",
  workBranch: "dev",
  createdAt: 1,
  archivedAt: null,
  serverId: null,
  archivedWith: null,
  skillIds: [],
  serverIds: [],
  serverRoles: {},
  repos: [],
  github: null,
  jobCount: 1,
  lastActivityAt: null,
  now: [],
  ...over,
});

const PIANO = project("P1", "piano", {
  lastActivityAt: Date.now() - 60_000,
  serverIds: ["S1"],
  now: [
    {
      id: "J1",
      title: "Add login",
      state: "running",
      done: 1,
      total: 4,
      queued: false,
      startedAt: Date.now() - 120_000,
    },
  ],
});
const BLOG = project("P2", "blog", { createdAt: 2 });
const OLD = project("P3", "old site", { archivedAt: 5 });

const JOB = {
  id: "J1",
  projectId: "P1",
  title: "Add login",
  description: null,
  state: "running",
  tasks: [
    { id: "t1", title: "Schema", state: "done" },
    { id: "t2", title: "Form", state: "running" },
  ],
  queuedAt: null,
  startedAt: Date.now() - 120_000,
  finishedAt: null,
  createdAt: 1,
  blockedReason: null,
  pauseReason: null,
} as unknown as JobView;

vi.mock("@/lib/api", () => ({
  api: {
    projects: { list: () => [PIANO, BLOG, OLD] },
    jobs: { list: ({ projectId }: { projectId: string }) => (projectId === "P1" ? [JOB] : []) },
    inbox: { list: () => [] },
  },
  message: (e: unknown) => String(e),
}));
// The data comes at once, as it would once loaded.
vi.mock("@/lib/live", () => ({
  useLive: (load: () => unknown) => ({ data: load(), loading: false, error: null, reload() {} }),
  useEvents: () => [],
}));
vi.mock("@/components/ci-badge", () => ({ ProjectCiBadge: () => null }));
vi.mock("@/components/eye-chat", () => ({ EyeChat: () => <div>The Eye's conversation</div> }));
vi.mock("@/components/project-work", () => ({
  currentJob: () => undefined,
  ProjectWork: () => <div>Its jobs</div>,
  ProjectWorkflow: () => <div>Its workflow</div>,
}));

const { ProjectsPage } = await import("./projects");

afterEach(cleanup);

const open = (path: string) => {
  const memory = memoryLocation({ path, record: true });
  render(
    <Router hook={memory.hook}>
      <Switch>
        <Route path="/projects/:id?/:tab?/:job?/:sub?">
          {(p) => <ProjectsPage id={p.id} tab={p.tab} job={p.job} sub={p.sub} />}
        </Route>
      </Switch>
    </Router>,
  );
  return memory;
};

describe("Projects", () => {
  it("lists the projects full width, each saying what it does now", () => {
    open("/projects");
    const list = screen.getByRole("list", { name: "Projects" });
    const cards = within(list).getAllByRole("listitem");
    // The newest activity first; the archived one folded away.
    expect(cards.map((c) => within(c).getAllByRole("button")[0]?.textContent)).toEqual([
      "piano",
      "blog",
    ]);
    const piano = cards[0] as HTMLElement;
    expect(within(piano).getByText("Add login")).toBeTruthy();
    expect(within(piano).getByLabelText("1 of 4 tasks done")).toBeTruthy();
    expect(within(piano).getByText("1 server(s)")).toBeTruthy();
    expect(within(cards[1] as HTMLElement).getByText("Nothing running now.")).toBeTruthy();
    expect(screen.queryByText("old site")).toBeNull();
    expect(screen.getByText("2 project(s) · 1 working now")).toBeTruthy();
  });

  it("finds a project by its name, folder or repos, archived ones too", () => {
    open("/projects");
    fireEvent.change(screen.getByRole("searchbox", { name: "Find a project" }), {
      target: { value: "site" },
    });
    expect(screen.getByText("old site")).toBeTruthy();
    expect(screen.queryByText("piano")).toBeNull();
    fireEvent.change(screen.getByRole("searchbox", { name: "Find a project" }), {
      target: { value: "nothing like it" },
    });
    expect(screen.getByText("No project matches “nothing like it”.")).toBeTruthy();
  });

  it("opens a project as a page of its own, with its work bar and a way back", () => {
    const memory = open("/projects");
    act(() => fireEvent.click(screen.getByRole("button", { name: "piano" })));
    expect(memory.history?.at(-1)).toBe("/projects/P1");
    // No list beside it.
    expect(screen.queryByRole("list", { name: "Projects" })).toBeNull();
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(screen.getByRole("heading", { name: "piano" })).toBeTruthy();
    const bar = screen.getByRole("region", { name: "Current work" });
    expect(within(bar).getByText("Now: Form")).toBeTruthy();
    expect(within(bar).getByRole("button", { name: "Pause “Add login”" })).toBeTruthy();
    expect(within(bar).getByRole("button", { name: "Cancel “Add login”" })).toBeTruthy();
    expect(screen.getByText("The Eye's conversation")).toBeTruthy();
    act(() => fireEvent.click(screen.getByRole("link", { name: "All projects" })));
    expect(memory.history?.at(-1)).toBe("/projects");
    expect(screen.getByRole("list", { name: "Projects" })).toBeTruthy();
  });

  it("keeps deep links and old addresses working", () => {
    open("/projects/P1/work/J1");
    expect(screen.getByRole("tab", { name: /Work/, selected: true })).toBeTruthy();
    expect(screen.getByText("Its jobs")).toBeTruthy();
    cleanup();
    const memory = open("/projects/P1/web");
    expect(memory.history?.at(-1)).toBe("/projects/P1/workflow");
    expect(screen.getByText("Its workflow")).toBeTruthy();
    cleanup();
    open("/projects/nope");
    expect(screen.getByText("No such project")).toBeTruthy();
  });
});
