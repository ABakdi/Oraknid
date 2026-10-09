import { join } from "node:path";
import {
  type Autonomy,
  InterviewRound,
  type JobInput,
  type MetricsSample,
  normalizeQuestions,
  type ProjectRepo,
  renderQuestions,
} from "@oraknid/contracts";
import {
  canRunSideBySide,
  EscalationPolicy,
  freshQuestions,
  type GatedAction,
  readingOf,
  readyTasks,
  SPENDS_ATTEMPT,
  scopeConflict,
  skillChecks,
  skillExcerpt,
  specComplete,
  suspicious,
} from "@oraknid/core";
import type { Sandbox } from "@oraknid/os";
import { and, count, eq, gte, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/open.ts";
import { attempts, jobs, projects, steps, tasks } from "../db/schema.ts";
import type { SideEffects } from "../engine/effects.ts";
import { AwaitingOwner } from "../engine/effects.ts";
import type { JobContext, JobProgram } from "../engine/runner.ts";
import type { EventBus } from "../events/bus.ts";
import { forgetDriftVerdicts } from "../harness/confirm.ts";
import { runController } from "../harness/controller.ts";
import { checkRefusal } from "../harness/gate.ts";
import type { AttemptJob, AttemptOutcome } from "../harness/types.ts";
import { createVerifier } from "../harness/verifier.ts";
import type { VisualDeps } from "../harness/visual.ts";
import type { InboxStore } from "../inbox/store.ts";
import { sandboxPlan } from "../legs/plan.ts";
import type { LegRegistry } from "../legs/registry.ts";
import type { LegSupervisor } from "../legs/supervisor.ts";
import { Work } from "../resources/work.ts";
import { jobHasServers } from "../secrets/tool.ts";
import { jobServers, serverDigest, serverPlanApproval } from "../servers/server-jobs.ts";
import type { Servers } from "../servers/service.ts";
import {
  attemptsFromKey,
  followUpKey,
  JobServer,
  jobServerKey,
  MAX_TASKS_PER_JOB,
  projectPorts,
  readSetting,
  writeSetting,
} from "../settings.ts";
import type { SilkStore } from "../silk/store.ts";
import type { SkillStore } from "../skills/store.ts";
import type { McpBroker } from "../tools/broker.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import {
  commitsAhead,
  createTaskWorktree,
  createWorktree,
  type Git,
  git,
  mergeConflicts,
  mergeTaskBranch,
  removeTaskWorktree,
  shadowRepo,
  undoMerge,
  worktreeGit,
} from "../workspace/git.ts";
import type { GitHub } from "../workspace/github.ts";
import { type Projects, viewOf } from "../workspace/projects.ts";
import { isSeveral } from "../workspace/repos.ts";
import { MultiTree, multiTreeOf, singleTree, type WorkTree } from "../workspace/tree.ts";
import { forgetTaskVerdicts } from "./auto-mode.ts";
import { BrainStopped, type EyeBrain } from "./brain.ts";
import { parseBuiltinCheck } from "./builtin-checks.ts";
import { endingKey, JobEndingState, readEnding, runEnding } from "./ending.ts";
import { keepExperience } from "./experience.ts";
import { readInside, renderInputs } from "./inputs.ts";
import {
  closeInterview,
  decidedSoFar,
  ENOUGH,
  endsRound,
  INTERVIEW_DONE,
  interviewEnded,
  interviewRounds,
  interviewSoFar,
} from "./interview.ts";
import { ensureLinks } from "./links.ts";
import { chooseJobNeeds, jobExtraSkills, jobHasUi, readNeeds } from "./needs.ts";
import { dependentsOf } from "./questions.ts";
import { forgetTaskMemory, withdrawTaskQuestions } from "./task-memory.ts";
import { storeWeb, taskRows } from "./web-store.ts";

export interface EyeDeps {
  db: Db;
  bus: EventBus;
  silk: SilkStore;
  inbox: InboxStore;
  skills: SkillStore;
  registry: LegRegistry;
  supervisor: LegSupervisor;
  sandbox: Sandbox;
  brain: EyeBrain;
  /** Tools for skills (ADR-021). */
  tools?: { registry: ToolRegistry; broker: McpBroker };
  /** The outbox, for a tool's sends (BR-6). */
  effects?: SideEffects;
  /** My servers (ADR-026). */
  servers?: Servers;
  /** My GitHub accounts, for the project's GitHub link (ADR-038). */
  github?: GitHub;
  /** The projects, to save a link The Eye asked me for (ADR-038). */
  projects?: Projects;
  /** Recent metrics, for resource-aware scheduling (ADR-016). */
  machine?: () => MetricsSample[];
  /** Where every job's tasks ask to start (ADR-050); the daemon's, shared by all jobs. */
  work?: Work;
  legsDir: string;
  tmpDir: string;
  now: () => number;
  stallCheckMs?: number;
  driftJudgeMs?: number;
  /** Attempts per task before The Eye stops and asks me. */
  maxAttempts?: number;
  /** The visual check's renderer and judge (ADR-064 §5); without them it is skipped. */
  visual?: VisualDeps;
}

/** Where a job's work is: its folder, its tree (one repo or several), and Oraknid's places for it. */
export interface Where {
  cwd: string;
  tree: WorkTree;
  tmpDir: string;
  trash: string;
  projectPath: string;
}

const projectReposOf = (db: Db, projectId: string): ProjectRepo[] => {
  const p = db.select().from(projects).where(eq(projects.id, projectId)).get();
  return p ? viewOf(p).repos : [];
};

/** A project of several repos, as a plan and a Leg must know it (ADR-042). */
export function reposLayout(repos: ProjectRepo[], projectPath?: string): string {
  const list = repos
    .map(
      (r) =>
        `- ${r.folder ? `\`${r.folder}/\`` : "the folder itself"}: the repo **${r.name}** (work branch ${r.workBranch})`,
    )
    .join("\n");
  return `This project is several git repositories, each in its own folder:\n${list}\n\nThe job's folder mirrors the project's: each repo the job works in is there at its folder, on the job's branch, a git repository of its own. A task's scope starts with its repo's folder (\`web/src/**\`); a task that changes two repos names both folders in its scope. Each repo's changes are committed in that repo, never one commit across them; checks run from the job's folder (\`cd web && npm test\`).${projectPath ? ` A repo the job hasn't opened yet can be read in ${projectPath}/<its folder>; it appears in the job's folder when a task's scope names it.` : ""}`;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30) || "job";

