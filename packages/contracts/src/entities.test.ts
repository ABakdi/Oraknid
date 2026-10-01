import { describe, expect, it } from "vitest";
import { ACTIVE_JOB_STATES, Id, Job, JobState, Topic } from "./index.ts";

const ULID = "01J9Z3K8W2Q4V6X8Y0A1B2C3D4";

describe("contracts", () => {
  it("accepts ULIDs and rejects anything else", () => {
    expect(Id.safeParse(ULID).success).toBe(true);
    expect(Id.safeParse("not-a-ulid").success).toBe(false);
    // I, L, O and U are not in the ULID alphabet.
    expect(Id.safeParse("01J9Z3K8W2Q4V6X8Y0A1B2C3DI").success).toBe(false);
  });

  it("lists exactly the active job states that hold the inhibitor", () => {
    for (const s of ACTIVE_JOB_STATES) expect(JobState.options).toContain(s);
    expect([...ACTIVE_JOB_STATES].sort()).toEqual(
      ["interviewing", "planning", "running", "verifying"].sort(),
    );
  });

  it("defaults nothing silently: a job needs a money budget", () => {
    const job = {
      id: ULID,
      projectId: ULID,
      title: "t",
      goal: "g",
      inputs: [],
      skillId: ULID,
      skillVersion: 1,
      autonomy: "standard",
      allowedLegIds: [],
      budget: { tokens: null, quotaShare: null, wallClockMs: null },
      state: "draft",
      pauseReason: null,
      blockedReason: null,
      createdAt: 0,
      startedAt: null,
      finishedAt: null,
    };
    expect(Job.safeParse(job).success).toBe(false);
    expect(
      Job.safeParse({ ...job, budget: { ...job.budget, money: { limit: 0, hard: true } } }).success,
    ).toBe(true);
  });

  it("only accepts known live topics", () => {
    expect(Topic.safeParse("overview").success).toBe(true);
    expect(Topic.safeParse(`job:${ULID}`).success).toBe(true);
    expect(Topic.safeParse("job:nope").success).toBe(false);
    expect(Topic.safeParse("everything").success).toBe(false);
  });
});
