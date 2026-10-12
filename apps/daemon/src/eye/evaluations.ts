import { existsSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import {
  DEFAULT_PROJECT_WORK,
  type EvaluationEdit,
  EvaluationKind,
  Evaluations,
  type PlannedEvaluation,
  ProjectWorkSettings,
  type TaskEvaluation,
  type WebPlan,
} from "@oraknid/contracts";
import { EVALUATION_WORDS, evaluationTask, isEvaluation, meaningWords } from "@oraknid/core";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/open.ts";
import { jobs, taskEdges, tasks } from "../db/schema.ts";
import type { JobContext } from "../engine/runner.ts";
import type { EventBus } from "../events/bus.ts";
import { AttemptLog } from "../harness/log.ts";
import {
  inboxReviews,
  type ReviewNote,
  type ReviewOutcome,
  type ReviewPort,
  type ReviewTarget,
} from "../harness/reviews.ts";
import type { InboxStore } from "../inbox/store.ts";
import { sandboxPlan } from "../legs/plan.ts";
import type { LegRegistry } from "../legs/registry.ts";
import { pagesIn } from "../reviews/screens.ts";
import { projectPorts, readSetting, writeSetting } from "../settings.ts";
import type { SilkStore } from "../silk/store.ts";
import { BrainStopped, type EyeBrain } from "./brain.ts";
import type { Failure, RecoveryResult } from "./recovery.ts";
import { httpRenderChecker, type RenderCheck, type RenderChecker } from "./render-check.ts";
import {
  bringUp,
  freePort,
  runningApp,
  runWay,
  serveStatic,
  stopApp,
  type Tried,
  type Way,
  waysToRun,
  wayWords,
} from "./run-app.ts";
import { storeWeb, taskRows } from "./web-store.ts";

// Evaluation steps at work (ADR-064 §1–§3, M16.2): an evaluation node of
// The Web opens a review for me through the ReviewPort, the job waits on
// it while nothing else can go on, and what I say comes back: approved,
// the node is done and the tasks after it go on; notes, The Eye turns them
// into tasks before the node (keep-notes kept in Silk as decisions every
// later task is given), and the next round opens after them.

/** What an evaluation step needs of the job's program. */
export interface EvaluationDeps {
  db: Db;
  bus: EventBus;
  silk: SilkStore;
  inbox: InboxStore;
  brain: EyeBrain;
  registry: LegRegistry;
  sandbox: import("@oraknid/os").Sandbox;
  legsDir: string;
  now: () => number;
  reviews?: ReviewPort;
  /** How long an app may take to answer (tests make it short). */
  appWaitMs?: number;
  /** Looks at what a review would show before it is shown (ADR-069 §4); the HTTP look without one. */
  renderCheck?: RenderChecker;
}

/**
 * A recovery agent for what a review can't show (ADR-069 §3, ADR-067's
 * steward principle): the job's own recovery, given the failure, what to
 * do again after (told the recovery task, to read its report), and what
 * the agent must know.
 */
export type RecoverShown = (
  failure: Failure,
  retry: (recoveryTaskId: string) => Promise<string | null>,
  context: string,
) => Promise<RecoveryResult>;

// ── Settings: the project's, and a job's own ─────────────────────────

export const projectWorkKey = (projectId: string) => `project.work.${projectId}`;
export const projectWork = (db: Db, projectId: string): ProjectWorkSettings =>
  readSetting(db, projectWorkKey(projectId), ProjectWorkSettings, DEFAULT_PROJECT_WORK);

/** A job's own choice on New work or in the chat; null: the project's. */
export const jobEvaluationsKey = (jobId: string) => `job.evaluations.${jobId}`;
export const jobEvaluationsOwn = (db: Db, jobId: string): Evaluations | null =>
  readSetting(db, jobEvaluationsKey(jobId), Evaluations.nullable(), null);

/** The evaluation steps a job gets: its own choice, else its project's. */
export function jobEvaluations(db: Db, jobId: string): Evaluations {
  const own = jobEvaluationsOwn(db, jobId);
  if (own) return own;
  const job = db.select({ projectId: jobs.projectId }).from(jobs).where(eq(jobs.id, jobId)).get();
  return job ? projectWork(db, job.projectId).evaluations : DEFAULT_PROJECT_WORK.evaluations;
}

// ── An evaluation step's own state ────────────────────────────────────

const WaySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("command"), command: z.string(), from: z.string() }),
  z.object({ kind: z.literal("build"), command: z.string(), from: z.string() }),
  z.object({ kind: z.literal("static"), dir: z.string(), from: z.string() }),
]);