/** The Eye as a job program (docs/01-Specification/The-Eye.md → The loop). */
export function eyeProgram(d: EyeDeps): JobProgram {
  return async (ctx: JobContext) => {
    let job0 = d.db.select().from(jobs).where(eq(jobs.id, ctx.jobId)).get();
    if (!job0) throw new Error(`No job ${ctx.jobId}.`);
    const project = d.db.select().from(projects).where(eq(projects.id, job0.projectId)).get();
    if (!project) throw new Error("The job's project is gone.");
    // Several skills to choose from: The Eye picks the one for this job, once (Skills → Skills per project).
    if (job0.skillChoices.length > 1) {
      await ctx.step("skill:pick", { choices: job0.skillChoices }, () =>
        pickJobSkill(d, ctx.jobId, project.workspacePath),
      );
      job0 = d.db.select().from(jobs).where(eq(jobs.id, ctx.jobId)).get() ?? job0;
    }
    // What the work needs besides its method (ADR-064 §6): proposed once, before any plan, for my approval.
    if (!taskRows(d.db, ctx.jobId).some((t) => t.planKey)) {
      await chooseJobNeeds(d, ctx, project.workspacePath);
      job0 = d.db.select().from(jobs).where(eq(jobs.id, ctx.jobId)).get() ?? job0;
    }
    const skill = d.skills.version(job0.skillId, job0.skillVersion);

    // ── The workspace: a worktree on a job branch, or the folder itself with a shadow repo;
    // in a project of several repos, the job's folder with a worktree per repo it touches (ADR-042).
    const projectView = viewOf(project);
    const several = isSeveral(projectView.repos);
    const from = readSetting(d.db, followUpKey(job0.id), z.string().nullable(), null);
    const ws = await ctx.step("workspace", null, async () => {
      if (several) {
        const root = join(project.workspacePath, ".oraknid", "worktrees", job0.id);
        const branch = `oraknid/${slug(job0.title)}-${job0.id.slice(-6).toLowerCase()}`;
        d.db.update(jobs).set({ worktree: root, branch }).where(eq(jobs.id, job0.id)).run();
        return { cwd: root, shadow: false };
      }
      if (project.isGitRepo) {
        const wt = createWorktree(
          project.workspacePath,
          job0.id,
          slug(job0.title),
          { release: project.releaseBranch, work: project.workBranch },
          // A follow-up job starts from what the job it follows built.
          from,
        );
        d.db
          .update(jobs)
          .set({ worktree: wt.path, branch: wt.branch })
          .where(eq(jobs.id, job0.id))
          .run();
        return { cwd: wt.path, shadow: false };
      }
      shadowRepo(project.workspacePath);
      d.db
        .update(jobs)
        .set({ worktree: project.workspacePath, branch: null })
        .where(eq(jobs.id, job0.id))
        .run();
      return { cwd: project.workspacePath, shadow: true };
    });
    const tree: WorkTree = several
      ? multiTreeOf(
          d.db,
          d.db.select().from(jobs).where(eq(jobs.id, job0.id)).get() as typeof job0,
          projectView,
          d.tmpDir,
          from,
        )
      : ws.shadow
        ? singleTree(shadowRepo(ws.cwd), d.tmpDir)
        : singleTree(worktreeGit(project.workspacePath, ws.cwd), d.tmpDir, project.workspacePath);
    const where: Where = {
      cwd: ws.cwd,
      tree,
      tmpDir: d.tmpDir,
      trash: join(project.workspacePath, ".oraknid", "trash"),
      projectPath: project.workspacePath,
    };
    // What a plan needs to know of a project of several repos (ADR-042), or of the server a server job works on (ADR-049).
    const layout =
      project.serverId && d.servers
        ? serverDigest({ servers: d.servers }, project.serverId)
        : several
          ? reposLayout(projectView.repos, project.workspacePath)
          : "";

    // A Leg's permission request dies with its session: one still open is stale.
    for (const item of d.inbox.list("open")) {
      if (item.jobId === ctx.jobId && typeof item.raisedBy === "object") d.inbox.withdraw(item.id);
    }
    // So does what The Eye asked for an attempt cut short by a crash: its next attempt asks
    // again if it must (bug 9).
    for (const t of taskRows(d.db, ctx.jobId))
      withdrawTaskQuestions(d.db, ctx.jobId, t.id, (id) => {
        if (d.inbox.get(id)?.state === "open") d.inbox.withdraw(id);
      });

    // Only one program runs a job: a task still marked running was cut short (pause, crash, stop).
    d.bus.atomically(() => {
      for (const t of taskRows(d.db, ctx.jobId).filter((x) =>
        ["assigned", "running", "verifying"].includes(x.state),
      )) {
        d.db
          .update(tasks)
          .set({ state: "ready", leaseUntil: null })
          .where(eq(tasks.id, t.id))
          .run();
        d.bus.publish({
          type: "task.state",
          topic: `job:${ctx.jobId}`,
          jobId: ctx.jobId,
          payload: { taskId: t.id, to: "ready", reason: "Picked up again." },
        });
      }
    });

    // Untrusted inputs are looked at once for attempts to steer the agent (Security → Prompt injection).
    await ctx.step("untrusted-scan", null, async () => {
      for (const input of (job0.inputs as JobInput[]).filter((i) => i.untrusted)) {
        const text = input.kind === "file" ? readInside(project.workspacePath, input.ref) : null;
        const why = text ? suspicious(text) : [];
        if (why.length === 0) continue;
        d.silk.add({
          jobId: job0.id,
          kind: "issue",
          title: `Suspicious input: ${input.ref}`,
          body: `It ${why.join("; it ")}. Treated as data only.`,
          authoredBy: "eye",
        });
        d.bus.publish({
          type: "job.suspicious-input",
          topic: `job:${job0.id}`,
          jobId: job0.id,
          payload: { ref: input.ref, why },
        });
      }
    });

    // The interview (Skills → The interview): the method needs my answers before any work.
    if (skill?.interview)
      await interview(d, ctx, job0, skill.body, several ? project.workspacePath : ws.cwd);

    if (ctx.state() === "draft" || ctx.state() === "interviewing") ctx.setState("planning");

    // ── Plan The Web, once: through the planner, whatever else wrote to the job before (after the
    // piano job, 2026-10-04, when tasks from a chat message stood in for a plan that never ran).
    if (!taskRows(d.db, ctx.jobId).some((t) => t.planKey)) {
      const plan = await ctx.step(
        "plan",
        { goal: job0.goal, skillVersion: job0.skillVersion },
        () =>
          d.brain.plan({
            jobId: job0.id,
            cwd: several ? project.workspacePath : ws.cwd,
            goal: job0.goal,
            skill: withJobSkills(
              d,
              job0.id,
              skill ? skillExcerpt(skill.body, "plan phases tasks", 6000) : "",
            ),
            silk: silkText(d.silk, job0.id),
            digest: layout,
            verify: job0.verify,
          }),
      );
      await ctx.step("web:1", plan, async () => storeWeb(d, job0.id, plan));
    }
    // The repos the plan's tasks name are ready before work starts (ADR-042).
    if (several) {
      for (const t of taskRows(d.db, ctx.jobId).filter((x) => x.state !== "done"))
        tree.prepare(t.scope);
    }
    if (ctx.state() === "planning") ctx.setState("running");

    for (;;) {
      // Asked every time, before any work: approved passes through, denied stops (never skipped on a resume).
      await approvePlanIfCareful(d, ctx);
      // Tasks side by side need a worktree each (a folder of worktrees across several repos).
      await runTasks(d, ctx, where, !ws.shadow);
      if (ctx.state() === "cancelled") return;

      // ── Job-level verification (BR-1): only this completes a job.
      const job = d.db.select().from(jobs).where(eq(jobs.id, ctx.jobId)).get() as typeof job0;
      ctx.setState("verifying");
      const round = job.verifyRound;
      // Oraknid's own checks of the repo on GitHub (ADR-038) run after its end steps, below.
      const own = job.verify.filter((v) => parseBuiltinCheck(v));
      const checks = job.verify.filter((v) => !parseBuiltinCheck(v));
      const results = await ctx.step(
        `job-verify:${round}`,
        { round, verify: job.verify },
        async (signal) =>
          checks.length
            ? // A check on one of its servers runs there, over Oraknid's own connection (ADR-049).
              (await verifierFor(d, job, where, signal).run(checks, { why: "job" })).results
            : [],
      );
      const failed = results.find((r) => !r.ok);
      if (!failed) {
        // The repo's part is Oraknid's: merge and push as asked, then its GitHub checks (after the piano job).
        const ending = await runEnding(
          {
            db: d.db,
            bus: d.bus,
            inbox: d.inbox,
            now: d.now,
            ...(d.github ? { github: d.github } : {}),
            ...(d.projects ? { projects: d.projects } : {}),
          },
          ctx,
          job,
        );
        if (own.length)
          await ctx.step(`job-verify-github:${round}`, { round, own }, async (signal) => {
            const out: string[] = [];
            // The project's own branch, never one a Leg made in the job's folder; each one run.
            const verifier = verifierFor(d, job, where, signal);
            for (const command of own) {
              const r = (await verifier.run([command], { why: "job-github" })).results[0];
              if (r && !r.ok) out.push(`\`${command}\`: ${r.output}`);
            }
            if (out.length) {
              const e = readEnding(d.db, job.id);
              const done = e.done ?? ending ?? { merged: null, pushed: [], problems: [] };
              writeSetting(d.db, endingKey(job.id), JobEndingState, {
                ...e,
                done: { ...done, problems: [...done.problems, ...out] },
              });
            }
            return out;
          });
        d.silk.add({
          jobId: job.id,
          kind: "progress",
          title: "Job verified",
          body: job.verify.length
            ? `All job-level checks pass: ${job.verify.map((v) => `\`${v}\``).join(", ")}.`
            : "Every task passed its own checks; the job has no job-level checks.",
          authoredBy: "eye",
        });
        // Its servers' documents, from a new discovery and what it did (Servers → The state document);
        // a server job's changes named in it (ADR-049).
        const place = d.db.select().from(projects).where(eq(projects.id, job.projectId)).get();
        for (const id of d.servers ? (place?.serverIds ?? []) : []) {
          await ctx.step(`server:${id}:after`, null, async () => {
            const finished = taskRows(d.db, job.id).filter((t) => t.state === "done");
            const done = finished.map((t) => `- ${t.title}`).join("\n");
            const changed = finished
              .filter((t) => t.kind !== "research" && t.kind !== "plan")
              .map(
                (t) =>
                  `${t.title}${t.verify.length ? ` (checked: ${t.verify.map((v) => `\`${v}\``).join(", ")})` : ""}`,
              );
            await d.servers
              ?.discover(
                id,
                `The job "${job.title}" finished. Its goal: ${job.goal}\nIts tasks:\n${done}`,
                {
                  id: job.id,
                  title: job.title,
                  // A project's job names its changes only when it is the server's own (its tasks may be code).
                  changes: place?.serverId === id ? changed : null,
                },
              )
              .catch(() => null);
            return null;
          });
        }
        ctx.setState("completed");
        return;
      }
      // Failed: plan the fixes and go round again.
      const done = taskRows(d.db, job.id)
        .filter((t) => t.state === "done")
        .map((t) => t.title);
      const fix = await ctx.step(`replan:${round}`, { round }, () =>
        d.brain.replan({
          jobId: job.id,
          cwd: ws.cwd,
          goal: job.goal,
          skill: skill ? skillExcerpt(skill.body, "fix verification", 3000) : "",
          silk: silkText(d.silk, job.id),
          digest: layout,
          verify: job.verify,
          failure: `\`${failed.command}\` (exit ${failed.exitCode}):\n${failed.output}`,
          done,
        }),
      );
      await ctx.step(`web:${round + 2}`, fix, async () => storeWeb(d, job.id, fix));
      d.db
        .update(jobs)
        .set({ verifyRound: round + 1 })
        .where(eq(jobs.id, job.id))
        .run();
      ctx.setState("running");
    }
  };
}

