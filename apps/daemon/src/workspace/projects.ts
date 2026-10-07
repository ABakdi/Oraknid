import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  ACTIVE_JOB_STATES,
  type DraftPatch,
  type GitHubLink,
  GitHubLinkInput,
  type JobRename,
  type NewJob,
  type NewProject,
  type NewProjectRepo,
  type ProjectArchivedWith,
  type ProjectRepo,
  type ProjectRepoPatch,
  ServerRole,
} from "@oraknid/contracts";
import { count, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/open.ts";
import {
  attemptEvents,
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
import { findRepos, oneRepoLink, projectRepos, repoNameOf } from "./repos.ts";

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
    // A folder that isn't a repo but holds several is a project of several repos (ADR-042).
    const found = gitRepo ? [] : findRepos(path);
    if (found.length) {
      const repos: ProjectRepo[] = found.map((r) => ({
        name: repoNameOf(r.folder),
        folder: r.folder,
        releaseBranch: r.release,
        workBranch: r.work,
        github: null,
      }));
      return this.#insert(input, path, true, false, uniqueNames(repos));
    }
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
    return this.#insert(
      input,
      path,
      gitRepo,
      shadow,
      gitRepo
        ? [
            {
              name: repoNameOf(basename(path)),
              folder: "",
              releaseBranch: branches.release,
              workBranch: branches.work,
              github: null,
            },
          ]
        : [],
    );
  }

  #insert(
    input: NewProject,
    path: string,
    gitRepo: boolean,
    shadow: boolean,
    repos: ProjectRepo[],
  ) {
    const branches = repos[0]
      ? { release: repos[0].releaseBranch, work: repos[0].workBranch }
      : detectBranches(path);
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
          repos,
          createdAt: this.now(),
        })
        .run();
      this.bus.publish({
        type: "project.created",
        topic: "overview",
        jobId: null,
        payload: { id, name: input.name, path, repos: repos.map((r) => r.name) },
      });
    });
    return this.require(id);
  }

  /** Its row, with its repos (ADR-042) and, for one repo, that repo's GitHub link (ADR-038). */
  require(id: string) {
    const p = this.db.select().from(projects).where(eq(projects.id, id)).get();
    if (!p) throw new Error(`No project ${id}.`);
    return viewOf(p);
  }

  list() {
    return this.db
      .select()
      .from(projects)
      .orderBy(projects.id)
      .all()
      .map((p) => ({
        ...viewOf(p),
        jobCount:
          this.db.select({ n: count() }).from(jobs).where(eq(jobs.projectId, p.id)).get()?.n ?? 0,
      }));
  }

  #saveRepos(id: string, repos: ProjectRepo[], by: "owner" | "eye" = "owner") {
    const top = repos.length === 1 && repos[0]?.folder === "" ? repos[0] : null;
    this.bus.atomically(() => {
      this.db
        .update(projects)
        .set({
          repos,
          isGitRepo: repos.length > 0 || this.require(id).isGitRepo,
          ...(repos.length ? { shadow: false } : {}),
          // A project of one repo keeps its branches where they always were.
          ...(top ? { releaseBranch: top.releaseBranch, workBranch: top.workBranch } : {}),
        })
        .where(eq(projects.id, id))
        .run();
      this.bus.publish({
        type: "project.repos",
        topic: "overview",
        jobId: null,
        payload: { id, repos: repos.map((r) => ({ name: r.name, folder: r.folder })) },
        actor: by,
      });
    });
  }

  /**
   * Looks again for the repos in its folder (ADR-042): repos found in its
   * folders are added; the ones it has stay, with their links. A folder
   * that is itself a repo stays one of them.
   */
  detectRepos(id: string) {
    const p = this.require(id);
    if (this.#busy(id)) throw new Error("A job of this project is running: wait for it to end.");
    const repos = [...p.repos];
    if (!repos.length && isGitRepo(p.workspacePath) && !p.shadow) {
      const b = detectBranches(p.workspacePath);
      repos.push({
        name: repoNameOf(basename(p.workspacePath)),
        folder: "",
        releaseBranch: b.release,
        workBranch: b.work,
        github: null,
      });
    }
    for (const f of findRepos(p.workspacePath))
      if (!repos.some((r) => r.folder === f.folder))
        repos.push({
          name: repoNameOf(f.folder),
          folder: f.folder,
          releaseBranch: f.release,
          workBranch: f.work,
          github: null,
        });
    const named = uniqueNames(repos);
    if (JSON.stringify(named) !== JSON.stringify(p.repos)) this.#saveRepos(id, named);
    return named;
  }

  /**
   * A repo added to the project (ADR-042): a folder of it that is one, a new
   * empty one (git init), or a clone. A project of one repo becomes one of
   * several, its folder's own repo kept as the first.
   */
  async addRepo(
    input: NewProjectRepo,
    clone?: (url: string, dest: string, login?: string | null) => Promise<void>,
    cloneUrl?: (fullName: string) => string,
  ) {
    const p = this.require(input.id);
    if (this.#busy(input.id))
      throw new Error("A job of this project is running: wait for it to end.");
    const s = input.source;
    const dest = join(p.workspacePath, ...s.folder.split("/"));
    if (p.repos.some((r) => r.folder === s.folder))
      throw new Error(`${s.folder} is already a repo of this project.`);
    if (s.kind === "folder") {
      if (!existsSync(dest) || !isGitRepo(dest) || !existsSync(join(dest, ".git")))
        throw new Error(`${dest} is not a git repo.`);
    } else if (s.kind === "new") {
      if (existsSync(dest) && readdirSync(dest).length)
        throw new Error(`${dest} exists and isn't empty: add it as a folder, or choose another.`);
      mkdirSync(dest, { recursive: true });
      git({ cwd: dest, base: [] }, ["init", "-q", "-b", "main"]);
    } else {
      if (existsSync(dest)) throw new Error(`${dest} exists already: choose another folder.`);
      if (!clone) throw new Error("Cloning isn't available here.");
      mkdirSync(dirname(dest), { recursive: true });
      if (s.kind === "github-clone")
        await clone(cloneUrl?.(s.fullName) ?? s.fullName, dest, s.account ?? null);
      else await clone(s.url, dest);
    }
    const b = detectBranches(dest);
    const repos = [...p.repos];
    if (!repos.length && isGitRepo(p.workspacePath) && !p.shadow) {
      const top = detectBranches(p.workspacePath);
      repos.push({
        name: repoNameOf(basename(p.workspacePath)),
        folder: "",
        releaseBranch: top.release,
        workBranch: top.work,
        github: null,
      });
    }
    const name = input.name ?? repoNameOf(s.folder);
    if (repos.some((r) => r.name === name))
      throw new Error(`This project has a repo named ${name} already: give it another name.`);
    repos.push({
      name,
      folder: s.folder,
      releaseBranch: b.release,
      workBranch: b.work,
      github: null,
    });
    this.#saveRepos(input.id, repos);
    return this.require(input.id);
  }

  /** A repo no longer part of the project; its folder stays as it is. */
  removeRepo(id: string, name: string) {
    const p = this.require(id);
    if (this.#busy(id)) throw new Error("A job of this project is running: wait for it to end.");
    if (!p.repos.some((r) => r.name === name)) throw new Error(`No repo ${name} in this project.`);
    if (p.repos.length === 1) throw new Error("A project keeps at least one repo.");
    this.#saveRepos(
      id,
      p.repos.filter((r) => r.name !== name),
    );
    return this.require(id);
  }

  /**
   * A repo renamed in the project, or its release and work branches changed
   * (ADR-042). A branch must be a valid branch name; it needn't exist yet
   * (the work branch is made from the release branch when a job needs it).
   */
  updateRepo(input: ProjectRepoPatch) {
    const p = this.require(input.id);
    if (this.#busy(input.id))
      throw new Error("A job of this project is running: wait for it to end.");
    const repo = p.repos.find((r) => r.name === input.name);
    if (!repo) throw new Error(`No repo ${input.name} in this project.`);
    const name = input.rename ?? repo.name;
    if (name !== repo.name && p.repos.some((r) => r.name === name))
      throw new Error(`This project has a repo named ${name} already: give it another name.`);
    const releaseBranch = input.releaseBranch?.trim() || repo.releaseBranch;
    const workBranch = input.workBranch?.trim() || repo.workBranch;
    for (const b of [releaseBranch, workBranch])
      try {
        git({ cwd: p.workspacePath, base: [] }, ["check-ref-format", "--branch", b]);
      } catch {
        throw new Error(`${b} isn't a branch name git accepts.`);
      }
    if (releaseBranch === workBranch)
      throw new Error("The release branch and the work branch must be different.");
    this.#saveRepos(
      input.id,
      p.repos.map((r) => (r === repo ? { ...r, name, releaseBranch, workBranch } : r)),
    );
    return this.require(input.id);
  }

  /** One of its jobs is going: its repos stay as they are until it ends. */
  #busy(id: string) {
    return this.activeJobs(id).length > 0;
  }

  /** Its jobs going now (running, paused, queued…), not drafts nor ended ones. */
  activeJobs(id: string) {
    return this.db
      .select({ id: jobs.id, title: jobs.title, state: jobs.state })
      .from(jobs)
      .where(eq(jobs.projectId, id))
      .all()
      .filter((j) => (ACTIVE_JOB_STATES as readonly string[]).includes(j.state));
  }

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
      attemptEvents,
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
    // A new goal: its first line until The Eye names it again; a name I typed stays.
    if (rest.goal && rest.goal !== job.goal && job.namedBy !== "me") {
      Object.assign(set, { title: firstLine(rest.goal), namedBy: null });
      if (job.describedAs !== "mine") Object.assign(set, { description: null, describedAs: null });
    }
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
  setServers(
    id: string,
    serverIds: string[],
    roles?: Record<string, ServerRole>,
    by: "owner" | "eye" = "owner",
  ) {
    const p = this.require(id);
    for (const s of serverIds)
      if (!this.db.select().from(servers).where(eq(servers.id, s)).get())
        throw new Error(`No server ${s}.`);
    // A server kept keeps its role; one let go loses it.
    const serverRoles = Object.fromEntries(
      serverIds.flatMap((s) => {
        const r = roles?.[s] ?? p.serverRoles[s];
        return r ? [[s, ServerRole.parse(r)]] : [];
      }),
    );
    this.bus.atomically(() => {
      this.db.update(projects).set({ serverIds, serverRoles }).where(eq(projects.id, id)).run();
      this.bus.publish({
        type: "project.servers",
        topic: "overview",
        jobId: null,
        payload: { id, serverIds, serverRoles },
        actor: by,
      });
    });
  }

  /** A server's role in the project (ADR-042): a word, and production when marked or so named. */
  setServerRole(id: string, serverId: string, role: ServerRole, by: "owner" | "eye" = "owner") {
    const p = this.require(id);
    const ids = p.serverIds.includes(serverId) ? p.serverIds : [...p.serverIds, serverId];
    this.setServers(id, ids, { ...p.serverRoles, [serverId]: ServerRole.parse(role) }, by);
  }

  /**
   * Its GitHub link (ADR-038), for one of its repos (ADR-042; the only one
   * when not named): the account and repository Oraknid's github tool uses
   * for it, or none. A repo that exists is ready at once; a new one once the
   * tool has created it.
   */
  setGitHub(
    id: string,
    input: GitHubLinkInput | null,
    by: "owner" | "eye" = "owner",
    repoName?: string | null,
  ) {
    const p = this.require(id);
    const repo = pickRepo(p.repos, repoName);
    const before = repo.github;
    // GitHub's owners are one name; a GitLab group may have subgroups (ADR-062).
    if (input && !input.host && input.owner.includes("/"))
      throw new Error("A GitHub repository's owner is one name, without a slash.");
    // The same repo again keeps what is known of it: a new repo already created stays created.
    const same =
      !!input &&
      !!before?.ready &&
      (before.host ?? null) === (input.host ?? null) &&
      before.owner.toLowerCase() === input.owner.toLowerCase() &&
      before.name.toLowerCase() === input.name.toLowerCase();
    const link: GitHubLink | null = input
      ? {
          ...GitHubLinkInput.parse(input),
          ready: input.origin === "existing" || same,
          linkedAt: this.now(),
        }
      : null;
    this.#setLink(id, repo.name, link, by);
    return link;
  }

  #setLink(id: string, repoName: string, link: GitHubLink | null, by: "owner" | "eye") {
    const repos = this.require(id).repos.map((r) =>
      r.name === repoName ? { ...r, github: link } : r,
    );
    this.bus.atomically(() => {
      this.db.update(projects).set({ repos }).where(eq(projects.id, id)).run();
      this.bus.publish({
        type: "project.github",
        topic: "overview",
        jobId: null,
        payload: { id, repo: repoName, github: link },
        actor: by === "owner" ? "owner" : "eye",
      });
    });
  }

  /** The new repo of a link exists now (the github tool created it). */
  githubCreated(id: string, repoName?: string | null) {
    const repo = pickRepo(this.require(id).repos, repoName);
    if (!repo.github || repo.github.ready) return;
    this.#setLink(id, repo.name, { ...repo.github, ready: true }, "eye");
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

  /**
   * Archived: hidden from the lists, kept for stats (Core-Entities →
   * Project), with a note of what archiving did (repos archived on GitHub,
   * its folder deleted) for unarchiving; or back in the list.
   */
  setArchived(id: string, archived: boolean, archivedWith: ProjectArchivedWith | null = null) {
    const before = this.require(id);
    this.bus.atomically(() => {
      this.db
        .update(projects)
        .set({
          archivedAt: archived ? (before.archivedAt ?? this.now()) : null,
          archivedWith: archived ? archivedWith : null,
        })
        .where(eq(projects.id, id))
        .run();
      this.bus.publish({
        type: archived ? "project.archived" : "project.restored",
        topic: "overview",
        jobId: null,
        payload: { id, name: before.name, ...(archived && archivedWith ? archivedWith : {}) },
        actor: "owner",
      });
    });
  }

  /**
   * Deleted on my request: the project and its jobs leave Oraknid with their
   * history (tasks, sessions, Silk, inbox, events, logs). My folder, the
   * job branches and worktrees in it are left as they are, unless I chose
   * to delete them too (`removed` says what else went, for the audit log).
   */
  remove(
    id: string,
    logsDir: string,
    removed: {
      folderDeleted?: string | null;
      githubDeleted?: string[];
      steps?: { kind: string; target: string; status: string }[];
    } = {},
  ) {
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
        payload: {
          id,
          name: project.name,
          jobs: ids.length,
          records: true,
          folderDeleted: removed.folderDeleted ?? null,
          githubDeleted: removed.githubDeleted ?? [],
          ...(removed.steps ? { steps: removed.steps } : {}),
        },
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
          // A name I typed is kept; otherwise The Eye names it (eye/naming.ts).
          namedBy: input.title ? "me" : null,
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

  /**
   * My name or description for a job (Jobs-and-Projects → A job's name and
   * description): kept from then on, The Eye no longer changes it.
   */
  renameJob(input: JobRename) {
    const job = this.db.select().from(jobs).where(eq(jobs.id, input.id)).get();
    if (!job) throw new Error(`No job ${input.id}.`);
    const set: Partial<typeof jobs.$inferInsert> = {};
    if (input.title !== undefined) {
      const title = input.title.replace(/\s+/g, " ").trim();
      if (!title) throw new Error("A job's name can't be empty.");
      Object.assign(set, { title, namedBy: "me" });
    }
    if (input.description !== undefined)
      Object.assign(set, { description: input.description.trim() || null, describedAs: "mine" });
    if (!Object.keys(set).length) throw new Error("Give a name or a description.");
    this.bus.atomically(() => {
      this.db.update(jobs).set(set).where(eq(jobs.id, input.id)).run();
      const after = this.db.select().from(jobs).where(eq(jobs.id, input.id)).get();
      this.bus.publish({
        type: "job.named",
        topic: `job:${input.id}`,
        jobId: input.id,
        payload: {
          id: input.id,
          title: after?.title,
          description: after?.description ?? null,
          namedBy: after?.namedBy ?? null,
          describedAs: after?.describedAs ?? null,
        },
        actor: "owner",
      });
    });
  }
}

type ProjectRow = typeof projects.$inferSelect;

/** A project as the API shows it: its repos (ADR-042), and its one repo's link (ADR-038). */
export function viewOf(p: ProjectRow) {
  return { ...p, repos: projectRepos(p), github: oneRepoLink(p) };
}

/** The repo named, or the only one; a project of several must name it. */
export function pickRepo(repos: ProjectRepo[], name?: string | null): ProjectRepo {
  if (!repos.length) throw new Error("This project isn't a git repository.");
  if (name) {
    const r = repos.find((x) => x.name === name);
    if (!r)
      throw new Error(
        `No repo ${name} in this project (its repos: ${repos.map((x) => x.name).join(", ")}).`,
      );
    return r;
  }
  if (repos.length > 1) throw new Error(`Name the repo: ${repos.map((x) => x.name).join(", ")}.`);
  return repos[0] as ProjectRepo;
}

/** Two repos never share a name: a second `web` becomes `web-2`. */
function uniqueNames(repos: ProjectRepo[]): ProjectRepo[] {
  const seen = new Set<string>();
  return repos.map((r) => {
    let name = r.name;
    for (let n = 2; seen.has(name); n++) name = `${r.name}-${n}`;
    seen.add(name);
    return { ...r, name };
  });
}

/** A job's name before The Eye gives it one: its goal's first line. */
export const firstLine = (goal: string) => {
  const line = goal.trim().split("\n")[0] ?? "Job";
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
};
