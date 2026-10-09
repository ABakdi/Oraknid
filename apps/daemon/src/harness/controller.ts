import type { choiceQuestion, TaskKind } from "@oraknid/contracts";
import { countOf, decideOutcome, type Ending, type Outcome, record } from "@oraknid/core";
import { and, desc, eq, inArray } from "drizzle-orm";
import { attempts, tasks } from "../db/schema.ts";
import { LegStop, trackAttempt } from "../eye/leg-work.ts";
import { addMessage, guidanceMark } from "../eye/talk.ts";
import { newId } from "../ids.ts";
import { sandboxPlan } from "../legs/plan.ts";
import type { WorkTree } from "../workspace/tree.ts";
import { applyOutcome, EndAttempt } from "./apply.ts";
import { taskChecks } from "./checks.ts";
import { type AttemptCtx, type AttemptState, beginTurn, factsOf } from "./facts.ts";
import { createGate } from "./gate.ts";
import { AttemptLog } from "./log.ts";
import { scopeOf } from "./pack.ts";
import { committedBeforeCrash, heard, reconcile, reconciledText, unresolved } from "./reconcile.ts";
import { takeOver } from "./record.ts";
import { pickRoute } from "./route.ts";
import { createSessionManager, legServers, safeDiffStat } from "./sessions.ts";
import type { AttemptDeps, AttemptJob, AttemptOutcome, AttemptWhere, TaskRow } from "./types.ts";
import { createVerifier } from "./verifier.ts";

// The TaskController (ADR-056 §8): one attempt at one task as a state
// machine, deciding nothing itself.
//
//   Preparing → Running ⇄ AwaitingOwner → Verifying → Deciding →
//     { Running | Repairing | HandingOff → next attempt | Done | Failed | Cancelled }
//
// Preparing routes the task (route.ts), checkpoints the work, takes over
// from the attempt before and reconciles what it left uncertain
// (reconcile.ts), tries the checks and opens the session (sessions.ts).
// Running waits for the agent's turn to end; the session's events go to
// the attempt log, the Gate and the monitors. Deciding gathers the facts
// (facts.ts), decides through core's `decideOutcome` and applies through
// `applyOutcome` (apply.ts); Verifying and Repairing run the Verifier and
// decide again. Every transition is a `Transition` in the attempt log with
// an idempotency key; Done carries what it needs to be reconciled after a
// crash (the checkpoint its commit is measured from).

export type ControllerState =
  | "Preparing"
  | "Running"
  | "AwaitingOwner"
  | "Verifying"
  | "Deciding"
  | "Repairing"
  | "HandingOff"
  | "Done"
  | "Failed"
  | "Cancelled";

const ENDS: ControllerState[] = ["HandingOff", "Done", "Failed", "Cancelled"];
const DECIDED: ControllerState[] = [
  "Running",
  "AwaitingOwner",
  "Verifying",
  "Repairing",
  "Deciding",
  ...ENDS,
];

/** Where each state may go (ADR-056 §8); the ends go nowhere. */
export const TRANSITIONS: Record<ControllerState, readonly ControllerState[]> = {
  Preparing: ["Running", "Done", "Failed", "Cancelled"],
  Running: ["Deciding", "AwaitingOwner", "Failed", "Cancelled"],
  AwaitingOwner: DECIDED.filter((s) => s !== "AwaitingOwner"),
  Deciding: DECIDED.filter((s) => s !== "Deciding"),
  Verifying: ["Deciding", "Failed", "Cancelled"],
  Repairing: ["Deciding", "Failed", "Cancelled"],
  HandingOff: [],
  Done: [],
  Failed: [],
  Cancelled: [],
};

