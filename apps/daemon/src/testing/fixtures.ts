import { ulid } from "ulid";
import type { Db } from "../db/open.ts";
import { jobs, projects, skills } from "../db/schema.ts";

/** A project, a skill and a job in `state`, for tests. Returns the job id. */
export function seedJob(db: Db, state = "draft", workspacePath?: string): string {
  const projectId = ulid();
  const skillId = ulid();
  const jobId = ulid();
  db.insert(projects)
    .values({
      id: projectId,
      name: "p",
      workspacePath: workspacePath ?? `/tmp/p-${projectId}`,
      isGitRepo: true,
      releaseBranch: "main",
      workBranch: "dev",
      createdAt: 0,
    })
    .run();
  db.insert(skills)
    .values({
      id: skillId,
      version: 1,
      name: "s",
      description: "",
      source: "built-in",
      body: "",
      interview: false,
      requiredTools: [],
      verify: [],
      createdAt: 0,
    })
    .run();
  db.insert(jobs)
    .values({
      id: jobId,
      projectId,
      title: "t",
      goal: "g",
      inputs: [],
      skillId,
      skillVersion: 1,
      autonomy: "standard",
      allowedLegIds: [],
      budget: {
        tokens: null,
        quotaShare: null,
        wallClockMs: null,
        money: { limit: 0, hard: true },
      },
      state,
      createdAt: 0,
    })
    .run();
  return jobId;
}