export const EvaluationState = z.object({
  kind: EvaluationKind,
  why: z.string(),
  run: z.string().nullable().default(null),
  round: z.number().int().positive().default(1),
  reviewId: z.string().nullable().default(null),
  url: z.string().nullable().default(null),
  /** The app's port, while its review is open. */
  port: z.number().int().nullable().default(null),
  openedAt: z.number().nullable().default(null),
  passAt: z.number().nullable().default(null),
  outcome: z.enum(["approved", "auto-passed", "skipped"]).nullable().default(null),
  /**
   * What the review shows (ADR-069): the app on its port, the design's
   * folder, or nothing (it didn't start: the page says why). Null: opened
   * before ADR-069, healed at the next look when it is an app's.
   */
  shows: z.enum(["app", "design", "nothing"]).nullable().default(null),
  /** The way that runs the app, to run it again after a restart. */
  way: WaySchema.nullable().default(null),
  /** The devices Oraknid saw it render at. */
  checked: z.array(z.string()).default([]),
  /** Why it shows nothing, in plain words; and each way tried. */
  problem: z.string().nullable().default(null),
  tried: z.array(z.string()).default([]),
  /** How many times this round was prepared again (Try again, a heal): each its own journal step. */
  prepared: z.number().int().nonnegative().default(0),
  /** Try again was asked (the page, the chat): prepared again at the next look. */
  retry: z.boolean().default(false),
});
export type EvaluationState = z.infer<typeof EvaluationState>;

export const evaluationKey = (taskId: string) => `task.evaluation.${taskId}`;
export const readEvaluation = (db: Db, taskId: string): EvaluationState | null =>
  readSetting(db, evaluationKey(taskId), EvaluationState.nullable(), null);
const writeEvaluation = (db: Db, taskId: string, s: EvaluationState) =>
  writeSetting(db, evaluationKey(taskId), EvaluationState, s);

/** A new evaluation node's state, written when it enters The Web. */
export function rememberEvaluation(db: Db, taskId: string, e: PlannedEvaluation) {
  writeEvaluation(
    db,
    taskId,
    EvaluationState.parse({ kind: e.kind, why: e.why, run: e.run ?? null }),
  );
}

/** The step as the job's page shows it. */
export function evaluationView(db: Db, taskId: string, state: string): TaskEvaluation | null {
  const s = readEvaluation(db, taskId);
  if (!s) return null;
  return {
    kind: s.kind,
    why: s.why,
    round: s.round,
    reviewId: s.reviewId,
    url: s.url,
    waiting: !!s.reviewId && !s.outcome && state !== "done" && state !== "skipped",
    passAt: s.passAt,
    outcome: s.outcome,
  };
}

const what = (kind: EvaluationKind) => EVALUATION_WORDS[kind].does;
export const waitingWords = (kind: EvaluationKind, url: string | null, problem?: string | null) =>
  problem
    ? `${kind === "design" ? "The design couldn't be shown" : "The app didn't start"} for your review: ${problem}${url ? ` — Open ${url} to try again` : ""}`
    : `Waiting for your review of ${what(kind)}${url ? ` — Open ${url}` : ""}`;

/** The port the daemon gave, else the inbox's (one per daemon parts). */
const fallback = new WeakMap<object, ReviewPort>();
export function reviewPortOf(d: EvaluationDeps): ReviewPort {
  if (d.reviews) return d.reviews;
  let p = fallback.get(d.inbox);
  if (!p) {
    p = inboxReviews({ bus: d.bus, inbox: d.inbox });
    fallback.set(d.inbox, p);
  }
  return p;
}

