import type { JobView, TaskView } from "@oraknid/contracts";
import { describe, expect, it } from "vitest";
import { SHORTCUTS } from "@/components/shell";
import { jobHref, jobIdHref, oldJobTab } from "@/lib/links";
import { currentJob, foldWeb } from "./project-work";

// ADR-034: the project is the place; jobs are its history.

const task = (id: string, jobId: string, state: TaskView["state"], dependsOn: string[] = []) =>
  ({ id, jobId, title: id, state, dependsOn }) as TaskView;

const job = (id: string, state: JobView["state"], tasks: TaskView[]) =>
  ({ id, projectId: "P", title: `Job ${id}`, state, tasks }) as JobView;

const a = job("A", "completed", [task("a1", "A", "done"), task("a2", "A", "done", ["a1"])]);
const b = job("B", "completed", [task("b1", "B", "done"), task("b2", "B", "failed")]);
const c = job("C", "running", [task("c1", "C", "running"), task("c2", "C", "pending", ["c1"])]);
const draft = job("D", "draft", []);

describe("The Web across a project's jobs", () => {
  it("lays out the job running now in full and folds each earlier one, in the order they ran", () => {
    const { tasks, folded } = foldWeb([a, b, c, draft], new Set());
    expect(folded).toEqual([
      { id: "A", title: "Job A", state: "completed", done: 2, total: 2, dependsOn: [] },
      { id: "B", title: "Job B", state: "completed", done: 1, total: 2, dependsOn: ["A"] },
    ]);
    // The running job's first task comes after the job before it.
    expect(tasks.map((x) => [x.id, x.dependsOn])).toEqual([
      ["c1", ["B"]],
      ["c2", ["c1"]],
    ]);
  });

  it("opens an earlier job in place, its tasks between the jobs around it", () => {
    const { tasks, folded } = foldWeb([a, b, c], new Set(["B"]));
    expect(folded.map((x) => x.id)).toEqual(["A"]);
    expect(tasks.map((x) => [x.id, x.dependsOn])).toEqual([
      ["b1", ["A"]],
      ["b2", ["A"]],
      ["c1", ["b1", "b2"]],
      ["c2", ["c1"]],
    ]);
  });

  it("shows the newest job in full once every job has ended, and never a draft", () => {
    expect(currentJob([a, b, draft])?.id).toBe("B");
    expect(currentJob([draft])).toBeUndefined();
    expect(foldWeb([draft], new Set())).toEqual({ tasks: [], folded: [] });
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