/**
 * Runs ready tasks until none is left or the job must stop: in parallel by
 * default (ADR-050), every ready task whose scope can't tightly overlap a
 * running one's, as the machine, the Legs and my cap admit; the rest wait,
 * each saying why.
 */
async function runTasks(d: EyeDeps, ctx: JobContext, where: Where, parallel = false) {
  const work = workOf(d);
  const running = new Map<string, Promise<void>>();
  // A plan that is a chain works in the job's own tree, one task after another, as always.
  let inPlace: string | null = null;
  // Written by the running tasks' callbacks.
  const run: { failure: { error: unknown } | null; cancelled: boolean } = {
    failure: null,
    cancelled: false,
  };
  // "Stop the job" from one task stops the others where they are (ADR-056 stage 1, bug 1).
  const stopAll = new AbortController();
  const cancelled = async () => {
    stopAll.abort(new Error("The job was stopped."));
    await Promise.allSettled(running.values());
  };
  try {
    for (;;) {
      if (ctx.signal.aborted && running.size === 0)
        throw ctx.signal.reason ?? new Error("Stopped.");
      const job = d.db.select().from(jobs).where(eq(jobs.id, ctx.jobId)).get();
      if (!job) return;
      const all = taskRows(d.db, ctx.jobId);
      const unfinished = all.filter((t) => t.state !== "done" && t.state !== "skipped");
      if (unfinished.length === 0 && running.size === 0) return;
      const ready = readyTasks(
        all.filter((t) => !t.ownerHeld && t.state !== "failed" && t.state !== "paused"),
      ).filter((t) => !running.has(t.id));
      // A task no longer ready no longer waits for anything.
      const readyIds = new Set(ready.map((t) => t.id));
      for (const t of all) if (!readyIds.has(t.id)) work.clear(job.id, t.id);
      if (ready.length === 0 && running.size > 0) {
        await Promise.race(running.values());
        if (run.cancelled) return await cancelled();
        continue;
      }
      if (ready.length === 0) {
        if (run.failure) throw run.failure.error;
        const held = unfinished.filter((t) => t.ownerHeld).map((t) => t.title);
        throw new Error(
          held.length
            ? `Waiting for tasks I took over: ${held.join(", ")}. Hand them back to continue.`
            : `No task can start: ${unfinished.map((t) => `${t.title} (${t.state})`).join(", ")}.`,
        );
      }
      // My limit for one job, if I set one; otherwise only the machine's, the Legs' and mine for all.
      const perJob = readSetting(d.db, MAX_TASKS_PER_JOB, z.number().int().min(1).nullable(), null);
      // Tasks that could ever run side by side each get a worktree of their own (ADR-016).
      const own = parallel && canRunSideBySide(all);
      let waiting = 0;
      for (const t of ready) {
        if (run.failure || run.cancelled || ctx.signal.aborted) break;
        const req = {
          jobId: job.id,
          jobTitle: job.title,
          taskId: t.id,
          title: t.title,
          cost: work.costOf(t),
          priority: job.priority,
          allowedLegIds: job.allowedLegIds,
        };
        const wait = (reason: string) => {
          work.waitFor(req, reason);
          waiting++;
        };
        const inTree = inPlace && running.has(inPlace) ? all.find((x) => x.id === inPlace) : null;
        if (inTree) {
          wait(`waits for “${inTree.title}”, which works in the job's own folder`);
          continue;
        }
        if (!own && running.size > 0) {
          wait(
            parallel
              ? "the plan is a chain: its tasks run one after another"
              : "this folder isn't a git repository, so its tasks run one at a time",
          );
          continue;
        }
        // The planner's scopes: a tight overlap waits, a loose one runs beside in its own worktree.
        const overlap = all
          .filter((x) => running.has(x.id))
          .map((x) => ({ x, c: scopeConflict(x.scope, t.scope) }))
          .find((o) => o.c.kind === "tight");
        if (overlap) {
          wait(`overlaps “${overlap.x.title}”: both change ${overlap.c.where}`);
          continue;
        }
        if (perJob !== null && running.size >= perJob) {
          wait(`${running.size} of this job's tasks run at once, the most I allowed in one job`);
          continue;
        }
        const admitted = work.tryStart(req);
        if (!admitted.ok) {
          waiting++;
          continue;
        }
        if (!own) inPlace = t.id;
        const p = runTask(d, ctx, job, t, where, own, stopAll.signal)
          .then((r) => {
            if (r === "cancelled") run.cancelled = true;
          })
          .catch((error) => {
            run.failure ??= { error };
          })
          .finally(() => {
            admitted.release();
            running.delete(t.id);
            if (inPlace === t.id) inPlace = null;
          });
        running.set(t.id, p);
      }
      if (running.size === 0) {
        if (run.failure) throw run.failure.error;
        if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error("Stopped.");
        if (!waiting) return;
      }
      // A task ending, room coming back, or a setting changing: look again.
      await Promise.race([...running.values(), ...(waiting ? [work.changed(2000)] : [])]);
      if (run.cancelled) return await cancelled();
    }
  } finally {
    work.forgetJob(ctx.jobId);
  }
}