function setState(d: EvaluationDeps, jobId: string, taskId: string, state: string, reason: string) {
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

type Row = ReturnType<typeof taskRows>[number];
type JobRow = typeof jobs.$inferSelect;

/** The design's folder in the job's folder: the reviewed design task's, else `design/`. */
function designFolder(rows: Row[], step: Row): string {
  const reviewed = rows.filter((r) => step.dependsOn.includes(r.id));
  for (const g of reviewed.flatMap((r) => r.scope)) {
    const parts = g.replace(/^\.\//, "").split("/");
    const at = parts.findIndex((p) => /^design$/i.test(p));
    if (at >= 0) return parts.slice(0, at + 1).join("/");
  }
  return "design";
}

/** Where a step stands after one look: settled (done, or more work before it), or waiting for me. */
export type Advance =
  | { kind: "settled" }
  | { kind: "waiting"; taskId: string; reviewId: string; reason: string; passAt: number | null };

/**
 * One look at an evaluation step that is ready: its round's review opened
 * once (journaled), the app started for an app review, then what I said
 * applied. Called again on each pass of the job's loop and after a restart.
 */
export async function advanceEvaluation(
  d: EvaluationDeps,
  ctx: JobContext,
  job: JobRow,
  step: Row,
  cwd: string,
  o: { recover?: RecoverShown } = {},
): Promise<Advance> {
  const port = reviewPortOf(d);
  let st =
    readEvaluation(d.db, step.id) ?? EvaluationState.parse({ kind: "checkpoint", why: step.title });
  if (!st.reviewId) {
    const round = st.round;
    const opened = await ctx.step(
      `evaluation:${step.id}:${round}:open`,
      { round },
      async (signal) => openRound(d, job, step, st, cwd, port, signal, o.recover),
    );
    st = { ...st, ...opened };
    writeEvaluation(d.db, step.id, st);
    d.bus.publish({
      type: "task.review-opened",
      topic: `job:${job.id}`,
      jobId: job.id,
      payload: {
        taskId: step.id,
        kind: st.kind,
        round,
        reviewId: st.reviewId,
        url: st.url,
        shows: st.shows,
        checked: st.checked,
        problem: st.problem,
      },
    });
  } else if (
    !st.outcome &&
    !port.outcome(st.reviewId) &&
    (await needsPreparing(d, job, step, st, cwd, ctx.signal))
  ) {
    // Try again, or a review that shows what can't render (ADR-069 §5–6): prepared again, the same review.
    const round = st.round;
    const n = st.prepared + 1;
    const again = await ctx.step(
      `evaluation:${step.id}:${round}:prepare:${n}`,
      { round, n },
      async (signal) => openRound(d, job, step, st, cwd, port, signal, o.recover, true),
    );
    // Its time to pass by itself is the first opening's.
    st = { ...st, ...again, openedAt: st.openedAt, passAt: st.passAt, prepared: n, retry: false };
    writeEvaluation(d.db, step.id, st);
    d.bus.publish({
      type: "task.review-opened",
      topic: `job:${job.id}`,
      jobId: job.id,
      payload: {
        taskId: step.id,
        kind: st.kind,
        round,
        reviewId: st.reviewId,
        url: st.url,
        shows: st.shows,
        checked: st.checked,
        problem: st.problem,
        again: n,
      },
    });
  }
  const reviewId = st.reviewId as string;
  let outcome: ReviewOutcome | null = port.outcome(reviewId);
  let auto = false;
  if (!outcome && st.passAt !== null && d.now() >= st.passAt) {
    outcome = { kind: "approved" };
    auto = true;
  }
  if (!outcome)
    return {
      kind: "waiting",
      taskId: step.id,
      reviewId,
      reason: waitingWords(st.kind, st.url, st.shows === "nothing" ? st.problem : null),
      passAt: st.passAt,
    };
  const round = st.round;
  if (outcome.kind === "approved") {
    await ctx.step(`evaluation:${step.id}:${round}:approved`, { round, auto }, async () => {
      stopApp(step.id);
      writeEvaluation(d.db, step.id, {
        ...st,
        port: null,
        outcome: auto ? "auto-passed" : "approved",
      });
      d.silk.add({
        jobId: job.id,
        taskId: step.id,
        kind: "progress",
        title: auto ? `Passed by itself: ${step.title}` : `Approved: ${step.title}`,
        body: auto
          ? `No word from the owner on ${what(st.kind)} in the time the project allows: it passed by itself (round ${round}).`
          : `The owner approved ${what(st.kind)} (round ${round}). The work after it goes on.`,
        authoredBy: auto ? "eye" : "owner",
      });
      setState(d, job.id, step.id, "done", auto ? "Passed by itself." : "Approved by me.");
      return null;
    });
    return { kind: "settled" };
  }
  const notes = outcome.notes;
  await ctx.step(
    `evaluation:${step.id}:${round}:notes`,
    { round, notes: notes.length },
    async () => {
      stopApp(step.id);
      const added = await notesToWork(d, job, step, st, notes);
      writeEvaluation(d.db, step.id, {
        ...st,
        round: round + 1,
        reviewId: null,
        url: null,
        port: null,
        openedAt: null,
        passAt: null,
      });
      setState(
        d,
        job.id,
        step.id,
        "pending",
        added
          ? `My notes came back as ${added === 1 ? "a task" : `${added} tasks`}; round ${round + 1} opens after ${added === 1 ? "it" : "them"}.`
          : `Round ${round + 1} opens now.`,
      );
      return added;
    },
  );
  return { kind: "settled" };
}

const planFor = (d: EvaluationDeps, job: JobRow) => {
  const leg = d.registry.all()[0];
  return job.unsandboxed || !leg
    ? null
    : sandboxPlan(leg, d.sandbox, d.legsDir, projectPorts(d.db, job.projectId), job.id);
};

type Opened = Pick<
  EvaluationState,
  | "reviewId"
  | "url"
  | "port"
  | "openedAt"
  | "passAt"
  | "shows"
  | "way"
  | "checked"
  | "problem"
  | "tried"
>;

/**
 * A round's review opened (ADR-069): what it shows prepared first and
 * seen to render (`prepareShown`), then opened through the port: the app
 * on its port, the design's folder, or, when nothing renders, the review
 * on why, with Try again. Called again on the same review (`again`) for
 * Try again and to heal a review that shows what can't render.
 */
async function openRound(
  d: EvaluationDeps,
  job: JobRow,
  step: Row,
  st: EvaluationState,
  cwd: string,
  port: ReviewPort,
  signal: AbortSignal,
  recoverShown?: RecoverShown,
  again = false,
): Promise<Opened> {
  if (again) stopApp(step.id);
  const p = await prepareShown(d, job, step, st, cwd, port, signal, recoverShown);
  const kind: "design" | "app" =
    p.shows === "design"
      ? "design"
      : p.shows === "app"
        ? "app"
        : st.kind === "design"
          ? "design"
          : "app";
  const lines = p.tried.map((t) => `- ${t}`).join("\n");
  d.silk.add({
    jobId: job.id,
    taskId: step.id,
    kind: p.shows === "nothing" ? "issue" : "progress",
    title:
      p.shows === "nothing"
        ? `Review of ${what(st.kind)}: ${st.kind === "design" ? "the design couldn't be shown" : "the app didn't start"}`
        : `Review of ${what(st.kind)}: ${p.checked.length ? `renders on ${p.checked.join(", ")}` : "ready"}`,
    body:
      p.shows === "nothing"
        ? `${p.problem}\n\nOraknid tried:\n${lines || "- nothing: nothing says how it runs"}\n\nThe review says so, with Try again; nothing that can't render is shown.`
        : `${p.shows === "app" ? `The app runs on port ${p.port}${p.way ? ` (${wayWords(p.way)})` : ""}` : "The design's folder"}; Oraknid loaded it itself before showing it${p.checked.length ? ` and saw it render on ${p.checked.join(", ")}` : ""}.${p.tried.length > 1 ? `\n\nTried on the way:\n${lines}` : ""}`,
    authoredBy: "eye",
  });
  const opened = await port.open({
    jobId: job.id,
    stepTaskId: step.id,
    projectId: job.projectId,
    kind,
    target: p.target,
    round: st.round,
    title: `${step.title}: ${st.why}`,
    ...(p.shows === "nothing" ? { problem: { reason: p.problem ?? "", tried: p.tried } } : {}),
    checked: p.checked,
  });
  const minutes = projectWork(d.db, job.projectId).autoPassMinutes;
  const at = d.now();
  return {
    reviewId: opened.reviewId,
    url: opened.url,
    port: p.port,
    openedAt: at,
    passAt: minutes ? at + Math.round(minutes * 60_000) : null,
    shows: p.shows,
    way: p.way,
    checked: p.checked,
    problem: p.problem,
    tried: p.tried,
  };
}

interface Prepared {
  target: ReviewTarget;
  shows: "app" | "design" | "nothing";
  port: number | null;
  way: Way | null;
  checked: string[];
  problem: string | null;
  tried: string[];
}

const brief = (s: string, n = 400) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** "RUN: <command>" in the recovery agent's report: the command it says starts the app. */
export function agentRunCommand(report: string): string | null {
  const m = /^\s*(?:[-*]\s*)?\**RUN\**:\s*`?([^`\n]+?)`?\s*$/im.exec(report);
  return m?.[1]?.trim() || null;
}

/** What the recovery agent said, its latest words first. */
const agentReport = (d: EvaluationDeps, taskId: string) =>
  new AttemptLog(d.db)
    .task(taskId, { kinds: ["AgentText"], limit: 6 })
    .map((e) => e.data.text)
    .reverse()
    .join("\n");

/**
 * What a review will show, seen to render first (ADR-069 §1–§5). A
 * design: its folder, each page loaded at the review's devices. An app
 * (or a checkpoint): the ladder of ways to run it, each checked; then,
 * when none renders, a recovery agent in the job's tree, twice at most,
 * the ladder again after each with the command it says. A checkpoint with
 * a design and no app that runs shows the design. Never a folder of source
 * code: when nothing renders, nothing is shown, and why is said.
 */
async function prepareShown(
  d: EvaluationDeps,
  job: JobRow,
  step: Row,
  st: EvaluationState,
  cwd: string,
  port: ReviewPort,
  signal: AbortSignal,
  recoverShown?: RecoverShown,
): Promise<Prepared> {
  const rows = taskRows(d.db, job.id);
  const designDir = join(cwd, designFolder(rows, step));
  const checker = d.renderCheck ?? httpRenderChecker();
  const tried: string[] = [];
  const say = (t: Tried) => {
    d.bus.publish({
      type: "task.review-try",
      topic: `job:${job.id}`,
      jobId: job.id,
      payload: { taskId: step.id, way: t.way, ok: t.ok, reason: t.reason?.slice(0, 1500) ?? null },
    });
  };

  /** The design's pages, each loaded through the review's frame at the review's devices. */
  const checkDesign = async (): Promise<RenderCheck> => {
    const pages = existsSync(join(designDir, "index.html"))
      ? ["/"]
      : pagesIn(designDir)
          .slice(0, 6)
          .map((p) => `/${encodeURI(p)}`);
    if (!pages.length)
      return {
        ok: false,
        reason: `the design's folder (${relative(cwd, designDir) || "."}) has no page in it`,
        devices: [],
        how: "http",
      };
    let last: RenderCheck | null = null;
    for (const entry of pages) {
      last = await checkAt({ kind: "folder", path: designDir }, entry);
      if (!last.ok) return { ...last, reason: `${entry}: ${last.reason}` };
    }
    return last as RenderCheck;
  };
  const checkAt = async (
    target: Exclude<ReviewTarget, { kind: "none" }>,
    entry = "/",
  ): Promise<RenderCheck> => {
    const kind = target.kind === "folder" ? "design" : "app";
    let pv: { url: string; close: () => void } | null = null;
    try {
      pv = port.preview?.({ jobId: job.id, kind, target, entry }) ?? null;
    } catch (error) {
      // The review page wouldn't show it either (Oraknid's own port, a folder outside the project).
      return { ok: false, reason: (error as Error).message, devices: [], how: "http" };
    }
    try {
      if (pv) return await checker.check({ url: pv.url, signal });
      if (target.kind === "port")
        return await checker.check({ url: `http://127.0.0.1:${target.port}${entry}`, signal });
      // No frame to load it through: the folder served as it is, for the look only.
      const id = `check:${step.id}`;
      const app = await serveStatic({ stepTaskId: id, root: target.path, port: await freePort() });
      try {
        return await checker.check({ url: `http://127.0.0.1:${app.port}${entry}`, signal });
      } finally {
        stopApp(id);
      }
    } finally {
      pv?.close();
    }
  };

  if (st.kind === "design") {
    mkdirSync(designDir, { recursive: true });
    let c = await checkDesign();
    tried.push(
      c.ok
        ? `the design's folder: renders on ${c.devices.join(", ")}`
        : `the design's folder: ${c.reason}`,
    );
    if (!c.ok && recoverShown) {
      const rec = await recoverShown(
        {
          step: `showing the design for the review “${step.title}”`,
          error: `The design doesn't render: ${c.reason}`,
          taskId: null,
        },
        async () => {
          c = await checkDesign();
          tried.push(
            c.ok
              ? `after the recovery agent, the design renders on ${c.devices.join(", ")}`
              : `after the recovery agent: ${c.reason}`,
          );
          return c.ok ? null : `the design still doesn't render: ${c.reason}`;
        },
        `# What Oraknid needs\nThe owner reviews the design in ${relative(cwd, designDir) || "the job's folder"}/ in a browser, page by page, at phone and desktop sizes. Make its pages render there as they are (static HTML, CSS and scripts the folder holds; no build step, nothing from the internet): fix what keeps them blank or broken. Don't redesign anything.`,
      );
      if (rec.ok && !c.ok) c = await checkDesign();
    }
    if (c.ok)
      return {
        target: { kind: "folder", path: designDir },
        shows: "design",
        port: null,
        way: null,
        checked: c.devices,
        problem: null,
        tried,
      };
    return {
      target: { kind: "none" },
      shows: "nothing",
      port: null,
      way: null,
      checked: [],
      problem: `The design couldn't be shown: ${c.reason}.`,
      tried,
    };
  }

  // The app (an app review, or a checkpoint): the ladder.
  const plan = planFor(d, job);
  const ladder = (agent?: string | null) =>
    bringUp({
      stepTaskId: step.id,
      cwd,
      plan,
      waitMs: d.appWaitMs ?? 90_000,
      signal,
      ways: waysToRun(cwd, st.run, agent),
      check: (p) => checkAt({ kind: "port", port: p }),
      onTry: (t) => {
        tried.push(t.ok ? `${t.way}: renders` : `${t.way}: ${t.reason}`);
        say(t);
      },
    });
  let up = await ladder();
  const found = (r: Awaited<ReturnType<typeof ladder>>): Prepared | null =>
    r.ok
      ? {
          target: { kind: "port", port: r.app.port },
          shows: "app",
          port: r.app.port,
          way: r.way,
          checked: r.check.devices,
          problem: null,
          tried,
        }
      : null;
  const ready = found(up);
  if (ready) return ready;
  // A checkpoint whose app doesn't run, but with a design: the design is what there is to see.
  if (st.kind === "checkpoint" && pagesIn(designDir).length) {
    const c = await checkDesign();
    if (c.ok)
      return {
        target: { kind: "folder", path: designDir },
        shows: "design",
        port: null,
        way: null,
        checked: c.devices,
        problem: null,
        tried: [...tried, `the design's folder: renders on ${c.devices.join(", ")}`],
      };
  }
  const nothingRuns = !up.tried.length;
  if (recoverShown && (st.kind === "app" || !nothingRuns)) {
    let byAgent: Prepared | null = null;
    const facts = tried.length
      ? tried.map((t, i) => `${i + 1}. ${t}`).join("\n")
      : "Nothing says how it runs: no command in the plan, no dev, start, serve or preview script, no README command, no index.html.";
    await recoverShown(
      {
        step: `starting the app for the review “${step.title}”`,
        error: `The app didn't start, or didn't render once started. Each way Oraknid tried:\n${facts}`,
        taskId: null,
      },
      async (recoveryTaskId) => {
        const said = agentRunCommand(agentReport(d, recoveryTaskId));
        up = await ladder(said);
        byAgent = found(up);
        return byAgent
          ? null
          : `the app still didn't start: ${up.tried.map((t) => `${t.way}: ${brief(t.reason ?? "", 300)}`).join("; ") || "nothing says how it runs"}`;
      },
      `# What Oraknid needs\nThe owner reviews the running app in a browser, at phone and desktop sizes. Oraknid starts it with a command in the job's folder, giving it a free port in the PORT environment variable (and \`$PORT\` in the command is replaced by it), and loads http://127.0.0.1:<that port>/; the page must render (not blank, nothing thrown, no raw source files). Make the app start that way: fix its configuration, install what is missing, make it use the port it is given, add a dev script if it has none. Don't start a server and leave it running.\n\nEnd your answer with one line \`RUN: <command>\`: the command that starts the app on \`$PORT\` (for example \`RUN: pnpm dev --port $PORT --strictPort --host 127.0.0.1\`).`,
    );
    const got = byAgent as Prepared | null;
    if (got) return got;
    // A recovery replayed from the journal (a restart): the ladder once more, with what it said.
    if (!up.ok) {
      const again = found(await ladder());
      if (again) return again;
    }
  }
  const first = up.tried[0] ?? null;
  return {
    target: { kind: "none" },
    shows: "nothing",
    port: null,
    way: null,
    checked: [],
    problem: first
      ? `${brief(tried[0] ?? first.way, 500)}`
      : "nothing says how it runs: no command in the plan, no dev or start script, no README command, no index.html",
    tried,
  };
}

