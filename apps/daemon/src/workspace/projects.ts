import { accessSync, constants, existsSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  ACTIVE_JOB_STATES,
  DEFAULT_BUDGET,
  type NewJob,
  type NewProject,
} from "@oraknid/contracts";
import { count, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/open.ts";
import {
  attempts,
  events,
  eyeMessages,
  inboxItems,
  jobs,
  projects,
  sessions,
  settings,
  sideEffects,
  silkEntries,
  silkMirror,
  steps,
  taskEdges,
  tasks,
} from "../db/schema.ts";
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

  /** Archived: hidden from the lists, kept for stats (Core-Entities → Project). */
  setArchived(id: string, archived: boolean) {
    this.require(id);
    this.bus.atomically(() => {
      this.db
        .update(projects)
        .set({ archivedAt: archived ? this.now() : null })
        .where(eq(projects.id, id))
        .run();
      this.bus.publish({
        type: archived ? "project.archived" : "project.restored",
        topic: "overview",
        jobId: null,
        payload: { id },
        actor: "owner",
      });
    });
  }

  /**
   * Deleted on my request: the project and its jobs leave Oraknid with their
   * history (tasks, sessions, Silk, inbox, events, logs). My folder, the
   * job branches and worktrees in it are left as they are.
   */
  remove(id: string, logsDir: string) {
    const project = this.require(id);
    const mine = this.db.select().from(jobs).where(eq(jobs.projectId, id)).all();
    const busy = mine.find((j) => (ACTIVE_JOB_STATES as readonly string[]).includes(j.state));
    if (busy) throw new Error(`"${busy.title}" is still going; cancel it first.`);
    const ids = mine.map((j) => j.id);
    this.bus.atomically(() => {
      if (ids.length) {
        const taskIds = this.db
          .select({ id: tasks.id })
          .from(tasks)
          .where(inArray(tasks.jobId, ids))
          .all()
          .map((t) => t.id);
        if (taskIds.length)
          this.db.delete(taskEdges).where(inArray(taskEdges.taskId, taskIds)).run();
        for (const table of [
          attempts,
          sessions,
          silkMirror,
          silkEntries,
          inboxItems,
          eyeMessages,
          steps,
          sideEffects,
          events,
          tasks,
        ])
          this.db.delete(table).where(inArray(table.jobId, ids)).run();
        this.db.delete(jobs).where(inArray(jobs.id, ids)).run();
      }
      this.db
        .delete(settings)
        .where(eq(settings.key, `policy.project.${id}`))
        .run();
      this.db.delete(projects).where(eq(projects.id, id)).run();
      this.bus.publish({
        type: "project.deleted",
        topic: "overview",
        jobId: null,
        payload: { id, name: project.name, jobs: ids.length },
        actor: "owner",
      });
    });
    for (const jobId of ids) rmSync(join(logsDir, "jobs", jobId), { recursive: true, force: true });
    return { jobs: ids.length, folder: project.workspacePath };
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
          // The skill's tools (ADR-021); set up in Settings → Tools before the job starts.
          tools: skill.requiredTools,
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