/** The work every job's tasks ask before starting (ADR-050); one of its own when none is given. */
const ownWork = new WeakMap<EyeDeps, Work>();
function workOf(d: EyeDeps): Work {
  if (d.work) return d.work;
  let w = ownWork.get(d);
  if (!w) {
    w = new Work({
      db: d.db,
      bus: d.bus,
      registry: d.registry,
      supervisor: d.supervisor,
      now: d.now,
      reading: () => (d.machine ? readingOf(d.machine()) : null),
    });
    ownWork.set(d, w);
  }
  return w;
}

/** A task verified alone that can't be merged this many times stops the job (bug 2). */
const MAX_MERGE_FAILURES = 3;

/**
 * The Verifier for checks outside an attempt (ADR-056 §4): a task's again
 * at its merge (ADR-016), the job's own. In the sandbox, on the job's
 * servers over Oraknid's connection, or answered by Oraknid itself about
 * GitHub, as in the attempt (ADR-049, ADR-038); each command read by the
 * Gate's rules first.
 */
function verifierFor(d: EyeDeps, job: typeof jobs.$inferSelect, where: Where, signal: AbortSignal) {
  const servers = jobServers(d, job.id);
  return createVerifier(d, job, {
    cwd: where.cwd,
    localCommit: (branch, repo) => where.tree.localCommit(branch, repo),
    // Any Leg's toolchain will do: the same sandbox shape as a Leg's.
    plan: () => (job.unsandboxed ? null : sandboxPlan(firstLeg(d), d.sandbox, d.legsDir)),
    servers: () => servers,
    refuse: checkRefusal(d.db, job.id, where.cwd, servers),
    signal,
  });
}

/** Merges of one job happen one at a time. */
const merging = new Map<string, Promise<unknown>>();
function oneMergeAtATime<T>(jobId: string, fn: () => Promise<T>): Promise<T> {
  const next = (merging.get(jobId) ?? Promise.resolve()).then(fn, fn);
  merging.set(
    jobId,
    next.catch(() => {}),
  );
  return next;
}

/** A task's branch beside others: the job branch's name, then the task's. */
const taskBranchOf = (jobBranch: string, taskId: string) =>
  `${jobBranch}--t-${taskId.slice(-6).toLowerCase()}`;

/**
 * A task's own tree in a job across several repos (ADR-042 with ADR-016):
 * its folder mirrors the job's, each repo it touches a worktree on the
 * task's branch from the job branch's tip in that repo, opened there first.
 */
