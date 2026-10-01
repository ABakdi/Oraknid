import { join } from "node:path";
import type { Autonomy, WebPlan } from "@oraknid/contracts";
import { type GatedAction, readyTasks, skillExcerpt } from "@oraknid/core";
import type { Sandbox } from "@oraknid/os";
import { asc, eq } from "drizzle-orm";
import type { Db } from "../db/open.ts";
import { jobs, projects, taskEdges, tasks } from "../db/schema.ts";
import type { JobContext, JobProgram } from "../engine/runner.ts";
import type { EventBus } from "../events/bus.ts";
import { newId } from "../ids.ts";
import type { InboxStore } from "../inbox/store.ts";
import { sandboxPlan } from "../legs/plan.ts";
import type { LegRegistry } from "../legs/registry.ts";
import type { LegSupervisor } from "../legs/supervisor.ts";
import type { SilkStore } from "../silk/store.ts";
import type { SkillStore } from "../skills/store.ts";
import { createWorktree, type Git, shadowRepo } from "../workspace/git.ts";
import { type AttemptJob, runAttempt } from "./attempt.ts";
import type { EyeBrain } from "./brain.ts";
import { runVerify } from "./verify.ts";

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
  legsDir: string;
  tmpDir: string;
  now: () => number;
  stallCheckMs?: number;
  /** Attempts per task before The Eye stops and asks me. */
  maxAttempts?: number;
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
    const job0 = d.db.select().from(jobs).where(eq(jobs.id, ctx.jobId)).get();
    if (!job0) throw new Error(`No job ${ctx.jobId}.`);
    const project = d.db.select().from(projects).where(eq(projects.id, job0.projectId)).get();
    if (!project) throw new Error("The job's project is gone.");
    const skill = d.skills.version(job0.skillId, job0.skillVersion);

    // ── The workspace: a worktree on a job branch, or the folder itself with a shadow repo.
    const ws = await ctx.step("workspace", null, async () => {
      if (project.isGitRepo) {
        const wt = createWorktree(project.workspacePath, job0.id, slug(job0.title), {
          release: project.releaseBranch,
          work: project.workBranch,
        });
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
    const g: Git = ws.shadow ? shadowRepo(ws.cwd) : { cwd: ws.cwd, base: [] };
    const where = {
      cwd: ws.cwd,
      g,
      tmpDir: d.tmpDir,
      trash: join(project.workspacePath, ".oraknid", "trash"),
    };

    // A Leg's permission request dies with its session: one still open is stale.
    for (const item of d.inbox.list("open")) {
      if (item.jobId === ctx.jobId && typeof item.raisedBy === "object") d.inbox.withdraw(item.id);
    }

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

    if (ctx.state() === "draft") ctx.setState("planning");

    // ── Plan The Web, once.
    if (taskRows(d.db, ctx.jobId).length === 0) {
      const plan = await ctx.step(
        "plan",
        { goal: job0.goal, skillVersion: job0.skillVersion },
        () =>
          d.brain.plan({
            jobId: job0.id,
            cwd: ws.cwd,
            goal: job0.goal,
            skill: skill ? skillExcerpt(skill.body, "plan phases tasks", 6000) : "",
            silk: silkText(d.silk, job0.id),
            digest: "",
            verify: job0.verify,
          }),
      );
      await ctx.step("web:1", plan, async () => storeWeb(d, job0.id, plan));
    }
    if (ctx.state() === "planning") ctx.setState("running");

    for (;;) {
      // Asked every time, before any work: approved passes through, denied stops (never skipped on a resume).
      await approvePlanIfSupervised(d, ctx);
      await runTasks(d, ctx, where);
      if (ctx.state() === "cancelled") return;

      // ── Job-level verification (BR-1): only this completes a job.
      const job = d.db.select().from(jobs).where(eq(jobs.id, ctx.jobId)).get() as typeof job0;
      ctx.setState("verifying");
      const round = job.verifyRound;
      const results = await ctx.step(
        `job-verify:${round}`,
        { round, verify: job.verify },
        (signal) =>
          job.verify.length
            ? runVerify(
                job.verify,
                ws.cwd,
                job.unsandboxed ? null : sandboxPlan(firstLeg(d), d.sandbox, d.legsDir),
                { signal },
              )
            : Promise.resolve([]),
      );
      const failed = results.find((r) => !r.ok);
      if (!failed) {
        d.silk.add({
          jobId: job.id,
          kind: "progress",
          title: "Job verified",
          body: job.verify.length
            ? `All job-level checks pass: ${job.verify.map((v) => `\`${v}\``).join(", ")}.`
            : "Every task passed its own checks; the job has no job-level checks.",
          authoredBy: "eye",
        });
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
          digest: "",
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

/** Runs ready tasks one at a time (BR-19) until none is left or the job must stop. */
async function runTasks(
  d: EyeDeps,
  ctx: JobContext,
  where: { cwd: string; g: Git; tmpDir: string; trash: string },
) {
  for (;;) {
    const job = d.db.select().from(jobs).where(eq(jobs.id, ctx.jobId)).get();
    if (!job) return;
    const all = taskRows(d.db, ctx.jobId);
    const unfinished = all.filter((t) => t.state !== "done" && t.state !== "skipped");
    if (unfinished.length === 0) return;
    const ready = readyTasks(
      all.filter((t) => !t.ownerHeld && t.state !== "failed" && t.state !== "paused"),
    );
    if (ready.length === 0) {
      const held = unfinished.filter((t) => t.ownerHeld).map((t) => t.title);
      throw new Error(
        held.length
          ? `Waiting for tasks I took over: ${held.join(", ")}. Hand them back to continue.`
          : `No task can start: ${unfinished.map((t) => `${t.title} (${t.state})`).join(", ")}.`,
      );
    }
    const task = ready[0] as (typeof ready)[number];
    if (task.attemptCount >= (d.maxAttempts ?? 8)) {
      throw new Error(
        `"${task.title}" failed ${task.attemptCount} attempts. Look at it, then resume.`,
      );
    }
    const attemptNo = task.attemptCount + 1;
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
    };
    const outcome = await ctx.step(
      `task:${task.id}:attempt:${attemptNo}`,
      { taskId: task.id, attemptNo },
      async (signal) => {
        const result = await runAttempt(
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
            ...(d.stallCheckMs ? { stallCheckMs: d.stallCheckMs } : {}),
          },
          attemptJob,
          task.id,
          where,
          attemptNo,
          signal,
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
    switch (outcome.kind) {
      case "done":
        setTask(d, job.id, task.id, "done");
        break;
      case "retry":
        setTask(d, job.id, task.id, "ready", outcome.reason);
        break;
      case "skipped":
        setTask(d, job.id, task.id, "skipped", "Skipped by me.");
        break;
      case "owner-held":
        d.db
          .update(tasks)
          .set({ ownerHeld: true, state: "paused" })
          .where(eq(tasks.id, task.id))
          .run();
        d.bus.publish({
          type: "task.state",
          topic: `job:${job.id}`,
          jobId: job.id,
          payload: { taskId: task.id, to: "paused", reason: "I took it over." },
        });
        break;
      case "cancel-job":
        ctx.setState("cancelled", outcome.reason);
        return;
    }
  }
}

/** Supervised: I approve the plan before work starts, and each replan (Approvals → Autonomy levels). */
async function approvePlanIfSupervised(d: EyeDeps, ctx: JobContext) {
  const job = d.db.select().from(jobs).where(eq(jobs.id, ctx.jobId)).get();
  if (job?.autonomy !== "supervised") return;
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
      title: version === 1 ? "Approve the plan" : `Approve the plan, version ${version}`,
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
) {
  d.bus.atomically(() => {
    d.db.update(tasks).set({ state, leaseUntil: null }).where(eq(tasks.id, taskId)).run();
    d.bus.publish({
      type: "task.state",
      topic: `job:${jobId}`,
      jobId,
      payload: { taskId, to: state, reason },
    });
  });
}

function taskRows(db: Db, jobId: string) {
  const rows = db
    .select()
    .from(tasks)
    .where(eq(tasks.jobId, jobId))
    .orderBy(asc(tasks.position))
    .all();
  const edges = db.select().from(taskEdges).all();
  return rows.map((t) => ({
    ...t,
    dependsOn: edges.filter((e) => e.taskId === t.id).map((e) => e.dependsOn),
  }));
}

/** Turns a plan into tasks of The Web; a replan adds to it and never touches done tasks. */
function storeWeb(d: EyeDeps, jobId: string, plan: WebPlan) {
  const job = d.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!job) return;
  const existing = taskRows(d.db, jobId);
  const keyToId = new Map(
    existing.filter((t) => t.planKey).map((t) => [t.planKey as string, t.id]),
  );
  let position = existing.length;
  d.bus.atomically(() => {
    for (const t of plan.tasks) {
      if (keyToId.has(t.key)) continue;
      const id = newId(d.now());
      keyToId.set(t.key, id);
      d.db
        .insert(tasks)
        .values({
          id,
          jobId,
          title: t.title,
          instructions: t.instructions,
          kind: t.kind,
          scope: t.scope,
          verify: t.verify,
          requiredCapabilities: t.requiredCapabilities,
          difficulty: t.difficulty,
          state: "pending",
          position: position++,
          planKey: t.key,
        })
        .run();
    }
    for (const t of plan.tasks) {
      for (const dep of t.dependsOn) {
        const from = keyToId.get(t.key);
        const to = keyToId.get(dep);
        if (from && to)
          d.db
            .insert(taskEdges)
            .values({ taskId: from, dependsOn: to })
            .onConflictDoNothing()
            .run();
      }
    }
    const verify = [...new Set([...job.verify, ...plan.jobVerify])];
    d.db
      .update(jobs)
      .set({ webVersion: job.webVersion + 1, verify })
      .where(eq(jobs.id, jobId))
      .run();
    d.bus.publish({
      type: "web.updated",
      topic: `job:${jobId}`,
      jobId,
      payload: { version: job.webVersion + 1, added: plan.tasks.length },
    });
  });
  d.silk.add({
    jobId,
    kind: "decision",
    title: job.webVersion === 0 ? "The plan" : `Plan, version ${job.webVersion + 1}`,
    body: `${plan.summary}\n\n${plan.tasks.map((t) => `- **${t.title}** (${t.kind}, ${t.difficulty})`).join("\n")}`,
    authoredBy: "eye",
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
