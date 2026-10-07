import type { CiJob, CiLog, CiRun, CiWorkflow } from "@oraknid/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

// GitHub Actions in Oraknid (ADR-058): runs, a run's jobs, its log by step,
// re-running and running a workflow by hand.

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const run = (id: number, more: Partial<CiRun> = {}): CiRun => ({
  id,
  name: "CI",
  title: `A change ${id}`,
  workflowId: 11,
  branch: "dev",
  sha: `${id}`.padEnd(40, "a"),
  event: "push",
  status: "completed",
  conclusion: "success",
  attempt: 1,
  actor: "me",
  startedAt: new Date(Date.now() - 120_000).toISOString(),
  updatedAt: new Date(Date.now() - 60_000).toISOString(),
  durationMs: 72_000,
  url: `https://github.com/me/piano/actions/runs/${id}`,
  pullRequests: [],
  ...more,
});

const step = (number: number, name: string, conclusion: "success" | "failure" = "success") => ({
  number,
  name,
  status: "completed" as const,
  conclusion,
  startedAt: null,
  completedAt: null,
});

const job = (id: number, name: string, failing: boolean): CiJob => ({
  id,
  name,
  status: "completed",
  conclusion: failing ? "failure" : "success",
  startedAt: null,
  completedAt: null,
  durationMs: 30_000,
  url: null,
  steps: [step(1, "Set up job"), step(2, "Run tests", failing ? "failure" : "success")],
  failingStep: failing ? "Run tests" : null,
});

const LOG: CiLog = {
  jobId: 1003,
  jobName: "test",
  matchCount: 0,
  truncated: false,
  sections: [
    {
      number: 2,
      name: "Run tests",
      conclusion: "failure",
      failing: true,
      lines: [
        "##[group]Run pnpm test",
        "AssertionError: expected 100 to be 120",
        "##[error]exit 1",
      ],
      cut: 0,
      matches: [],
    },
    {
      number: 1,
      name: "Set up job",
      conclusion: "success",
      failing: false,
      lines: ["Current runner version"],
      cut: 0,
      matches: [],
    },
  ],
};

const DEPLOY: CiWorkflow = {
  id: 12,
  name: "Deploy",
  path: ".github/workflows/deploy.yml",
  state: "active",
  dispatch: true,
  inputs: [
    {
      name: "environment",
      description: "Where to",
      required: false,
      type: "choice",
      default: "staging",
      options: ["staging", "production"],
    },
    {
      name: "dry_run",
      description: "",
      required: false,
      type: "boolean",
      default: "true",
      options: [],
    },
    {
      name: "note",
      description: "Why",
      required: true,
      type: "string",
      default: null,
      options: [],
    },
  ],
};

const calls: string[] = [];
const fn =
  <T,>(name: string, value: (x: Record<string, unknown>) => T) =>
  async (x: Record<string, unknown> = {}) => {
    calls.push(`${name} ${JSON.stringify(x)}`);
    return value(x);
  };

vi.mock("@/lib/api", () => ({
  api: {
    ci: {
      runs: fn("runs", () => ({
        items: [run(102, { conclusion: "failure" }), run(101, { branch: "main" })],
        page: 1,
        next: false,
        total: 2,
        stale: false,
        retryAt: null,
      })),
      run: fn("run", () => ({
        ...run(102, { conclusion: "failure" }),
        jobs: [job(1002, "build", false), job(1003, "test", true)],
      })),
      log: fn("log", () => LOG),
      artifacts: fn("artifacts", () => [
        {
          id: 501,
          name: "coverage",
          sizeBytes: 2048,
          expired: false,
          createdAt: null,
          expiresAt: null,
        },
      ]),
      workflows: fn("workflows", () => [
        { ...DEPLOY, id: 11, name: "CI", dispatch: false },
        DEPLOY,
      ]),
      rerun: fn("rerun", () => undefined),
      cancel: fn("cancel", () => undefined),
      dispatch: fn("dispatch", () => undefined),
    },
  },
  message: (e: unknown) => String(e),
}));

const { CiRuns, duration } = await import("./ci-panel");
const { CiPill } = await import("./ci-badge");

afterEach(() => {
  cleanup();
  calls.length = 0;
});