function taskTreeOf(
  d: EyeDeps,
  job: typeof jobs.$inferSelect & { branch: string },
  taskId: string,
  where: Where,
): MultiTree {
  const jobTree = where.tree as MultiTree;
  const end = taskId.slice(-6).toLowerCase();
  return new MultiTree({
    projectPath: where.projectPath,
    jobId: job.id,
    slug: "",
    root: join(where.projectPath, ".oraknid", "worktrees", `${job.id}-t-${end}`),
    repos: projectReposOf(d.db, job.projectId),
    tmpDir: d.tmpDir,
    opened: [],
    save: () => {},
    startId: `${job.id}/t-${end}`,
    task: {
      branch: taskBranchOf(job.branch, taskId),
      base: (r) => {
        jobTree.open(r.name);
        return job.branch;
      },
      fresh: [`refs/oraknid/${job.id}/${taskId}/base`],
    },
  });
}

/**
 * Merges a verified task's branch into the job's tree. In a project of
 * several repos every repo it changed is computed first (`git merge-tree`)
 * and merged only when none conflicts; `undo` takes every one back.
 */
async function mergeTask(
  where: Where,
  own: { branch: string; tree: MultiTree | null },
  jobBranch: string,
  message: string,
): Promise<{ ok: true; undo: () => void } | { ok: false; conflicts: string[] }> {
  if (!own.tree) {
    const g = where.tree.single as Git;
    const m = await mergeTaskBranch(g, own.branch, message);
    return m.ok ? { ok: true, undo: () => undoMerge(g) } : m;
  }
  const jobTree = where.tree as MultiTree;
  const changed = own.tree
    .all()
    .filter((x) => commitsAhead(x.repoPath, jobBranch, own.branch).length > 0);
  const conflicts = changed.flatMap((x) =>
    mergeConflicts(x.repoPath, jobBranch, own.branch).map((f) =>
      x.repo.folder ? `${x.repo.folder}/${f}` : f,
    ),
  );
  if (conflicts.length) return { ok: false, conflicts };
  const merged: { g: Git; before: string }[] = [];
  const undo = () => {
    for (const m of merged.reverse()) git(m.g, ["reset", "-q", "--hard", m.before]);
  };
  for (const x of changed) {
    const { g } = jobTree.open(x.repo.name);
    const before = git(g, ["rev-parse", "HEAD"]).trim();
    const m = await mergeTaskBranch(g, own.branch, message);
    if (!m.ok) {
      undo();
      return {
        ok: false,
        conflicts: m.conflicts.map((f) => (x.repo.folder ? `${x.repo.folder}/${f}` : f)),
      };
    }
    merged.push({ g, before });
  }
  return { ok: true, undo };
}

