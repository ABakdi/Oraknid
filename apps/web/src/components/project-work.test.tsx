import type { JobView, TaskView } from "@oraknid/contracts";
import { describe, expect, it, vi } from "vitest";
import { SHORTCUTS } from "@/components/shell";
import { currentProjectPath, jobHref, jobIdHref, oldJobTab } from "@/lib/links";
import {
  currentJob,
  readWorkflowMode,
  saveWorkflowMode,
  workflowHref,
  workflowJobs,
} from "./project-work";
import { stackFrames } from "./web-graph";

// ADR-034: the project is the place; jobs are its history.

const task = (id: string, jobId: string, state: TaskView["state"], dependsOn: string[] = []) =>
  ({ id, jobId, title: id, state, dependsOn }) as TaskView;

const job = (id: string, state: JobView["state"], tasks: TaskView[]) =>
  ({ id, projectId: "P", title: `Job ${id}`, state, tasks }) as JobView;

const a = job("A", "completed", [task("a1", "A", "done"), task("a2", "A", "done", ["a1"])]);
const b = job("B", "completed", [task("b1", "B", "done"), task("b2", "B", "failed")]);
const c = job("C", "running", [task("c1", "C", "running"), task("c2", "C", "pending", ["c1"])]);
const draft = job("D", "draft", []);

describe("a project's Workflow (ADR-034 → Changed)", () => {
  it("draws one box per job in the order they ran, each after the one before, the current one marked", () => {
    expect(workflowJobs([a, b, c, draft])).toEqual([
      {
        id: "A",
        title: "Job A",
        state: "completed",
        done: 2,
        total: 2,
        current: false,
        dependsOn: [],
      },
      {
        id: "B",
        title: "Job B",
        state: "completed",
        done: 1,
        total: 2,
        current: false,
        dependsOn: ["A"],
      },
      {
        id: "C",
        title: "Job C",
        state: "running",
        done: 0,
        total: 2,
        current: true,
        dependsOn: ["B"],
      },
    ]);
  });

  it("marks the newest job once every job has ended, and never draws a draft", () => {
    expect(currentJob([a, b, draft])?.id).toBe("B");
    expect(currentJob([draft])).toBeUndefined();
    expect(workflowJobs([a, b, draft]).map((x) => [x.id, x.current])).toEqual([
      ["A", false],
      ["B", true],
    ]);
    expect(workflowJobs([draft])).toEqual([]);
  });

  it("puts a drilled-in job in the address, and keeps the old /web addresses working", () => {
    expect(workflowHref("P")).toBe("/projects/P/workflow");
    expect(workflowHref("P", "J")).toBe("/projects/P/workflow/J");
    expect(currentProjectPath("P", "web")).toBe("/projects/P/workflow");
    expect(currentProjectPath("P", "web", "J")).toBe("/projects/P/workflow/J");
    expect(currentProjectPath("P", "workflow", "J")).toBeNull();
    expect(currentProjectPath("P", "work", "J")).toBeNull();
  });

  it("lays expanded frames one after another, across on a computer and down on a phone", () => {
    const sizes = [
      { width: 300, height: 100 },
      { width: 500, height: 200 },
      { width: 100, height: 50 },
    ];
    expect(stackFrames(sizes, false)).toEqual([
      { x: 0, y: 0 },
      { x: 372, y: 0 },
      { x: 944, y: 0 },
    ]);
    expect(stackFrames(sizes, true)).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 172 },
      { x: 0, y: 444 },
    ]);
  });

  it("remembers compact or expanded per project, and falls back to compact when storage refuses", () => {
    localStorage.clear();
    expect(readWorkflowMode("P")).toBe("compact");
    saveWorkflowMode("P", "expanded");
    expect(readWorkflowMode("P")).toBe("expanded");
    expect(readWorkflowMode("Q")).toBe("compact");
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(readWorkflowMode("P")).toBe("compact");
    expect(() => saveWorkflowMode("P", "compact")).not.toThrow();
    get.mockRestore();
    set.mockRestore();
  });
});

describe("a job's address (no job page)", () => {
  it("opens a job in its project's Work tab, a draft on New work", () => {
    expect(jobHref({ id: "J", projectId: "P", state: "running" })).toBe("/projects/P/work/J");
    expect(jobHref({ id: "J", projectId: "P" }, "silk")).toBe("/projects/P/work/J/silk");
    expect(jobHref({ id: "J", projectId: "P", state: "draft" })).toBe("/new/J");
    // Only an id known: the old address, which the redirect opens in its project.
    expect(jobIdHref("J")).toBe("/jobs/J");
    expect(jobIdHref("J", new Map([["J", "P"]]))).toBe("/projects/P/work/J");
  });

  it("maps the old job page's tabs: its Eye to the project's, its Web to the job's tasks", () => {
    expect(oldJobTab(undefined)).toEqual({ sub: "tasks" });
    expect(oldJobTab("web")).toEqual({ sub: "tasks" });
    expect(oldJobTab("eye")).toEqual({ project: "eye" });
    expect(oldJobTab("result")).toEqual({ sub: "result" });
  });

  it("has no shortcut to a Jobs page any more", () => {
    expect(SHORTCUTS.map((s) => s.keys)).not.toContain("g j");
    expect(SHORTCUTS.some((s) => s.does === "Jobs")).toBe(false);
  });
});