/**
 * Whether an open review must be prepared again (ADR-069 §5–6): Try was
 * asked again; it shows an app's source folder (opened before ADR-069);
 * or its app isn't running (Oraknid restarted) and won't run again the
 * way it ran.
 */
async function needsPreparing(
  d: EvaluationDeps,
  job: JobRow,
  step: Row,
  st: EvaluationState,
  cwd: string,
  signal: AbortSignal,
): Promise<boolean> {
  if (st.retry) return true;
  if (st.shows === "nothing" || st.shows === "design") return false;
  // Opened before ADR-069 on a folder for an app: a folder of source code, never shown.
  if (st.shows === null && st.kind !== "design" && st.port === null) return true;
  if (st.shows === null && st.kind === "design") return false;
  if (!st.port || runningApp(step.id)) return false;
  // Oraknid restarted while the review was open: the app runs again, the way it ran, on its port.
  const way = st.way ?? waysToRun(cwd, st.run)[0] ?? null;
  if (!way) return true;
  try {
    await runWay(
      { stepTaskId: step.id, cwd, plan: planFor(d, job), waitMs: d.appWaitMs ?? 90_000, signal },
      way,
      st.port,
      false,
    );
    return false;
  } catch (error) {
    if (signal.aborted) throw error;
    return true;
  }
}

