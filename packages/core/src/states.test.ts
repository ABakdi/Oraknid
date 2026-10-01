import { JobState, TaskState } from "@oraknid/contracts";
import { describe, expect, it } from "vitest";
import { assertJob, canJob, canTask, isTerminalJob } from "./states.ts";

describe("job life cycle", () => {
  it("follows the Core-Entities diagram", () => {
    expect(canJob("draft", "interviewing")).toBe(true);
    expect(canJob("interviewing", "planning")).toBe(true);
    expect(canJob("running", "verifying")).toBe(true);
    expect(canJob("verifying", "running")).toBe(true); // verification failed → new tasks
    expect(canJob("verifying", "completed")).toBe(true);
    expect(canJob("blocked", "running")).toBe(true); // quota reset
  });

  it("only completes through verification (BR-1)", () => {
    for (const s of JobState.options) {
      if (s !== "verifying") expect(canJob(s, "completed")).toBe(false);
    }
  });

  it("can be paused from every active state and cancelled from every live one", () => {
    for (const s of ["interviewing", "planning", "running", "verifying"] as const) {
      expect(canJob(s, "paused")).toBe(true);
    }
    for (const s of JobState.options) {
      if (!isTerminalJob(s)) expect(canJob(s, "cancelled")).toBe(true);
    }
  });

  it("never leaves completed or cancelled", () => {
    for (const s of JobState.options) {
      expect(canJob("completed", s)).toBe(false);
      expect(canJob("cancelled", s)).toBe(false);
    }
  });

  it("explains an illegal move in words", () => {
    expect(() => assertJob("draft", "completed")).toThrow(
      "A job cannot go from draft to completed.",
    );
  });
});

describe("task life cycle", () => {
  it("is done only through verifying (BR-1)", () => {
    for (const s of TaskState.options) {
      if (s !== "verifying") expect(canTask(s, "done")).toBe(false);
    }
  });

  it("returns a running task to ready after a crash or a reassignment", () => {
    expect(canTask("running", "ready")).toBe(true);
    expect(canTask("verifying", "ready")).toBe(true);
  });
});