/** One attempt at one task, applied; in parallel, in its own worktree and merged after (ADR-016). */
async function runTask(
  d: EyeDeps,
  ctx: JobContext,
  job: typeof jobs.$inferSelect,
  task: ReturnType<typeof taskRows>[number],
  where: Where,
  parallel: boolean,
  /** Aborted when another task of the job stopped the job (bug 1). */
  stopped: AbortSignal = new AbortController().signal,
): Promise<"cancelled" | undefined> {
  // The GitHub repo or the server the task needs, asked once and saved to the project (ADR-038).
  await ensureLinks(
    {
      db: d.db,
      bus: d.bus,
      inbox: d.inbox,
      now: d.now,
      ...(d.github ? { github: d.github } : {}),
      ...(d.projects ? { projects: d.projects } : {}),
      ...(d.servers ? { servers: d.servers } : {}),
    },
    ctx,
    job,
    task,
  );
  // Only real failures count (core's SPENDS_ATTEMPT): a pause, a restart or a crash cut an
  // attempt short, it didn't fail (Audit 1 → D1-01); my "try again" spends nothing (bug 10).
  const failures =
    d.db
      .select({ n: count() })
      .from(attempts)
      .where(
        and(
          eq(attempts.taskId, task.id),
          inArray(attempts.outcome, [...SPENDS_ATTEMPT]),
          gte(attempts.startedAt, readSetting(d.db, attemptsFromKey(job.id), z.number(), 0)),
        ),
      )
      .get()?.n ?? 0;
  if (failures >= (d.maxAttempts ?? 8)) {
    throw new Error(`"${task.title}" failed ${failures} attempts. Look at it, then resume.`);
  }
  // An outcome recorded in the journal but not applied before a crash is replayed, not run again
  // (Audit 1 → D1-12): the task's work and my decision on it are never lost or done twice.
  let attemptNo = task.attemptCount + 1;
  if (task.attemptCount > task.settledAttempt) {
    const recorded = d.db
      .select({ status: steps.status })
      .from(steps)
      .where(
        and(
          eq(steps.jobId, job.id),
          eq(steps.stepKey, `task:${task.id}:attempt:${task.attemptCount}`),
        ),
      )
      .get();
    if (recorded?.status === "done") attemptNo = task.attemptCount;
  }
  const attemptJob: AttemptJob = {
    id: job.id,
    title: job.title,
    goal: job.goal,
    autonomy: job.autonomy as Autonomy,
    allowedLegIds: job.allowedLegIds,
    moneyAllowed: ((job.budget as { money?: { limit: number } }).money?.limit ?? 0) > 0,
    waived: job.waived as GatedAction[],
    unsandboxed: job.unsandboxed,
    skillBody: d.skills.version(job.skillId, job.skillVersion)?.body ?? "",
    // Every job may do GitHub work through Oraknid's own tool, judged by its project's link (ADR-038).
    tools: [
      ...(d.tools?.registry.hasBuiltIn("github") &&
      !job.tools.includes("github") &&
      // A server job's place is its server, with no repo to put on GitHub (ADR-049).
      !d.db.select().from(projects).where(eq(projects.id, job.projectId)).get()?.serverId
        ? [...job.tools, "github"]
        : job.tools),
      // The local models' roles, for every agent once a model is here (ADR-054).
      ...(d.tools?.registry.hasBuiltIn("local-models") && !job.tools.includes("local-models")
        ? ["local-models"]
        : []),
      // The project's secrets written on its servers by Oraknid, for a deploy (ADR-059).
      ...(d.tools?.registry.hasBuiltIn("env") &&
      !job.tools.includes("env") &&
      jobHasServers(d.db, job.id)
        ? ["env"]
        : []),
    ],
    serverIds:
      d.db.select().from(projects).where(eq(projects.id, job.projectId)).get()?.serverIds ?? [],
    // Each server's role, production also when I marked the server itself (ADR-049).
    serverRoles: Object.fromEntries(
      jobServers(d, job.id).map((s) => [
        s.id,
        {
          role:
            d.db.select().from(projects).where(eq(projects.id, job.projectId)).get()?.serverRoles[
              s.id
            ]?.role ?? "",
          production: s.production,
        },
      ]),
    ),
    // The server whose own job this is (ADR-049).
    serverJob:
      d.db.select().from(projects).where(eq(projects.id, job.projectId)).get()?.serverId ?? null,
    // The server I chose or confirmed for this job's work on a server (ADR-042).
    server: readSetting(d.db, jobServerKey(job.id), JobServer, { serverId: null, declined: [] })
      .serverId,
    localPorts: projectPorts(d.db, job.projectId),
    ...(where.tree.several
      ? {
          layout: reposLayout(projectReposOf(d.db, job.projectId), where.projectPath),
        }
      : {}),
    skillChecks: skillChecks(d.skills.version(job.skillId, job.skillVersion)?.body ?? ""),
    // The skills I approved for this job (ADR-064 §6) first, then the project's others.
    otherSkills: [
      ...new Set([
        ...readNeeds(d.db, job.id).skills,
        ...(d.db.select().from(projects).where(eq(projects.id, job.projectId)).get()?.skillIds ??
          []),
      ]),
    ]
      .filter((id) => id !== job.skillId)
      .map((id) => d.skills.latest(id))
      .filter((x): x is NonNullable<typeof x> => !!x)
      .map((x) => ({ name: x.name, body: x.body })),
    inputs: renderInputs(job.inputs as JobInput[], where.projectPath),
  };
  // Beside other tasks, it works in a worktree of its own, branched from the job branch (ADR-016);
  // in a project of several repos, a folder of its own with a worktree per repo it touches.
  let taskWhere = where;
  let own: { path: string; branch: string; tree: MultiTree | null } | null = null;
  if (parallel && job.branch && where.tree instanceof MultiTree) {
    const tt = taskTreeOf(d, job as typeof job & { branch: string }, task.id, where);
    own = { path: tt.cwd, branch: taskBranchOf(job.branch, task.id), tree: tt };
  } else if (parallel && job.branch) {
    own = { ...createTaskWorktree(where.projectPath, job.id, task.id, job.branch), tree: null };
    taskWhere = {
      ...where,
      cwd: own.path,
      tree: singleTree(worktreeGit(where.projectPath, own.path), d.tmpDir, where.projectPath),
    };
  }
  if (own) {
    d.db.update(tasks).set({ worktree: own.path }).where(eq(tasks.id, task.id)).run();
    if (own.tree) taskWhere = { ...where, cwd: own.path, tree: own.tree };
  }
  // In a project of several repos, the repos its scope names are worktrees before it starts (ADR-042).
  taskWhere.tree.prepare(task.scope);
  const outcome = await ctx.step(
    `task:${task.id}:attempt:${attemptNo}`,
    { taskId: task.id, attemptNo },
    async (signal) => {
      const result = await runController(
        {
          db: d.db,
          bus: d.bus,
          silk: d.silk,
          inbox: d.inbox,
          registry: d.registry,
          supervisor: d.supervisor,
          sandbox: d.sandbox,
          legsDir: d.legsDir,
          now: d.now,
          brain: d.brain,
          ...(d.tools ? { tools: d.tools } : {}),
          ...(d.effects ? { effects: d.effects } : {}),
          ...(d.machine ? { machine: d.machine } : {}),
          ...(d.servers ? { servers: d.servers } : {}),
          ...(d.github ? { github: d.github } : {}),
          ...(d.stallCheckMs ? { stallCheckMs: d.stallCheckMs } : {}),
          ...(d.driftJudgeMs ? { driftJudgeMs: d.driftJudgeMs } : {}),
          ...(d.visual ? { visual: d.visual } : {}),
        },
        attemptJob,
        task.id,
        taskWhere,
        attemptNo,
        AbortSignal.any([signal, stopped]),
      );
      // Being blocked is not an attempt: fail the step so a resume tries again rather than replaying it.
      if (result.kind === "blocked") {
        setTask(d, job.id, task.id, "ready", result.reason);
        d.db.update(jobs).set({ blockedUntil: result.until }).where(eq(jobs.id, job.id)).run();
        throw new Error(result.reason);
      }
      return result;
    },
  );
  // Merged into the job branch, one task at a time, and checked again there; a conflict or a
  // failing check merges nothing and the task is redone on top of the newer work (ADR-016).
  if (own && outcome.kind === "done") {
    const mine = own;
    const merged = await ctx.step(`task:${task.id}:merge:${attemptNo}`, { attemptNo }, (signal) =>
      oneMergeAtATime(job.id, async () => {
        const m = await mergeTask(where, mine, job.branch as string, `merge: ${task.title}`);
        if (!m.ok)
          return {
            ok: false,
            why: `it conflicted with work merged meanwhile (${m.conflicts.join(", ")})`,
          };
        // With the runners the task's own checks had: on the job's servers, Oraknid's own
        // GitHub checks, the policy; stopped with the job (bug 2).
        const report = await verifierFor(d, job, where, signal).run(task.verify, {
          why: "merge",
        });
        const failed = report.failures[0];
        if (failed) {
          m.undo();
          return { ok: false, why: `\`${failed.command}\` failed once merged with the other work` };
        }
        return { ok: true, why: "" };
      }),
    );
    if (own.tree) own.tree.remove();
    else removeTaskWorktree(where.projectPath, own.path, own.branch);
    d.db.update(tasks).set({ worktree: null }).where(eq(tasks.id, task.id)).run();
    if (!merged.ok) {
      // Verified alone and never merged, again and again: not redone for ever (bug 2).
      const key = `eye.mergeFailures.${task.id}`;
      const times = readSetting(d.db, key, z.number(), 0) + 1;
      writeSetting(d.db, key, z.number(), times);
      if (times >= MAX_MERGE_FAILURES)
        throw new Error(
          `"${task.title}" passed its checks alone but couldn't be merged with the other work ${times} times: ${merged.why}. Look at it, then resume.`,
        );
      d.silk.add({
        jobId: job.id,
        taskId: task.id,
        kind: "issue",
        title: `Not merged: ${task.title}`,
        body: `Its work was verified alone, but ${merged.why}. It is redone on top of the newer work.`,
        authoredBy: "eye",
      });
      setTask(d, job.id, task.id, "ready", `Redone on top of the newer work: ${merged.why}.`);
      d.db.update(tasks).set({ settledAttempt: attemptNo }).where(eq(tasks.id, task.id)).run();
      return;
    }
  }

  // Applied first, then marked settled: a crash in between applies it again, which changes nothing.
  const settle = () =>
    d.db.update(tasks).set({ settledAttempt: attemptNo }).where(eq(tasks.id, task.id)).run();
  // A result from a stale attempt (a later one started, or this one was applied) is dropped
  // (ADR-056 §7).
  const now = d.db.select().from(tasks).where(eq(tasks.id, task.id)).get();
  if (now && EscalationPolicy.stale(attemptNo, now)) return;
  if ((await APPLY[outcome.kind]({ d, ctx, job, task }, outcome as never)) === "cancelled") {
    settle();
    // Read by runTasks: the job's other tasks stop, and none starts (bug 1).
    return "cancelled";
  }
  settle();
}