/** Try again on a review (ADR-069 §5): its step prepares what it shows again at the next look. */
export function askRetry(db: Db, stepTaskId: string): boolean {
  const st = readEvaluation(db, stepTaskId);
  if (!st?.reviewId || st.outcome) return false;
  writeEvaluation(db, stepTaskId, { ...st, retry: true });
  return true;
}

/**
 * The open reviews of a job that must be prepared again now (ADR-069 §6):
 * an app's shown as a folder (before ADR-069), Try again asked, or an
 * app that isn't running (Oraknid restarted). Its waiting job is resumed.
 */
export function reviewsToHeal(db: Db, jobId: string): string[] {
  return waitingReviews(db, jobId)
    .filter(({ id, s }) => {
      if (!s) return false;
      if (s.retry) return true;
      if (s.shows === null && s.kind !== "design" && s.port === null) return true;
      return !!s.port && !runningApp(id);
    })
    .map((x) => x.id);
}

/** Tasks after a task, through the graph: what must never come before it. */
function after(rows: Row[], id: string): Set<string> {
  const out = new Set<string>();
  const visit = (x: string) => {
    for (const r of rows)
      if (r.dependsOn.includes(x) && !out.has(r.id)) {
        out.add(r.id);
        visit(r.id);
      }
  };
  visit(id);
  return out;
}