const r = { owner: "me", name: "piano", account: "me" };
const hrefFor = (id?: number) => `/repos/me/piano/ci${id ? `/${id}` : ""}`;

function show(runId?: number) {
  const mem = memoryLocation({ path: hrefFor(runId), record: true });
  render(
    <Router hook={mem.hook}>
      <CiRuns r={r} defaultBranch="main" runId={runId} hrefFor={hrefFor} />
    </Router>,
  );
  return mem;
}

describe("a repository's runs (ADR-058)", () => {
  it("lists runs with their branch, commit, event, duration, each opening the run", async () => {
    show();
    const links = await screen.findAllByRole("link");
    const rows = links.filter((a) => a.getAttribute("href")?.startsWith("/repos/me/piano/ci/"));
    expect(rows.map((a) => a.getAttribute("href"))).toEqual([
      "/repos/me/piano/ci/102",
      "/repos/me/piano/ci/101",
    ]);
    expect(rows[0]?.textContent).toContain("A change 102");
    expect(rows[0]?.textContent).toContain("dev");
    expect(rows[0]?.textContent).toContain("102aaaa");
    expect(rows[0]?.textContent).toContain("1 min 12 s");
    expect(within(rows[0] as HTMLElement).getByLabelText("failed")).toBeTruthy();
    expect(duration(5_000)).toBe("5 s");
    expect(duration(3_900_000)).toBe("1 h 5 min");
  });

  it("runs a workflow by hand with its inputs, the required one asked", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Run workflow" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Deploy")).toBeTruthy();
    expect((within(dialog).getByLabelText("Branch or tag") as HTMLInputElement).value).toBe("main");
    fireEvent.change(within(dialog).getByLabelText(/note/), { target: { value: "ship it" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Run" }));
    await waitFor(() =>
      expect(calls).toContain(
        `dispatch ${JSON.stringify({
          ...r,
          workflowId: 12,
          ref: "main",
          inputs: { environment: "staging", dry_run: "true", note: "ship it" },
        })}`,
      ),
    );
  });
});

describe("a run (ADR-058)", () => {
  it("opens on the failing job, its failing step first and open, searchable", async () => {
    show(102);
    await screen.findByText("AssertionError: expected 100 to be 120");
    expect(screen.getByRole("button", { name: /test/, pressed: true })).toBeTruthy();
    const sections = document.querySelectorAll("details");
    expect(sections[0]?.textContent).toContain("Run tests");
    expect(sections[0]?.open).toBe(true);
    expect(sections[1]?.open).toBe(false);
    fireEvent.change(screen.getByLabelText("Search the log"), { target: { value: "assert" } });
    expect(screen.getByText("1 line matches.")).toBeTruthy();
    expect(document.querySelectorAll("details")).toHaveLength(1);
    // Its artifacts.
    expect(screen.getByText("coverage")).toBeTruthy();
    expect(screen.getByText("2 KiB")).toBeTruthy();
  });

  it("re-runs the failed jobs after saying what happens", async () => {
    show(102);
    fireEvent.click(await screen.findByRole("button", { name: "Re-run failed jobs" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("as attempt 2");
    fireEvent.click(within(dialog).getByRole("button", { name: "Re-run failed jobs" }));
    await waitFor(() =>
      expect(calls).toContain(`rerun ${JSON.stringify({ ...r, runId: 102, failedOnly: true })}`),
    );
  });
});

describe("the CI badge (ADR-058)", () => {
  it("says passing, failing or running and opens the CI tab", () => {
    const mem = memoryLocation({ path: "/" });
    render(
      <Router hook={mem.hook}>
        <CiPill
          href="/projects/P1/ci"
          badge={{
            state: "failing",
            branch: "dev",
            fullName: "me/piano",
            sha: "a".repeat(40),
            run: run(102, { conclusion: "failure" }),
            failing: "test → Run tests",
            error: null,
          }}
        />
      </Router>,
    );
    const pill = screen.getByRole("link", { name: /CI failing/ });
    expect(pill.getAttribute("href")).toBe("/projects/P1/ci");
    expect(pill.getAttribute("title")).toContain("Failing: test → Run tests");
  });
});
