import { accessSync, constants, existsSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { DEFAULT_BUDGET, type NewJob, type NewProject } from "@oraknid/contracts";
import { count, eq } from "drizzle-orm";
import type { Db } from "../db/open.ts";
import { jobs, projects } from "../db/schema.ts";
import type { EventBus } from "../events/bus.ts";
import { newId } from "../ids.ts";
import { BUILT_IN_DEFAULT, type SkillStore } from "../skills/store.ts";
import { detectBranches, git, isGitRepo, shadowRepo } from "./git.ts";

export class NotAGitRepo extends Error {}

/** Projects and jobs (docs/01-Specification/Jobs-and-Projects.md). */
export class Projects {
  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
    private readonly skills: SkillStore,
    private readonly now: () => number = Date.now,
  ) {}

  create(input: NewProject) {
    const path = resolve(input.workspacePath);
    if (!existsSync(path) || !statSync(path).isDirectory())
      throw new Error(`${path} is not a folder. Nothing was created.`);
    try {
      accessSync(path, constants.W_OK);
    } catch {
      throw new Error(`${path} is not writable. Nothing was created.`);
    }
    const existing = this.db.select().from(projects).where(eq(projects.workspacePath, path)).get();
    if (existing) throw new Error(`${path} is already the project "${existing.name}".`);

    let gitRepo = isGitRepo(path);
    let shadow = false;
    if (!gitRepo) {
      if (input.initGit === undefined) {
        throw new NotAGitRepo(
          `${path} is not a git repo. Choose: make it one (git init), or keep checkpoints in a shadow repo and leave the folder as it is.`,
        );
      }
      if (input.initGit) {
        git({ cwd: path, base: [] }, ["init", "-q", "-b", "main"]);
        gitRepo = true;
      } else {
        shadowRepo(path);
        shadow = true;
      }
    }
    const branches = detectBranches(path);
    const id = newId(this.now());
    this.bus.atomically(() => {
      this.db
        .insert(projects)
        .values({
          id,
          name: input.name || basename(path),
          workspacePath: path,
          isGitRepo: gitRepo,
          shadow,
          releaseBranch: branches.release,
          workBranch: branches.work,
          createdAt: this.now(),
        })
        .run();
      this.bus.publish({
        type: "project.created",
        topic: "overview",
        jobId: null,
        payload: { id, name: input.name, path },
      });
    });
    return this.require(id);
  }

  require(id: string) {
    const p = this.db.select().from(projects).where(eq(projects.id, id)).get();
    if (!p) throw new Error(`No project ${id}.`);
    return p;
  }

  list() {
    return this.db
      .select()
      .from(projects)
      .orderBy(projects.id)
      .all()
      .map((p) => ({
        ...p,
        jobCount:
          this.db.select({ n: count() }).from(jobs).where(eq(jobs.projectId, p.id)).get()?.n ?? 0,
      }));
  }

  createJob(input: NewJob) {
    const project = this.require(input.projectId);
    const skillId = input.skillId ?? BUILT_IN_DEFAULT;
    const skill = this.skills.latest(skillId);
    if (!skill) throw new Error(`No skill ${skillId}.`);
    const id = newId(this.now());
    const title = input.title ?? firstLine(input.goal);
    this.bus.atomically(() => {
      this.db
        .insert(jobs)
        .values({
          id,
          projectId: project.id,
          title,
          goal: input.goal,
          inputs: input.inputs,
          skillId,
          skillVersion: skill.version,
          autonomy: input.autonomy,
          allowedLegIds: input.allowedLegIds,
          budget: input.budget ?? DEFAULT_BUDGET,
          state: "draft",
          verify: [...skill.verify, ...input.verify],
          unsandboxed: input.unsandboxed,
          createdAt: this.now(),
        })
        .run();
      this.bus.publish({
        type: "job.created",
        topic: "overview",
        jobId: id,
        payload: { id, title, projectId: project.id },
      });
      if (input.unsandboxed) {
        this.bus.publish({
          type: "job.unsandboxed",
          topic: `job:${id}`,
          jobId: id,
          payload: { warning: "This job runs without the sandbox, by my choice." },
        });
      }
    });
    return id;
  }
}

const firstLine = (goal: string) => {
  const line = goal.trim().split("\n")[0] ?? "Job";
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
};