const noteLine = (n: ReviewNote) =>
  `- **${n.kind}**: ${n.text}${n.element ? ` (on ${n.element})` : ""}${n.device ? ` [${n.device}]` : ""}`;

/**
 * My notes as work (ADR-064 §2): keep-notes kept in Silk as decisions,
 * given to every later task; the rest planned as tasks that come before
 * the step's next round (The Eye's planning call when it has one, else one
 * task with the notes). Returns how many tasks were added.
 */
async function notesToWork(
  d: EvaluationDeps,
  job: JobRow,
  step: Row,
  st: EvaluationState,
  notes: ReviewNote[],
): Promise<number> {
  const round = st.round;
  for (const n of notes.filter((x) => x.kind === "keep"))
    d.silk.add({
      jobId: job.id,
      taskId: step.id,
      kind: "decision",
      title: `Keep: ${n.text.slice(0, 100)}`,
      body: `From my review of ${what(st.kind)} (round ${round})${n.element ? `, on ${n.element}` : ""}${n.device ? ` [${n.device}]` : ""}: keep this as it is, whatever else changes. ${n.text}`,
      authoredBy: "owner",
    });
  const work = notes.filter((x) => x.kind !== "keep");
  if (!work.length) return 0;
  const rows = taskRows(d.db, job.id);
  const later = after(rows, step.id);
  const reviewed = rows.filter((r) => step.dependsOn.includes(r.id) && !isEvaluation(r));
  const text = `My notes on ${what(st.kind)}, round ${round}:\n${work.map(noteLine).join("\n")}`;
  let plan: WebPlan;
  const live = rows.filter((t) => t.state !== "skipped" && t.id !== step.id && !later.has(t.id));
  if (d.brain.extend) {
    try {
      plan = await d.brain.extend({
        jobId: job.id,
        cwd: job.worktree ?? process.cwd(),
        goal: job.goal,
        skill: "",
        silk: d.silk
          .current(job.id)
          .filter((e) => e.kind === "decision" || e.kind === "architecture")
          .slice(-30)
          .map((e) => `## ${e.title}\n${e.body.slice(0, 600)}`)
          .join("\n\n"),
        digest: "",
        verify: job.verify,
        request: `${text}\n\nPlan the work these notes ask for, on ${what(st.kind)}: it is done before the owner looks again. Never undo what a "Keep:" decision keeps.`,
        tasks: live.map((t) => ({
          id: t.id,
          title: t.title,
          kind: t.kind,
          state: t.state,
          dependsOn: t.dependsOn,
        })),
        suggested: "",
      });
    } catch (error) {
      if (error instanceof BrainStopped) throw error;
      plan = notesTask(job, reviewed, st, text);
    }
  } else plan = notesTask(job, reviewed, st, text);
  // Before the next round: never after the step, nor after what waits for it.
  plan = {
    ...plan,
    tasks: plan.tasks
      .filter((t) => !isEvaluation(t))
      .map((t) => ({
        ...t,
        dependsOn: t.dependsOn.filter((x) => x !== step.id && !later.has(x)),
      })),
  };
  if (!plan.tasks.length) plan = notesTask(job, reviewed, st, text);
  const stored = storeWeb(d, job.id, plan, {
    keyPrefix: `rv-${step.id.slice(-6).toLowerCase()}-${round}-`,
    title: `Plan, version ${job.webVersion + 1}: my notes on ${what(st.kind)} (round ${round})`,
    evaluations: false,
  });
  const before = [...new Set([...stored.added, ...stored.knownIds])];
  for (const id of before)
    if (id !== step.id && !later.has(id))
      d.db.insert(taskEdges).values({ taskId: step.id, dependsOn: id }).onConflictDoNothing().run();
  return stored.added.length;
}