/** What runTask applies an outcome to. */
interface Applying {
  d: EyeDeps;
  ctx: JobContext;
  job: typeof jobs.$inferSelect;
  task: ReturnType<typeof taskRows>[number];
}

/**
 * A task settled keeps nothing in memory: the judge's verdicts on it, its
 * blocks (bug 6), nor what its attempts remembered across restarts (bug 8).
 */
const forget = (d: EyeDeps, jobId: string, taskId: string) => {
  forgetTaskVerdicts(jobId, taskId);
  forgetDriftVerdicts(jobId, taskId);
  forgetTaskMemory(d.db, jobId, taskId, "the task settled");
};

/** An attempt's outcome, applied to its task and job: one row per kind (ADR-056 §8). */
const APPLY: {
  [K in Exclude<AttemptOutcome["kind"], "blocked">]: (
    a: Applying,
    o: Extract<AttemptOutcome, { kind: K }>,
  ) => "cancelled" | undefined;
} = {
  done: ({ d, job, task }, o) => {
    if (o.commit)
      d.db
        .update(tasks)
        .set({ commit: o.commit, commits: o.commits ?? [] })
        .where(eq(tasks.id, task.id))
        .run();
    setTask(d, job.id, task.id, "done");
    forget(d, job.id, task.id);
    return undefined;
  },
  retry: ({ d, job, task }, o) => {
    setTask(d, job.id, task.id, "ready", o.reason);
    return undefined;
  },
  // Left out by me (ADR-045): with the tasks that need it, when I chose so.
  skipped: ({ d, job, task }, o) => {
    const dropped = o.dependents ? dependentsOf(d.db, job.id, task.id) : [];
    setTask(d, job.id, task.id, "skipped", "Left out by me.", {
      dropped: dropped.map((t) => t.title),
    });
    for (const t of dropped)
      setTask(d, job.id, t.id, "skipped", `Left out with “${task.title}”, which it needs.`, {
        with: task.id,
      });
    for (const t of [task, ...dropped]) forget(d, job.id, t.id);
    return undefined;
  },
  "owner-held": ({ d, job, task }) => {
    d.db.update(tasks).set({ ownerHeld: true, state: "paused" }).where(eq(tasks.id, task.id)).run();
    d.bus.publish({
      type: "task.state",
      topic: `job:${job.id}`,
      jobId: job.id,
      payload: { taskId: task.id, to: "paused", reason: "I took it over." },
    });
    return undefined;
  },
  "cancel-job": ({ ctx }, o) => {
    ctx.setState("cancelled", o.reason);
    return "cancelled";
  },
  // Paused: it waits for its Leg; cancelled: it goes on without it (Jobs-and-Projects → Controls).
  "leg-stopped": ({ d, job, task }, o) => {
    setTask(d, job.id, task.id, "ready", o.reason);
    return undefined;
  },
};

export { ENOUGH, INTERVIEW_DONE } from "./interview.ts";

/**
 * The Eye picks the job's skill among the project's (Skills → Skills per
 * project), records why in Silk, and returns its id; nothing to do once chosen.
 */
export async function pickJobSkill(
  d: Pick<EyeDeps, "db" | "skills" | "brain" | "silk">,
  jobId: string,
  cwd: string,
): Promise<string | null> {
  const first = d.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!first || first.skillChoices.length < 2) return first?.skillId ?? null;
  const offered = first.skillChoices
    .map((id) => d.skills.latest(id))
    .filter((x): x is NonNullable<typeof x> => !!x);
  let pick = { skillId: offered[0]?.id ?? first.skillId, reason: "the project's first skill" };
  try {
    pick = await d.brain.pickSkill({
      jobId,
      cwd,
      goal: first.goal,
      skills: offered.map((x) => ({ id: x.id, name: x.name, description: x.description })),
    });
  } catch (error) {
    if (error instanceof BrainStopped) throw error;
    pick.reason = `no Leg could choose (${error instanceof Error ? error.message : String(error)}), so the project's first`;
  }
  const chosen = d.skills.latest(pick.skillId) ?? offered[0];
  if (!chosen) return null;
  d.db
    .update(jobs)
    .set({ skillId: chosen.id, skillVersion: chosen.version, skillChoices: [] })
    .where(eq(jobs.id, jobId))
    .run();
  d.silk.add({
    jobId,
    kind: "decision",
    title: `Method: ${chosen.name}`,
    body: `The Eye chose **${chosen.name}** from the project's skills (${offered.map((x) => x.name).join(", ")}): ${pick.reason}`,
    authoredBy: "eye",
  });
  return chosen.id;
}

