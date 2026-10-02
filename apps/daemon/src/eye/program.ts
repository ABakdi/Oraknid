import { join, resolve } from "node:path";
import type {
  Autonomy,
  InterviewRound,
  JobInput,
  MetricsSample,
  WebPlan,
} from "@oraknid/contracts";
import {
  decide,
  type GatedAction,
  readyTasks,
  scopesOverlap,
  skillChecks,
  skillExcerpt,
  suspicious,
} from "@oraknid/core";
import type { Sandbox } from "@oraknid/os";
import { and, asc, count, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/open.ts";
import { attempts, jobs, projects, steps, taskEdges, tasks } from "../db/schema.ts";
import type { SideEffects } from "../engine/effects.ts";
import { AwaitingOwner } from "../engine/effects.ts";
import type { JobContext, JobProgram } from "../engine/runner.ts";
import type { EventBus } from "../events/bus.ts";
import { newId } from "../ids.ts";
import type { InboxStore } from "../inbox/store.ts";
import { sandboxPlan } from "../legs/plan.ts";
import type { LegRegistry } from "../legs/registry.ts";
import type { LegSupervisor } from "../legs/supervisor.ts";
import { MAX_TASKS_PER_JOB, readSetting } from "../settings.ts";
import type { SilkStore } from "../silk/store.ts";
import type { SkillStore } from "../skills/store.ts";
import type { McpBroker } from "../tools/broker.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import {
  createTaskWorktree,
  createWorktree,
  type Git,
  mergeTaskBranch,
  removeTaskWorktree,
  shadowRepo,
  undoMerge,
  worktreeGit,
} from "../workspace/git.ts";
import { type AttemptJob, runAttempt } from "./attempt.ts";
import type { EyeBrain } from "./brain.ts";
import { readSmall, renderInputs } from "./inputs.ts";
import { policyFor } from "./policy.ts";
import { runVerify, verifyRefusal } from "./verify.ts";

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
  /** Recent metrics, for resource-aware scheduling (ADR-016). */
  machine?: () => MetricsSample[];
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
    const g: Git = ws.shadow ? shadowRepo(ws.cwd) : worktreeGit(project.workspacePath, ws.cwd);
    const where = {
      cwd: ws.cwd,
      g,
      tmpDir: d.tmpDir,
      trash: join(project.workspacePath, ".oraknid", "trash"),
      projectPath: project.workspacePath,
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

    // Untrusted inputs are looked at once for attempts to steer the agent (Security → Prompt injection).
    await ctx.step("untrusted-scan", null, async () => {
      for (const input of (job0.inputs as JobInput[]).filter((i) => i.untrusted)) {
        const text =
          input.kind === "file" ? readSmall(resolve(project.workspacePath, input.ref)) : null;
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
    if (skill?.interview) await interview(d, ctx, job0, skill.body, ws.cwd);

    if (ctx.state() === "draft" || ctx.state() === "interviewing") ctx.setState("planning");

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
      await runTasks(d, ctx, where, !ws.shadow);
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
                {
                  signal,
                  refuse: (command) =>
                    verifyRefusal(
                      decide(
                        { tool: "Bash", command, path: null },
                        policyFor(d.db, job.id, ws.cwd),
                      ),
                    ),
                },
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
  where: { cwd: string; g: Git; tmpDir: string; trash: string; projectPath: string },
  parallel = false,
) {
  const running = new Map<string, Promise<void>>();
  // Written by the running tasks' callbacks.
  const run: { failure: { error: unknown } | null; cancelled: boolean } = {
    failure: null,
    cancelled: false,
  };
  for (;;) {
    const job = d.db.select().from(jobs).where(eq(jobs.id, ctx.jobId)).get();
    if (!job) return;
    const all = taskRows(d.db, ctx.jobId);
    const unfinished = all.filter((t) => t.state !== "done" && t.state !== "skipped");
    if (unfinished.length === 0 && running.size === 0) return;
    const ready = readyTasks(
      all.filter((t) => !t.ownerHeld && t.state !== "failed" && t.state !== "paused"),
    ).filter((t) => !running.has(t.id));
    if (ready.length === 0 && running.size > 0) {
      await Promise.race(running.values());
      if (run.cancelled) {
        await Promise.allSettled(running.values());
        return;
      }
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
    // Tasks side by side (ADR-016): as many as the per-job limit allows, whose scopes can't overlap.
    const limit = parallel ? tasksAtOnce(d) : 1;
    for (const t of ready) {
      if (running.size >= limit || run.failure) break;
      if (running.has(t.id)) continue;
      const others = all.filter((x) => running.has(x.id));
      if (others.some((x) => scopesOverlap(x.scope, t.scope))) continue;
      const p = runTask(d, ctx, job, t, where, limit > 1)
        .then((r) => {
          if (r === "cancelled") run.cancelled = true;
        })
        .catch((error) => {
          run.failure ??= { error };
        })
        .finally(() => running.delete(t.id));
      running.set(t.id, p);
    }
    if (running.size === 0) {
      if (run.failure) throw run.failure.error;
      return;
    }
    await Promise.race(running.values());
    if (run.cancelled) {
      await Promise.allSettled(running.values());
      return;
    }
  }
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

/** How many tasks of one job run at once (ADR-016); one by default. */
function tasksAtOnce(d: EyeDeps): number {
  return readSetting(d.db, MAX_TASKS_PER_JOB, z.number().int().min(1), 1);
}

/** One attempt at one task, applied; in parallel, in its own worktree and merged after (ADR-016). */
async function runTask(
  d: EyeDeps,
  ctx: JobContext,
  job: typeof jobs.$inferSelect,
  task: ReturnType<typeof taskRows>[number],
  where: { cwd: string; g: Git; tmpDir: string; trash: string; projectPath: string },
  parallel: boolean,
): Promise<"cancelled" | undefined> {
  // Only real failures count: a pause, a restart or a crash cut an attempt short, it didn't fail (Audit 1 → D1-01).
  const failures =
    d.db
      .select({ n: count() })
      .from(attempts)
      .where(and(eq(attempts.taskId, task.id), inArray(attempts.outcome, ["failed", "reassigned"])))
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
    tools: job.tools,
    skillChecks: skillChecks(d.skills.version(job.skillId, job.skillVersion)?.body ?? ""),
    inputs: renderInputs(job.inputs as JobInput[], where.projectPath),
  };
  // Beside other tasks, it works in a worktree of its own, branched from the job branch (ADR-016).
  let taskWhere = where;
  let own: { path: string; branch: string } | null = null;
  if (parallel && job.branch) {
    own = createTaskWorktree(where.projectPath, job.id, task.id, job.branch);
    d.db.update(tasks).set({ worktree: own.path }).where(eq(tasks.id, task.id)).run();
    taskWhere = { ...where, cwd: own.path, g: worktreeGit(where.projectPath, own.path) };
  }
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
          brain: d.brain,
          ...(d.tools ? { tools: d.tools } : {}),
          ...(d.effects ? { effects: d.effects } : {}),
          ...(d.machine ? { machine: d.machine } : {}),
          ...(d.stallCheckMs ? { stallCheckMs: d.stallCheckMs } : {}),
        },
        attemptJob,
        task.id,
        taskWhere,
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
  // Merged into the job branch, one task at a time, and checked again there; a conflict or a
  // failing check merges nothing and the task is redone on top of the newer work (ADR-016).
  if (own && outcome.kind === "done") {
    const branch = own.branch;
    const merged = await ctx.step(`task:${task.id}:merge:${attemptNo}`, { attemptNo }, () =>
      oneMergeAtATime(job.id, async () => {
        const m = await mergeTaskBranch(where.g, branch, `merge: ${task.title}`);
        if (!m.ok)
          return {
            ok: false,
            why: `it conflicted with work merged meanwhile (${m.conflicts.join(", ")})`,
          };
        const results = await runVerify(
          task.verify,
          where.cwd,
          job.unsandboxed ? null : sandboxPlan(firstLeg(d), d.sandbox, d.legsDir),
          {
            refuse: (command) =>
              verifyRefusal(
                decide({ tool: "Bash", command, path: null }, policyFor(d.db, job.id, where.cwd)),
              ),
          },
        );
        const failed = results.find((r) => !r.ok);
        if (failed) {
          undoMerge(where.g);
          return { ok: false, why: `\`${failed.command}\` failed once merged with the other work` };
        }
        return { ok: true, why: "" };
      }),
    );
    removeTaskWorktree(where.projectPath, own.path, own.branch);
    d.db.update(tasks).set({ worktree: null }).where(eq(tasks.id, task.id)).run();
    if (!merged.ok) {
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
  switch (outcome.kind) {
    case "done":
      if (outcome.commit)
        d.db.update(tasks).set({ commit: outcome.commit }).where(eq(tasks.id, task.id)).run();
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
      settle();
      return;
  }
  settle();
}

export const ENOUGH = "Enough, start";
const INTERVIEW_DONE = "What I want (interview)";

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
  for (let n = 1; ; n++) {
    const answers = d.silk
      .current(job.id)
      .filter((e) => e.kind === "interview-answer")
      .map((e) => e.body);
    const round = await ctx.step(`interview:${n}`, { n }, () =>
      d.brain.interviewRound({
        jobId: job.id,
        cwd,
        goal: job.goal,
        skill: skillExcerpt(skillBody, "interview ask questions owner", 5000),
        answers,
      }),
    );
    if (round.done || n > 12) {
      await ctx.step(`interview:${n}:close`, { n }, async () => {
        d.silk.add({
          jobId: job.id,
          kind: "decision",
          title: INTERVIEW_DONE,
          body: round.playback || "The interview found nothing more to ask.",
          authoredBy: "eye",
        });
        for (const point of round.open)
          d.silk.add({
            jobId: job.id,
            kind: "issue",
            title: `Open question: ${point.slice(0, 80)}`,
            body: point,
            authoredBy: "eye",
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
          detail: renderRound(round),
          options: [ENOUGH],
          defaultOption: null,
        }),
    );
    const item = d.inbox.get(itemId);
    if (item?.state === "open")
      throw new AwaitingOwner(itemId, `Waiting for my answers to interview round ${n}.`);
    const answer = item?.answer ?? "";
    await ctx.step(`interview:${n}:answer`, { n }, async () => {
      const qs = round.questions.map((q, i) => `${i + 1}. ${q.question}`).join("\n");
      // My words, verbatim (Skills → The interview, step 4).
      d.silk.add({
        jobId: job.id,
        kind: "interview-answer",
        title: `Interview, round ${n}`,
        body: `${qs}\n\n**My answer:** ${answer}`,
        authoredBy: "owner",
      });
      if (answer === ENOUGH) {
        for (const q of round.questions) {
          d.silk.add({
            jobId: job.id,
            kind: "issue",
            title: `Open question: ${q.question.slice(0, 80)}`,
            body: `${q.question} (left open when I ended the interview)`,
            authoredBy: "eye",
          });
        }
        d.silk.add({
          jobId: job.id,
          kind: "decision",
          title: INTERVIEW_DONE,
          body: round.playback || "I ended the interview early.",
          authoredBy: "eye",
        });
      }
    });
    if (answer === ENOUGH) return;
  }
}

function renderRound(round: InterviewRound): string {
  return [
    round.playback ? `**What I understood**\n\n${round.playback}` : "",
    `**Questions**\n\n${round.questions
      .map(
        (q, i) =>
          `${i + 1}. ${q.question}${q.options.length ? `\n   Options: ${q.options.join(" · ")}${q.recommended ? ` (recommended: ${q.recommended})` : ""}` : ""}`,
      )
      .join("\n")}`,
    `Answer in your own words, numbered; or choose "${ENOUGH}" to stop here.`,
  ]
    .filter(Boolean)
    .join("\n\n");
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
  const edges = db
    .select({ taskId: taskEdges.taskId, dependsOn: taskEdges.dependsOn })
    .from(taskEdges)
    .innerJoin(tasks, eq(tasks.id, taskEdges.taskId))
    .where(eq(tasks.jobId, jobId))
    .all();
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