/** The state an outcome leads to, before it is applied. */
export function stateOf(o: Outcome): ControllerState {
  switch (o.kind) {
    case "Done":
      return "Done";
    case "Continue":
      return "Running";
    case "Confirm":
      return "Deciding";
    case "Verify":
      return "Verifying";
    case "RepairChecks":
      return "Repairing";
    case "AskOwner":
      return "AwaitingOwner";
    case "Retry":
      return o.session === "same" ? "Running" : "HandingOff";
    case "Climb":
      return "HandingOff";
    case "Escalate":
      return o.step === "correct" || o.step === "reset" ? "Running" : "HandingOff";
    case "Unavailable":
    case "Fail":
      return "Failed";
    case "OwnerTakes":
    case "LeaveOut":
    case "CancelJob":
      return "Cancelled";
  }
}

/**
 * One attempt at one task (The-Eye → The loop; ADR-056 §8): prepared,
 * run, verified and decided, until it ends as an outcome `runTask` applies.
 */
export async function runController(
  d: AttemptDeps,
  job: AttemptJob,
  taskId: string,
  ws: AttemptWhere,
  attemptNo: number,
  jobSignal: AbortSignal,
): Promise<AttemptOutcome> {
  const task = d.db.select().from(tasks).where(eq(tasks.id, taskId)).get() as TaskRow;
  const now = d.now;
  // Stopped by its job (a pause, a cancel, a shutdown), or by its Leg alone (Jobs-and-Projects → Controls).
  const legStop = new AbortController();
  const signal = AbortSignal.any([jobSignal, legStop.signal]);
  const attemptLog = new AttemptLog(d.db, now);
  const before =
    d.db
      .select()
      .from(attempts)
      .where(eq(attempts.taskId, taskId))
      .orderBy(desc(attempts.startedAt))
      .get() ?? null;

  // ── Preparing ───────────────────────────────────────────────────
  // The attempt before was deciding Done when Oraknid stopped: its commit, if made, stands.
  const committed = before
    ? committedBeforeCrash(d, attemptLog, job.id, task, before, ws.tree)
    : null;
  if (committed) return committed;
  const routed = await pickRoute(d, job, task, signal);
  if ("kind" in routed) return routed;
  const { pick, leg, work } = routed;
  // Held from now until the attempt ends, whichever way; reachable by its Leg's pause or cancel.
  let ended: () => void = () => {};
  const untrack = trackAttempt({
    jobId: job.id,
    taskId,
    legId: leg.legId,
    stop: (why) => legStop.abort(why),
    ended: new Promise<void>((r) => {
      ended = r;
    }),
  });
  const hold = d.supervisor.hold(leg.legId);
  const release = () => {
    hold();
    untrack();
    ended();
  };
  // My messages from the moment the task shows as running reach this attempt (Talking to The Eye).
  const guidanceAtStart = guidanceMark();
  const attemptId = newId(now());
  d.bus.atomically(() => {
    d.db
      .update(tasks)
      .set({
        state: "running",
        assignedLegId: leg.legId,
        assignedModelId: leg.legModelId,
        effort: pick.effort,
        attemptCount: task.attemptCount + 1,
        routing: routed.routing,
      })
      .where(eq(tasks.id, taskId))
      .run();
    d.db
      .insert(attempts)
      .values({
        id: attemptId,
        taskId,
        jobId: job.id,
        legId: leg.legId,
        legModelId: leg.legModelId,
        effort: pick.effort,
        startedAt: now(),
        escalations: [],
      })
      .run();
    d.bus.publish({
      type: "task.state",
      topic: `job:${job.id}`,
      jobId: job.id,
      payload: { taskId, to: "running", routing: routed.routing },
    });
  });

  const ckpt = `refs/oraknid/${job.id}/${taskId}/${attemptNo}`;
  const prevCkpt = `refs/oraknid/${job.id}/${taskId}/${attemptNo - 1}`;
  // The task's scope is measured from before its first attempt, so what a crashed one left
  // outside it is still seen (Audit 1 → D1-06).
  const scopeBase = `refs/oraknid/${job.id}/${taskId}/base`;
  try {
    await ws.tree.checkpoint(ckpt, `oraknid: before ${task.title} (attempt ${attemptNo})`);
    await ws.tree.checkpoint(scopeBase, `oraknid: before ${task.title}`, true);
  } catch (error) {
    release();
    // No attempt or task is left looking alive by a checkpoint that failed (Audit 1 → Q1-13).
    d.db
      .update(attempts)
      .set({ endedAt: now(), outcome: "abandoned" })
      .where(eq(attempts.id, attemptId))
      .run();
    d.db.update(tasks).set({ state: "ready" }).where(eq(tasks.id, taskId)).run();
    throw error;
  }

  const trail = attemptLog.at({ jobId: job.id, taskId, attemptId });
  // What the attempt before left behind: a handoff when a crash wrote none, the actions it left
  // without a result marked uncertain (ADR-056 §1).
  if (before)
    await takeOver(d, attemptLog, { jobId: job.id, task, before }, () =>
      safeDiffStat(ws, prevCkpt),
    );

  const started = now();
  /** What the attempt carries from turn to turn (facts.ts): the ladder, what was observed. */
  const st: AttemptState = {
    level: task.escalation,
    escalations: [],
    observed: {
      scope: scopeOf(task),
      changedPaths: [],
      commands: [],
      verifyFailures: [],
      falseClaim: null,
      lastActivityAt: now(),
      tokensSinceProgress: 0,
      taskBudgetTokens: null,
      forbidden: [],
      gateBypass: [],
      local: leg.profile.costModel === "local",
    },
    tokensBaseline: 0,
    sessionTokens: 0,
    usage: null,
    turns: 0,
    ownerAsked: new Set(),
    // Only messages written after this attempt began: older ones are in Silk, in its context pack.
    guidanceSeen: guidanceAtStart,
    stuckFrom: 0,
    nudged: false,
    signalled: new Set(),
    reconcileAsked: false,
  };
  const observed = st.observed;
  const event = (type: string, payload: Record<string, unknown>) =>
    d.bus.publish({ type, topic: `job:${job.id}`, jobId: job.id, payload: { taskId, ...payload } });

  // ── The states, each move a step in the log ─────────────────────
  // Typed by assertion: it changes inside closures, which narrowing cannot follow.
  let state = "Preparing" as ControllerState;
  let moves = 0;
  /** Waiting on me inside a turn (the Leg's prompt held), as opposed to an outcome that asks. */
  let askedInTurn = false;
  const move = (to: ControllerState, why: string, extra: { ckpt?: string } = {}) => {
    if (to === state) return;
    if (!TRANSITIONS[state].includes(to))
      console.error(`task controller: ${state} → ${to} isn't a transition (${why})`);
    trail.append("Transition", {
      from: state,
      to,
      why: why.slice(0, 200),
      key: `${attemptId}:${++moves}:${to}`,
      ...extra,
    });
    state = to;
  };
  const enter = (o: Outcome) => {
    const to = stateOf(o);
    if (to === state || (askedInTurn && to === "Running")) return;
    if (state === "Running") move("Deciding", "looking at the attempt between turns");
    // Done: the commit that follows is reconciled after a crash from this checkpoint.
    move(to, o.kind, to === "Done" ? { ckpt } : {});
  };

  const toolRows = d.tools && job.tools.length ? d.tools.registry.byNames(job.tools) : [];
  const servers = legServers(d, job, leg.legId);
  /**
   * Every action of the agent, from every source, is decided by the Gate
   * (ADR-056 §3): the session's adapters only translate its decision.
   */
  const gate = createGate({
    db: d.db,
    bus: d.bus,
    inbox: d.inbox,
    silk: d.silk,
    now,
    ...(d.brain ? { brain: d.brain } : {}),
    ...(d.tools ? { tools: d.tools.registry } : {}),
    toolRows,
    legsDir: d.legsDir,
    job,
    task,
    leg,
    attemptId,
    cwd: ws.cwd,
    servers: servers.list,
    signal,
    on: {
      activity: () => {
        observed.lastActivityAt = now();
      },
      forbidden: (what) => observed.forbidden.push(what),
      gateBypass: (what) => observed.gateBypass.push(what),
      event,
      // Running ⇄ AwaitingOwner: the Leg's prompt held for my answer.
      owner: (waiting) => {
        if (waiting && state === "Running") {
          askedInTurn = true;
          move("AwaitingOwner", "the agent's action waits for my answer");
        } else if (!waiting && askedInTurn) {
          askedInTurn = false;
          if (state === "AwaitingOwner") move("Running", "answered");
        }
      },
    },
  });
  /**
   * The task's checks, run by Oraknid itself (BR-1) through the one Verifier
   * (ADR-056 §4): in the sandbox, on its servers, or its own; each command
   * read by the Gate first (§3).
   */
  const verifier = createVerifier(d, job, {
    cwd: ws.cwd,
    localCommit: (branch, repo) => ws.tree.localCommit(branch, repo),
    plan: () =>
      job.unsandboxed
        ? null
        : sandboxPlan(
            d.registry.require(leg.legId),
            d.sandbox,
            d.legsDir,
            job.localPorts ?? [],
            job.id,
          ),
    servers: () => servers.list,
    prepare: servers.prepare,
    refuse: (command, where) => gate.check(command, where),
    signal,
    log: trail,
    task: { id: task.id, title: task.title },
  });
  const runChecks: AttemptCtx["runChecks"] = (commands, o = {}) => verifier.run(commands, o);
  const checks = taskChecks(d, job, task, {
    ws,
    ckpt,
    scopeBase,
    servers: servers.list,
    prepareServers: servers.prepare,
    run: runChecks,
    log: trail,
    event,
    corrected: () => {
      observed.scope = scopeOf(task);
    },
  });
  const sessions = createSessionManager({
    d,
    job,
    task,
    leg,
    effort: pick.effort ?? null,
    attemptId,
    ws,
    ckpt,
    gate,
    log: attemptLog,
    trail,
    signal,
    st,
    servers,
    toolRows,
    event,
    onStop: (said) => checks.onStop(said),
  });

  /** The attempt ends, recorded as counted (core's `countOf`): learned from when it says something of the model. */
  const finish = (ending: Ending) => {
    const c = countOf(ending);
    release();
    gate.withdrawAsked();
    trail.append("Outcome", { kind: c.record, reason: st.escalations.at(-1) ?? null });
    trail.append("AttemptEnded", { reason: c.record });
    d.db
      .update(attempts)
      .set({ endedAt: now(), outcome: c.record, escalations: st.escalations })
      .where(eq(attempts.id, attemptId))
      .run();
    const m = d.registry.model(leg.legModelId);
    // Its provider failing says nothing of what the model can do (M13.22).
    if (m && c.record !== "unavailable" && c.learn) {
      const stored = record(d.registry.storedProfile(m), task.kind as TaskKind, {
        success: c.success,
        tokens: st.observed.tokensSinceProgress,
        ms: now() - started,
        escalations: st.escalations.length,
      });
      d.registry.saveProfile(m.id, stored);
    }
  };

  /** What the turn's end is decided with (ADR-056 §6): the attempt's parts, for `facts.ts` and `apply.ts`. */
  const x: AttemptCtx = {
    d,
    job,
    task,
    leg,
    effort: pick.effort ?? null,
    work,
    ws,
    gate,
    log: attemptLog,
    trail,
    attemptId,
    ckpt,
    scopeBase,
    signal,
    servers: servers.list,
    st,
    event,
    session: sessions.current,
    handOff: sessions.handOff,
    closeSession: sessions.close,
    openSession: (prompt) => sessions.open(prompt),
    turnEnd: sessions.turnEnd,
    runChecks,
    repairBroken: (checked, report, rerun) => checks.repairBroken(checked, report, rerun),
    treeState: checks.treeState,
    higher: () => {
      const up = routed.higher();
      return up ? { legName: up.candidate.legName, model: up.candidate.model } : null;
    },
    conversationAsks: (text, questions, itemId) =>
      addMessage(
        d,
        job.id,
        "eye",
        text,
        {
          intent: "report",
          did: [],
          silkIds: [],
          taskIds: [taskId],
          jobId: null,
          report: { kind: "waiting", taskId, facts: [], todo: [] },
        },
        { questions: questions as ReturnType<typeof choiceQuestion>[], itemId },
      ),
    scope: () => scopeOf(task),
    enter,
  };

  try {
    // What the attempt before left uncertain, looked at before anything runs (ADR-056 §1).
    if (before) {
      const uncertain = attemptLog.attempt(before.id, { kinds: ["ActionUncertain"], limit: 1 });
      if (uncertain.length) {
        await servers.prepare();
        const found = await reconcile(attemptLog, trail, {
          taskId,
          before: before.id,
          ws,
          since: ws.tree.hasRef(prevCkpt) ? prevCkpt : scopeBase,
          aliases: servers.list.map((s) => s.alias),
        });
        if (found.length) {
          event("task.actions-reconciled", {
            actions: found.map((e) => ({ input: e.data.input, finding: e.data.finding })),
          });
          d.silk.add({
            jobId: job.id,
            taskId,
            kind: "issue",
            title: `Reconciled after a restart: ${task.title}`,
            body: reconciledText(found),
            authoredBy: "eye",
          });
        }
      }
    }
    // Checks tested before they judge (ADR-052 §2): run once before the work, a broken one is
    // repaired before any agent can be failed by it.
    await checks.tryFirst();
    // The same model again resumes its own session where the Leg can (ADR-052 §1).
    const resumeFrom = sessions.resumable(before);
    if (resumeFrom) event("task.resumed", { nativeSessionId: resumeFrom });
    await sessions.open(openingPrompt(d, job, task, before, !!resumeFrom), resumeFrom);
    move("Running", resumeFrom ? "session resumed" : "session opened");
    for (;;) {
      // ── Running ─────────────────────────────────────────────────
      const end = await sessions.turnEnd(d.stallCheckMs ?? 30_000);
      if (end) {
        st.turns++;
        move("Deciding", `the turn ended (${end.reason})`);
        // The agent was asked to look at what a restart left uncertain: its words are the finding.
        const open = st.reconcileAsked ? unresolved(attemptLog, attemptId) : [];
        if (open.length) heard(trail, open, end.text);
      }
      // ── Deciding ⇄ Verifying | Repairing | AwaitingOwner ────────
      const turn = beginTurn(x, end, end ? checks.takeStopRun() : null, () => safeStrayed(ws.tree));
      while ((await applyOutcome(decideOutcome(factsOf(x, turn)), x, turn)) === "decide")
        move("Deciding", "the facts changed");
      if (state !== "Running" && !askedInTurn) move("Running", "the agent's next turn");
    }
  } catch (error) {
    if (error instanceof EndAttempt) {
      if (!ENDS.includes(state)) move("Failed", error.ending.kind);
      finish(error.ending);
      return error.outcome;
    }
    // Its Leg alone was stopped (paused, or its work here cancelled): the work so far is kept
    // on a checkpoint beside the handoff (BR-7), and the job goes on.
    const byLeg =
      !jobSignal.aborted && legStop.signal.aborted && legStop.signal.reason instanceof LegStop
        ? (legStop.signal.reason as LegStop)
        : null;
    if (!ENDS.includes(state))
      move(signal.aborted ? "Cancelled" : "Failed", signal.aborted ? "stopped" : String(error));
    // Stopped (pause, cancel, shutdown) or failed: leave a handoff behind, then let the engine decide.
    await sessions.stop();
    if (byLeg) {
      try {
        await ws.tree.checkpoint(
          `refs/oraknid/${job.id}/${taskId}/${attemptNo}-stopped`,
          `oraknid: ${task.title} stopped (${byLeg.how === "room" ? "paused for room" : `${byLeg.how} of ${byLeg.legName}`})`,
        );
      } catch {}
    }
    // Stopped by me or its job (a pause, a restart) says nothing of the model (ADR-052 §3).
    finish({ kind: "Stopped", byJob: signal.aborted });
    if (byLeg) {
      setReady(d, job.id, taskId, byLeg.message);
      return { kind: "leg-stopped", how: byLeg.how, reason: byLeg.message };
    }
    setReady(d, job.id, taskId, "Stopped at a safe point; it starts again on resume.");
    throw error;
  } finally {
    sessions.end();
  }
}

