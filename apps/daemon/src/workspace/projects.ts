import { accessSync, constants, existsSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  ACTIVE_JOB_STATES,
  type DraftPatch,
  type GitHubLink,
  GitHubLinkInput,
  type NewJob,
  type NewProject,
} from "@oraknid/contracts";
import { count, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/open.ts";
import {
  attempts,
  events,
  eyeMessages,
  eyePlans,
  inboxItems,
  jobs,
  projects,
  servers,
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
import {
  jobBudgetFor,
  projectBudgetKey,
  projectBudgetStateKey,
  projectPortsKey,
} from "../settings.ts";
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
  /** Every row of these jobs; their tasks' edges first. */
  #deleteJobs(ids: string[]) {
    const taskIds = this.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(inArray(tasks.jobId, ids))
      .all()
      .map((t) => t.id);
    if (taskIds.length) this.db.delete(taskEdges).where(inArray(taskEdges.taskId, taskIds)).run();
    for (const table of [
      attempts,
      sessions,
      silkMirror,
      silkEntries,
      inboxItems,
      eyeMessages,
      eyePlans,
      steps,
      sideEffects,
      events,
      tasks,
    ])
      this.db.delete(table).where(inArray(table.jobId, ids)).run();
    this.db.delete(jobs).where(inArray(jobs.id, ids)).run();
  }

  /**
   * A draft I don't want, or a job that has ended, gone from Oraknid
   * (New work → Delete). Its branch and worktree, if any, stay in my repo.
   */
  removeJob(jobId: string, logsDir: string) {
    const job = this.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    if (!job) throw new Error(`No job ${jobId}.`);
    if (!["draft", "completed", "cancelled"].includes(job.state))
      throw new Error(`"${job.title}" is still going; cancel it first.`);
    this.bus.atomically(() => {
      this.#deleteJobs([jobId]);
      this.bus.publish({
        type: "job.deleted",
        topic: "overview",
        jobId: null,
        payload: { id: jobId, title: job.title },
        actor: "owner",
      });
    });
    rmSync(join(logsDir, "jobs", jobId), { recursive: true, force: true });
  }

  /** A draft's options, changed as I go on the New work page; a started job has its own controls. */
  updateDraft(input: DraftPatch) {
    const job = this.db.select().from(jobs).where(eq(jobs.id, input.id)).get();
    if (!job) throw new Error(`No job ${input.id}.`);
    if (job.state !== "draft") throw new Error("That job has started: change it from its page.");
    const { id, skillId, ...rest } = input;
    const set: Partial<typeof jobs.$inferInsert> = { ...rest };
    if (rest.goal) set.title = firstLine(rest.goal);
    if (skillId !== undefined) {
      const skill = skillId ? this.skills.latest(skillId) : undefined;
      if (skillId && !skill) throw new Error(`No skill ${skillId}.`);
      if (skill)
        Object.assign(set, { skillId: skill.id, skillVersion: skill.version, skillChoices: [] });
    }
    this.db.update(jobs).set(set).where(eq(jobs.id, id)).run();
    this.bus.publish({
      type: "job.draft-updated",
      topic: `job:${id}`,
      jobId: id,
      payload: { fields: Object.keys(set) },
      actor: "owner",
    });
  }

  /** The servers its jobs may use (Servers → Servers in projects). */
  setServers(id: string, serverIds: string[]) {
    this.require(id);
    for (const s of serverIds)
      if (!this.db.select().from(servers).where(eq(servers.id, s)).get())
        throw new Error(`No server ${s}.`);
    this.bus.atomically(() => {
      this.db.update(projects).set({ serverIds }).where(eq(projects.id, id)).run();
      this.bus.publish({
        type: "project.servers",
        topic: "overview",
        jobId: null,
        payload: { id, serverIds },
        actor: "owner",
      });
    });
  }

  /**
   * Its GitHub link (ADR-038): the account and repository Oraknid's github
   * tool uses for it, or none. A repo that exists is ready at once; a new
   * one once the tool has created it.
   */
  setGitHub(id: string, input: GitHubLinkInput | null, by: "owner" | "eye" = "owner") {
    const before = this.require(id).github;
    // The same repo again keeps what is known of it: a new repo already created stays created.
    const same =
      !!input &&
      !!before?.ready &&
      before.owner.toLowerCase() === input.owner.toLowerCase() &&
      before.name.toLowerCase() === input.name.toLowerCase();
    const link: GitHubLink | null = input
      ? {
          ...GitHubLinkInput.parse(input),
          ready: input.origin === "existing" || same,
          linkedAt: this.now(),
        }
      : null;
    this.bus.atomically(() => {
      this.db.update(projects).set({ github: link }).where(eq(projects.id, id)).run();
      this.bus.publish({
        type: "project.github",
        topic: "overview",
        jobId: null,
        payload: { id, github: link },
        actor: by === "owner" ? "owner" : "eye",
      });
    });
    return link;
  }

  /** The new repo of its link exists now (the github tool created it). */
  githubCreated(id: string) {
    const p = this.require(id);
    if (!p.github || p.github.ready) return;
    const link = { ...p.github, ready: true };
    this.bus.atomically(() => {
      this.db.update(projects).set({ github: link }).where(eq(projects.id, id)).run();
      this.bus.publish({
        type: "project.github",
        topic: "overview",
        jobId: null,
        payload: { id, github: link },
        actor: "eye",
      });
    });
  }

  /** The skills its jobs may use; The Eye picks one per job (Skills → Skills per project). */
  setSkills(id: string, skillIds: string[]) {
    this.require(id);
    for (const s of skillIds) if (!this.skills.latest(s)) throw new Error(`No skill ${s}.`);
    this.bus.atomically(() => {
      this.db.update(projects).set({ skillIds }).where(eq(projects.id, id)).run();
      this.bus.publish({
        type: "project.skills",
        topic: "overview",
        jobId: null,
        payload: { id, skillIds },
        actor: "owner",
      });
    });
  }

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
        this.#deleteJobs(ids);
      }
      this.db
        .delete(settings)
        .where(
          inArray(settings.key, [
            `policy.project.${id}`,
            projectBudgetKey(id),
            projectBudgetStateKey(id),
            projectPortsKey(id),
          ]),
        )
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
    // A skill I picked; else the project's, The Eye choosing among several (Skills → Skills per project).
    const candidates = input.skillId
      ? []
      : (project.skillIds as string[]).filter((id) => this.skills.latest(id));
    const skillId = input.skillId ?? candidates[0] ?? BUILT_IN_DEFAULT;
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
          // Unset: the project's budget is where a new job starts (ADR-034).
          budget: input.budget ?? jobBudgetFor(this.db, project.id),
          state: "draft",
          verify: [...skill.verify, ...input.verify],
          // The skill's tools (ADR-021); set up in Settings → Tools before the job starts.
          tools: [
            ...new Set(
              (candidates.length > 1 ? candidates : [skillId]).flatMap(
                (id) => this.skills.latest(id)?.requiredTools ?? [],
              ),
            ),
          ],
          skillChoices: candidates.length > 1 ? candidates : [],
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