/** The notes as one task on what the step reviewed, when no planning call is at hand. */
function notesTask(job: JobRow, reviewed: Row[], st: EvaluationState, text: string): WebPlan {
  const scope = [...new Set(reviewed.flatMap((r) => r.scope))];
  const verify = [...new Set([...reviewed.flatMap((r) => r.verify), ...job.verify])];
  return {
    summary: `The owner's notes on ${what(st.kind)} (round ${st.round}), as work.`,
    tasks: [
      {
        key: "notes",
        title: `Apply my notes on ${what(st.kind)} (round ${st.round})`,
        instructions: `${text}\n\nDo what each note asks; keep everything a "Keep:" decision keeps. Done when every note is addressed and the checks pass.`,
        kind: "implement",
        dependsOn: [],
        scope: scope.length ? scope : st.kind === "design" ? ["design/**"] : ["**"],
        verify: verify.length ? verify : [st.kind === "design" ? "test -d design" : "true"],
        requiredCapabilities: st.kind === "design" ? ["ui"] : ["implementation", "ui"],
        difficulty: "medium",
      },
    ],
    jobVerify: [],
  };
}

// ── The chat edits the plan: "add a review after X", "skip reviews" ──

type ReviewEdit = EvaluationEdit;

const SKIP =
  /\b(?:skip|without|no|drop|remove|turn off)\b(?:\s+\w+){0,3}\s+(?:reviews?|evaluations?|evaluation steps?)\b|\breviews?\s+off\b/i;
const ADD =
  /\badd (?:an? |one )?(design |app |final |checkpoint )?(?:review|evaluation(?: step)?|checkpoint) (?:step )?(?:after|once|when) (?:the |my )?(.+?)\s*(?:is done|is built)?\s*[.!?]?$/i;

/** My words as an edit of the plan's reviews, when they plainly are one; null otherwise. */
export function reviewEditOf(text: string): ReviewEdit | null {
  const t = text.trim();
  const m = t.match(ADD);
  if (m?.[2]) {
    const k = m[1]?.trim().toLowerCase();
    const kind = k === "design" ? "design" : k === "app" || k === "final" ? "app" : "checkpoint";
    return { skip: false, add: [{ after: m[2], kind, why: null }] };
  }
  if (SKIP.test(t)) return { skip: true, add: [] };
  return null;
}