/** The first message of the attempt's session: a fresh start, the handoff's, or a resumed session's. */
function openingPrompt(
  d: AttemptDeps,
  job: AttemptJob,
  task: TaskRow,
  before: typeof attempts.$inferSelect | null,
  resumed: boolean,
): string {
  const handoff = d.silk.current(job.id).some((e) => e.kind === "handoff" && e.taskId === task.id);
  // The agent runs the checks itself, in the loop (ADR-052 §2).
  const checksLine = task.verify.length
    ? "Run its checks yourself and keep working until they pass, then say DONE"
    : "Say DONE when it is finished";
  // What the model before didn't get done goes with the task up the ladder (ADR-052 §3).
  const stopped = before && before.outcome !== "succeeded" ? lastStop(d, job, task, before) : "";
  if (resumed)
    return `Oraknid continues this session after it stopped: ${stopped || "it was stopped"}\n\nPick up where you left off. ${checksLine}.`;
  if (handoff)
    return `Continue the task. The handoff above says where the last session stopped${before?.outcome === "failed" && stopped ? `, and what it didn't get done:\n${stopped}\n\n` : ". "}${checksLine}.`;
  return `Do the task described above: plan it your own way, in this session. ${checksLine} and summarise what you changed.`;
}

/** Why the last attempt on this task stopped, for a session resumed (ADR-052 §1). */
function lastStop(
  d: AttemptDeps,
  job: AttemptJob,
  task: TaskRow,
  before: typeof attempts.$inferSelect,
): string {
  const said = d.silk
    .all(job.id)
    .filter(
      (e) =>
        e.taskId === task.id &&
        e.createdAt >= before.startedAt &&
        (e.kind === "handoff" || e.kind === "issue") &&
        !e.title.startsWith("Uncertain after a restart") &&
        !e.title.startsWith("Reconciled after a restart"),
    )
    .sort((a, b) => a.createdAt - b.createdAt)
    .at(-1);
  const why = said?.body.split("## Why it was handed over")[1]?.trim();
  return (
    why ??
    (before.outcome === "abandoned"
      ? "it was stopped at a safe point"
      : "its last turn didn't finish the task")
  ).slice(0, 1500);
}

/** The worktrees that left the project, or none when that can't be told. */
function safeStrayed(tree: WorkTree): { folder: string; problem: string }[] {
  try {
    return tree.strayed();
  } catch {
    return [];
  }
}

/** Nothing runs it any more: shown as ready at once, not "running" until it starts again. */
function setReady(d: AttemptDeps, jobId: string, taskId: string, reason: string) {
  d.bus.atomically(() => {
    d.db
      .update(tasks)
      .set({ state: "ready", leaseUntil: null })
      .where(and(eq(tasks.id, taskId), inArray(tasks.state, ["assigned", "running", "verifying"])))
      .run();
    d.bus.publish({
      type: "task.state",
      topic: `job:${jobId}`,
      jobId,
      payload: { taskId, to: "ready", reason },
    });
  });
}