async function interview(
  d: EyeDeps,
  ctx: JobContext,
  job: { id: string; goal: string },
  skillBody: string,
  cwd: string,
) {
  if (d.silk.current(job.id).some((e) => e.kind === "decision" && e.title === INTERVIEW_DONE))
    return;
  if (ctx.state() === "draft") ctx.setState("interviewing");
  // A goal that is a complete spec gets one round, never a dozen (ADR-052 §7).
  const max = specComplete(job.goal) ? 1 : interviewRounds(d.db);
  // Work I'll see or use: the interview asks for its experience section (ADR-064 §4).
  const ui = jobHasUi(d.db, job.id, job.goal);
  for (let n = 1; ; n++) {
    // I said to end it in the conversation while no round was open: planning starts with what's known.
    if (interviewEnded(d.silk, job.id)) {
      await ctx.step(`interview:${n}:close`, { n }, async () => {
        closeInterview(d.silk, job.id, {
          playback: "",
          fallback: "I ended the interview: The Eye plans with what it knows.",
        });
      });
      return;
    }
    const answers = d.silk
      .current(job.id)
      .filter((e) => e.kind === "interview-answer")
      .map((e) => e.body);
    const { asked, draftRounds } = interviewSoFar(d.db, job.id, n);
    // The rounds are used up: one last call, for the playback and what The Eye assumes.
    const final = draftRounds + n - 1 >= max;
    // A round kept from before questions had shapes is read in the new shape (ADR-037).
    const round = InterviewRound.parse(
      await ctx.step(`interview:${n}`, { n }, () =>
        d.brain.interviewRound({
          jobId: job.id,
          cwd,
          goal: job.goal,
          skill: skillExcerpt(skillBody, "interview ask questions owner", 5000),
          answers,
          asked,
          decided: decidedSoFar(d.silk, job.id, asked),
          round: draftRounds + n,
          rounds: max,
          final,
          ...(ui ? { experience: true } : {}),
        }),
      ),
    );
    // The experience section as it stands (ADR-064 §4): kept on the job and in Silk.
    if (ui)
      await ctx.step(`interview:${n}:experience`, { n }, async () => {
        keepExperience(d.db, d.silk, job.id, round.experience);
      });
    // Never the same question twice, nor more than five a round: what's left is new, or nothing is.
    const { fresh } = freshQuestions(normalizeQuestions(round.questions), asked, 5);
    if (round.done || final || fresh.length === 0 || interviewEnded(d.silk, job.id)) {
      await ctx.step(`interview:${n}:close`, { n }, async () => {
        closeInterview(d.silk, job.id, {
          playback: round.playback,
          open: round.open,
          assumptions: round.assumptions ?? [],
          fallback: "The interview found nothing more to ask.",
        });
      });
      return;
    }
    // A crash after opening but before the step was recorded reuses that question (Audit 1 → D1-13).
    const itemId = await ctx.step(
      `interview:${n}:ask`,
      { n },
      async () =>
        d.inbox
          .list({ jobId: job.id, kind: "question", state: "open" })
          .find((i) => i.title === `Interview, round ${n}`)?.id ??
        d.inbox.open({
          kind: "question",
          jobId: job.id,
          raisedBy: "eye",
          title: `Interview, round ${n}`,
          detail: round.playback ? `**What I understood**\n\n${round.playback}` : "",
          options: [ENOUGH],
          defaultOption: null,
          questions: fresh,
        }),
    );
    const item = d.inbox.get(itemId);
    if (item?.state === "open")
      throw new AwaitingOwner(itemId, `Waiting for my answers to interview round ${n}.`);
    const answer = item?.answer ?? "";
    // "Enough, start", or the same in my words, in the inbox or in the conversation.
    const ended = endsRound(answer);
    await ctx.step(`interview:${n}:answer`, { n }, async () => {
      const qs = fresh.map((q, i) => `${i + 1}. ${q.prompt}`).join("\n");
      // My words, verbatim (Skills → The interview, step 4).
      d.silk.add({
        jobId: job.id,
        kind: "interview-answer",
        title: `Interview, round ${n}`,
        body: `${qs}\n\n**My answer:** ${answer}`,
        authoredBy: "owner",
      });
      if (ended)
        closeInterview(d.silk, job.id, {
          playback: round.playback,
          assumptions: round.assumptions ?? [],
          unanswered: fresh,
          fallback: "I ended the interview early.",
        });
    });
    if (ended) return;
  }
}

/** A round as text, for a reader with no component (Silk, an old client). */
export function renderRound(
  round: InterviewRound,
  end = `Answer in your own words, numbered; or choose "${ENOUGH}" to stop here.`,
): string {
  return [
    round.playback ? `**What I understood**\n\n${round.playback}` : "",
    `**Questions**\n\n${renderQuestions(normalizeQuestions(round.questions))}`,
    end,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Careful (the old Supervised, ADR-053): I approve the plan before work starts, and each replan
 * (Approvals → Autonomy levels). A server job's plan that changes the
 * server is approved too, saying what it will change (ADR-049).
 */
async function approvePlanIfCareful(d: EyeDeps, ctx: JobContext) {
  const job = d.db.select().from(jobs).where(eq(jobs.id, ctx.jobId)).get();
  if (!job) return;
  const server = serverPlanApproval(
    d,
    job,
    taskRows(d.db, job.id).filter((t) => t.state !== "done" && t.state !== "skipped"),
  );
  if (job.autonomy !== "careful" && !server) return;
  const version = job.webVersion;
  const summary = d.silk
    .current(job.id)
    .filter(
      (e) =>
        e.kind === "decision" && (e.title === "The plan" || e.title.startsWith("Plan, version")),
    )
    .at(-1);
  const pending = taskRows(d.db, job.id).filter((t) => t.state !== "done" && t.state !== "skipped");
  await ctx.effect(
    {
      key: `plan:${version}`,
      action: "plan.approve",
      payload: { version, tasks: pending.length },
      gated: true,
      title: server
        ? `Approve what will change on ${server}${version === 1 ? "" : ` (plan, version ${version})`}`
        : version === 1
          ? "Approve the plan"
          : `Approve the plan, version ${version}`,
      consequences: {
        approve: server
          ? `Work starts: these changes are made on ${server}, each command through the approvals.`
          : "Work starts on these tasks.",
        deny: "Nothing runs and the job stops (blocked): tell The Eye what to change, then resume it.",
      },
      describe: `${summary?.body.split("\n\n")[0] ?? ""}\n\n${pending
        .map(
          (t) =>
            `- **${t.title}** (${t.kind}, ${t.difficulty}) — may change ${t.scope.join(", ") || "nothing"}; done when ${
              t.verify.map((v) => `\`${v}\``).join(", ") || "reviewed"
            }`,
        )
        .join("\n")}`,
    },
    async () => true,
  );
}

function setTask(
  d: EyeDeps,
  jobId: string,
  taskId: string,
  state: string,
  reason: string | null = null,
  extra: Record<string, unknown> = {},
) {
  d.bus.atomically(() => {
    d.db.update(tasks).set({ state, leaseUntil: null }).where(eq(tasks.id, taskId)).run();
    d.bus.publish({
      type: "task.state",
      topic: `job:${jobId}`,
      jobId,
      payload: { taskId, to: state, reason, ...extra },
    });
  });
}

function silkText(silk: SilkStore, jobId: string) {
  return silk
    .current(jobId)
    .filter(
      (e) => e.kind === "decision" || e.kind === "architecture" || e.kind === "interview-answer",
    )
    .map((e) => `## ${e.title}\n${e.body}`)
    .join("\n\n");
}

/** Job-level checks run in the same sandbox shape as a Leg's (any Leg's toolchain will do). */
function firstLeg(d: EyeDeps) {
  const leg = d.registry.all()[0];
  if (!leg) throw new Error("There are no Legs.");
  return leg;
}

/**
 * The method's excerpt for the plan, with the other skills I approved for
 * this job (ADR-064 §6): each one's name, what it is for, and its short
 * version, so the plan has their tasks (a design before feature code).
 */
function withJobSkills(d: EyeDeps, jobId: string, method: string): string {
  const extra = jobExtraSkills(d.db, d.skills, jobId);
  if (!extra.length) return method;
  return `${method}\n\n# This job's other skills (plan the work each one is for)\n${extra
    .map(
      (x) => `## ${x.name}\n${x.description}\n\n${skillExcerpt(x.body, "plan design tasks", 1500)}`,
    )
    .join("\n\n")}`;
}