/** The job's task my words name: by its id, else the title most like them. */
function taskNamed(rows: Row[], words: string): Row | null {
  const byId = rows.find((r) => r.id === words.trim());
  if (byId) return byId;
  const want = meaningWords(words);
  if (!want.size) return null;
  let best: { r: Row; score: number } | null = null;
  for (const r of rows.filter((x) => !isEvaluation(x))) {
    const have = meaningWords(r.title);
    const hit = [...want].filter((w) => have.has(w) || [...have].some((h) => h.startsWith(w)));
    const score =
      hit.length / want.size + (r.title.toLowerCase().includes(words.toLowerCase().trim()) ? 1 : 0);
    if (!best || score > best.score) best = { r, score };
  }
  return best && best.score >= 0.5 ? best.r : null;
}

/**
 * Applies my edit to the job's evaluation steps: "skip reviews" skips
 * every one not done (and the job plans none again); "add a review after
 * X" puts one after that task, the tasks after X waiting for it. Returns
 * what was done, in words, and whether a waiting job may go on.
 */
export function editReviews(
  d: Pick<EvaluationDeps, "db" | "bus" | "silk" | "now">,
  jobId: string,
  edit: ReviewEdit,
): { did: string[]; reply: string; unblocks: boolean } {
  const did: string[] = [];
  const said: string[] = [];
  let unblocks = false;
  if (edit.skip) {
    const open = taskRows(d.db, jobId).filter(
      (t) => isEvaluation(t) && t.state !== "done" && t.state !== "skipped",
    );
    for (const t of open) {
      stopApp(t.id);
      const s = readEvaluation(d.db, t.id);
      if (s) writeEvaluation(d.db, t.id, { ...s, port: null, outcome: "skipped" });
      setState(d as EvaluationDeps, jobId, t.id, "skipped", "Skipped: I said to skip reviews.");
    }
    writeSetting(d.db, jobEvaluationsKey(jobId), Evaluations.nullable(), {
      mode: "none",
      kinds: [],
    });
    did.push(
      open.length
        ? `Skipped ${open.length === 1 ? "a review" : `${open.length} reviews`}`
        : "No reviews in this job",
    );
    said.push(
      open.length
        ? `I skipped ${open.map((t) => `“${t.title}”`).join(", ")}; the work goes on without waiting for you.`
        : "This job plans no reviews from now on.",
    );
    unblocks = open.length > 0;
  }
  for (const a of edit.add) {
    const rows = taskRows(d.db, jobId);
    const target = taskNamed(rows, a.after);
    if (!target) {
      said.push(`I couldn't tell which task “${a.after}” is, so I added no review.`);
      continue;
    }
    const w = EVALUATION_WORDS[a.kind];
    const planned = evaluationTask(
      "review",
      { kind: a.kind, why: a.why ?? `I asked for a look after “${target.title}”.` },
      [target.id],
    );
    const stored = storeWeb(
      d,
      jobId,
      {
        summary: `A review after “${target.title}”, as I asked.`,
        tasks: [{ ...planned, title: `${w.title} after “${target.title.slice(0, 60)}”` }],
        jobVerify: [],
      },
      {
        keyPrefix: `ask-${target.id.slice(-6).toLowerCase()}-${a.kind}-`,
        evaluations: false,
      },
    );
    const id = stored.added[0];
    if (!id) {
      said.push(`There is a review after “${target.title}” already.`);
      continue;
    }
    // What came after the task now waits for the review too.
    for (const r of rows)
      if (
        r.id !== id &&
        r.dependsOn.includes(target.id) &&
        r.state !== "done" &&
        r.state !== "skipped"
      )
        d.db.insert(taskEdges).values({ taskId: r.id, dependsOn: id }).onConflictDoNothing().run();
    // Reviews are back on for this job when I ask for one.
    const own = jobEvaluationsOwn(d.db, jobId);
    if (own?.mode === "none" || (own?.mode === "some" && !own.kinds.includes(a.kind)))
      writeSetting(d.db, jobEvaluationsKey(jobId), Evaluations.nullable(), {
        mode: "some",
        kinds: [...new Set([...(own.mode === "some" ? own.kinds : []), a.kind])],
      });
    did.push("Added a review");
    said.push(
      `I added “${w.title}” after “${target.title}”; what comes after it waits for your approval.`,
    );
  }
  return { did, reply: said.join(" "), unblocks };
}

/** A job that ended (cancelled, say) stops the apps its reviews ran. */
export function stopJobApps(db: Db, jobId: string) {
  for (const t of db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.jobId, jobId), eq(tasks.kind, "evaluation")))
    .all())
    stopApp(t.id);
}

/** Evaluation steps of a job that wait for me now, with when each passes by itself. */
export function waitingReviews(db: Db, jobId: string) {
  return db
    .select({ id: tasks.id, state: tasks.state })
    .from(tasks)
    .where(and(eq(tasks.jobId, jobId), eq(tasks.kind, "evaluation")))
    .all()
    .filter((t) => t.state !== "done" && t.state !== "skipped")
    .map((t) => ({ id: t.id, s: readEvaluation(db, t.id) }))
    .filter((x) => x.s?.reviewId && !x.s.outcome);
}
