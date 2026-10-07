import { choiceQuestion, type TaskKind } from "@oraknid/contracts";
import {
  agentNeedsAnswer,
  correctivePrompt,
  type Drift,
  type Ending,
  fence,
  ILL_DO_IT,
  inScope,
  keepsGoingWrongAnswer,
  type LadderStep,
  LEAVE_IT_OUT,
  type Outcome,
  oraknidOwn,
  type Signal,
  STOP_JOB,
  unusableOf,
  usageLimitOf,
  whenSaid,
} from "@oraknid/core";
import { eq } from "drizzle-orm";
import { jobs, tasks } from "../db/schema.ts";
import { BrainStopped } from "../eye/brain.ts";
import { giveToLeg } from "../eye/leg-work.ts";
import { dependentsOf, keepsGoingWrong, readKeepsGoingWrong } from "../eye/questions.ts";
import { parseSsh } from "../servers/remote.ts";
import { type AttemptCtx, type Turn, verdictFor } from "./facts.ts";
import { ALLOW } from "./gate.ts";
import type { AttemptOutcome } from "./types.ts";

// What an outcome does (ADR-056 §6): the side effects of the one decision
// `decideOutcome` made — feedback sent, checks repaired, the owner asked
// through the Gate, a climb with its handoff, a step of the drift ladder,
// the end. No decision is made here: my answers are read back into an
// outcome by core (`agentNeedsAnswer`, `keepsGoingWrongAnswer`).

/** An attempt ends: what it returns, and the end as counted (core's `countOf`). */
export class EndAttempt extends Error {
  constructor(
    readonly outcome: AttemptOutcome,
    readonly ending: Ending,
  ) {
    super(outcome.kind);
  }
}

const PREFIX: Record<TaskKind, string> = {
  plan: "docs",
  research: "docs",
  implement: "feat",
  test: "test",
  review: "refactor",
  mechanical: "chore",
  external: "chore",
};

/**
 * Does what the outcome says. "decide": the facts changed (verified,
 * repaired), decide again; "turn": wait for the agent's next turn. An end
 * throws `EndAttempt`.
 */
export async function applyOutcome(o: Outcome, x: AttemptCtx, t: Turn): Promise<"decide" | "turn"> {
  x.enter(o);
  if (o.kind !== "Verify" && o.kind !== "RepairChecks") settle(x, t, o);
  switch (o.kind) {
    case "Verify":
      await verify(x, t);
      return "decide";
    case "RepairChecks": {
      const report = t.report;
      if (report)
        t.report = await x.repairBroken(report, t.text, () =>
          x.runChecks(x.task.verify, { why: "repair" }),
        );
      t.repaired = true;
      return "decide";
    }
    case "Continue":
      return carryOn(x, t, o);
    case "Retry":
      if (o.session === "same") {
        await x.session()?.session.send(o.feedback);
        return "turn";
      }
      return ownerRetry(x, o);
    case "AskOwner":
      if (o.question === "agent-needs") return askAgentNeeds(x, t, o.said);
      await ladderStep(x, o.drift, "ask", o.level);
      await x.closeSession();
      return askKeepsGoingWrong(x, t, o.drift);
    case "Escalate":
      return escalate(x, o);
    case "Climb": {
      const { leg } = x;
      x.event("task.climbing", {
        from: `${leg.legName} · ${leg.model}`,
        to: `${o.to.legName} · ${o.to.model}`,
        work: x.work,
      });
      await x.handOff(false, o.failure);
      await x.closeSession();
      avoidThisModel(x);
      throw new EndAttempt(
        {
          kind: "retry",
          reason: `${leg.legName} · ${leg.model} didn't get it done; it climbs to ${o.to.legName} · ${o.to.model}`,
        },
        o,
      );
    }
    case "Done":
      return done(x, o);
    case "Fail":
      return o.why === "strayed" ? strayed(x, t, o) : failed(x, t, o);
    case "Unavailable":
      return unavailable(x, t, o);
    case "OwnerTakes":
      await x.closeSession();
      throw new EndAttempt({ kind: "owner-held" }, o);
    case "LeaveOut":
      await x.closeSession();
      throw new EndAttempt({ kind: "skipped", dependents: o.dependents }, o);
    case "CancelJob":
      await x.closeSession();
      throw new EndAttempt({ kind: "cancel-job", reason: o.reason }, o);
  }
}

// ── The verdict ─────────────────────────────────────────────────────

/**
 * The work verified (The-Eye → The loop): the task's checks, once per turn
 * end (what the Stop hook just ran on the same work stands, bug 5), or with
 * none, a second reasoning look (The-Eye → Planning).
 */
async function verify(x: AttemptCtx, t: Turn) {
  const { task, d } = x;
  x.st.observed.changedPaths = await x.ws.tree.changedSince(x.scopeBase);
  x.st.observed.scope = x.scope();
  t.checked = true;
  if (task.verify.length) {
    x.event("task.verifying", {});
    const stop = t.ranAtStop;
    const same =
      stop &&
      stop.verify.join("\n") === task.verify.join("\n") &&
      stop.tree === (await x.treeState());
    t.report = same ? stop.report : await x.runChecks(task.verify, { why: "turn" });
    return;
  }
  if (!d.brain || t.cutShort) return;
  x.event("task.evaluating", {});
  try {
    const review = await d.brain.evaluate({
      jobId: x.job.id,
      cwd: x.ws.cwd,
      task: { title: task.title, instructions: task.instructions, kind: task.kind },
      report: t.text,
      changes: await x.ws.tree.diffStatSince(x.ckpt),
      ...(x.job.skillChecks ? { criteria: x.job.skillChecks } : {}),
    });
    t.review = review;
    x.event("task.evaluated", { accepted: review.accepted, reason: review.reason });
  } catch (error) {
    // I stopped The Eye's thinking (M13.25): the job pauses here, to review it on resume.
    if (error instanceof BrainStopped) throw error;
    // No Leg could review it: accepted as before, and said so.
    x.event("task.evaluated", {
      accepted: true,
      reason: `not reviewed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

/**
 * The verdict put on record once decided on: said in the job's events, the
 * stuck question its own auto mode left taken, the failure kept for D3 and
 * D4 (not while it waits on me: what it needed isn't held against it), the
 * signals written to the log.
 */
function settle(x: AttemptCtx, t: Turn, o: Outcome) {
  for (const s of t.signals) signal(x, s);
  const v = verdictFor(x, t);
  if (!v || t.settled) return;
  t.settled = true;
  if (t.report) {
    x.event("task.verified", {
      ok: v.verified,
      results: t.report.results.map((r) => ({
        command: r.command,
        ok: r.ok,
        exitCode: r.exitCode,
      })),
    });
    if (v.failed) x.gate.takeStuck();
  }
  if (o.kind === "AskOwner" && o.question === "agent-needs") return;
  if (v.record.failure !== null) x.st.observed.verifyFailures.push(v.record.failure);
  if (v.record.falseClaim) x.st.observed.falseClaim = v.record.falseClaim;
}

/** A signal in the attempt log, once until the ladder acts on what was seen. */
function signal(x: AttemptCtx, s: Signal) {
  const key = `${s.kind}:${s.code}:${s.evidence}`;
  if (x.st.signalled.has(key)) return;
  x.st.signalled.add(key);
  x.trail.append("Signal", { kind: s.kind, code: s.code, evidence: s.evidence });
}

// ── Going on ────────────────────────────────────────────────────────

async function carryOn(
  x: AttemptCtx,
  t: Turn,
  o: Extract<Outcome, { kind: "Continue" }>,
): Promise<"turn"> {
  const send = (text: string) => x.session()?.session.send(text);
  switch (o.why) {
    case "wait":
      // Waiting for me is no stall.
      x.st.observed.lastActivityAt = x.d.now();
      return "turn";
    case "watch":
      return "turn";
    case "guidance":
      // My messages to The Eye for the work now (Talking to The Eye).
      x.st.guidanceSeen = t.guidance.mark;
      x.event("task.guided", {});
      if (o.feedback) await send(o.feedback);
      return "turn";
    case "owner":
      // A grant, used by the first run of it (ADR-056 §3).
      if (o.grant)
        x.gate.grantOnce(o.grant, "allowed once: the agent said it can't finish without it");
      // What came of this turn isn't held against the agent: it was waiting on me (bug 12).
      x.st.observed.falseClaim = null;
      if (o.feedback) await send(o.feedback);
      return "turn";
    case "self-prompt": {
      // Going round in circles: nudged once; seen again after this, the ladder acts (D2).
      if (o.nudge) {
        x.st.nudged = true;
        x.st.stuckFrom = lastLogged(x);
        x.event("task.nudged", { pattern: o.nudge.code, evidence: o.nudge.evidence });
      }
      if (o.feedback) await send(o.feedback);
      if (!o.rotate) return "turn";
      const u = x.st.usage;
      x.event("task.rotating", {
        contextTokens: u?.contextTokens,
        contextWindow: u?.contextWindow,
      });
      // The turn being finished is watched like any other (Audit 1 → Q1-23).
      await x.turnEnd(600_000);
      await x.handOff(true);
      await x.closeSession();
      await x.openSession(
        "Continue the task. The handoff above says where the last session stopped. Say DONE when it is finished.",
      );
      return "turn";
    }
  }
}

// ── The drift ladder (Drift-Control → The escalation ladder) ─────────

/** A step of the ladder taken: on record, what was seen consumed, the scope put back. */
async function ladderStep(x: AttemptCtx, drift: Drift, step: LadderStep | "ask", level: number) {
  const { st, d } = x;
  st.level = level;
  st.escalations.push(`${drift.code}:${step}`);
  d.db.update(tasks).set({ escalation: level }).where(eq(tasks.id, x.task.id)).run();
  x.event("task.drift", { code: drift.code, evidence: drift.evidence, step, level });
  signal(x, { kind: "drift", code: drift.code, evidence: drift.evidence } as Signal);
  // Detections are consumed: the same evidence doesn't trigger twice (Audit 1 → Q1-01).
  const o = st.observed;
  o.forbidden = [];
  o.gateBypass = [];
  o.falseClaim = null;
  o.commands = [];
  o.verifyFailures = [];
  st.tokensBaseline = st.sessionTokens;
  o.tokensSinceProgress = 0;
  o.lastActivityAt = d.now();
  st.signalled.clear();
  st.nudged = false;
  st.stuckFrom = lastLogged(x);
  // Edits outside the task's scope are put back whatever the step: left
  // there, the next attempt starts out of scope and trips D1 again.
  if (drift.code === "D1") {
    const scope = x.scope();
    const outside = (await x.ws.tree.changedSince(x.scopeBase)).filter(
      (p) => !oraknidOwn(p) && !inScope(p, scope),
    );
    x.ws.tree.restorePaths(x.scopeBase, outside, x.ws.trash);
  }
}

async function escalate(x: AttemptCtx, o: Extract<Outcome, { kind: "Escalate" }>): Promise<"turn"> {
  const { drift } = o;
  await ladderStep(x, drift, o.step, o.level);
  const avoid = () => avoidThisModel(x);
  switch (o.step) {
    case "correct":
      await x
        .session()
        ?.session.send(
          `${correctivePrompt(drift, x.scope(), x.task.verify)}${o.failure ? `\n\n${o.failure}` : ""}`,
        );
      return "turn";
    case "reset":
      await x.handOff(true);
      await x.closeSession();
      await x.openSession(
        "Continue the task. The handoff above says where the last session stopped.",
      );
      return "turn";
    case "step-up":
      await x.handOff(true);
      await x.closeSession();
      x.d.db
        .update(tasks)
        .set({ stepUp: x.task.stepUp + 1 })
        .where(eq(tasks.id, x.task.id))
        .run();
      throw new EndAttempt({ kind: "retry", reason: `stepping up after ${drift.code}` }, o);
    case "reassign":
      await x.handOff(true);
      await x.closeSession();
      avoid();
      throw new EndAttempt({ kind: "retry", reason: `reassigning after ${drift.code}` }, o);
    case "kill":
      await x.closeSession("kill");
      await x.ws.tree.rollback(x.ckpt, x.ws.trash);
      avoid();
      await x.handOff(false);
      throw new EndAttempt({ kind: "retry", reason: `killed after ${drift.code}` }, o);
  }
}

/** The attempt log's last event: stuck patterns are read after it. */
const lastLogged = (x: AttemptCtx) => x.log.attempt(x.attemptId, { limit: 1 })[0]?.id ?? 0;

/** The model that didn't get it done isn't routed to for this task again (ADR-052 §3). */
function avoidThisModel(x: AttemptCtx) {
  x.task.avoid = [...new Set([...x.task.avoid, x.leg.legModelId])];
  x.d.db.update(tasks).set({ avoid: x.task.avoid }).where(eq(tasks.id, x.task.id)).run();
}

// ── My questions ────────────────────────────────────────────────────

/**
 * The agent ended its turn saying it can't finish without me (blocked by a
 * guard, something only I can do or allow) while a check fails: The Eye
 * asks that, specifically, not "keeps going wrong" (ADR-053). The command
 * is the blocked one the agent names, else the last one blocked, else the
 * one its words give. Allowed, the exact command runs once and the agent
 * is told to go on; my other answers end the attempt.
 */
async function askAgentNeeds(x: AttemptCtx, t: Turn, said: string): Promise<"decide" | "turn"> {
  const { d, job, task, leg } = x;
  const need = t.need;
  const failed = t.report?.failures[0];
  if (!need || !failed) return "decide";
  x.st.ownerAsked.add(need.key);
  const { command, blocked } = need;
  const ssh =
    command && x.servers.length
      ? parseSsh(
          x.gate.plain(command),
          x.servers.map((s) => s.alias),
        )
      : null;
  const server = ssh ? x.servers.find((s) => s.alias === ssh.alias) : undefined;
  const shown = ssh && server ? `${ssh.remote.trim()}\` on ${server.name}` : `${command}\``;
  const dropped = dependentsOf(d.db, job.id, task.id);
  const prompt = command
    ? `${leg.legName} says it can't finish “${task.title}” without \`${shown}${
        blocked
          ? blocked.byLeg
            ? `, which its own auto mode refused (${blocked.reason})`
            : `, which Oraknid's rules blocked (${blocked.reason})`
          : ""
      }. What should I do?`
    : `${leg.legName} says it can't finish “${task.title}” without you. What should I do?`;
  const questions = [
    choiceQuestion(
      prompt,
      [
        ...(command
          ? [
              {
                label: ALLOW,
                detail: "It runs once, exactly as written; the agent is told to go on and finish.",
              },
            ]
          : []),
        {
          label: ILL_DO_IT,
          detail: `The task is yours: do it yourself; the job waits until you mark the task done or hand it back.`,
        },
        {
          label: LEAVE_IT_OUT,
          detail: `The task is dropped and the job goes on without it.${
            dropped.length
              ? ` The tasks that need it are left out too: ${dropped.map((t) => `“${t.title}”`).join(", ")}.`
              : ""
          }`,
        },
        { label: STOP_JOB, detail: "The job is cancelled; the work done so far stays." },
      ],
      command ? ALLOW : null,
    ),
  ];
  const options = questions[0]?.options.map((o) => o.label) ?? [];
  const { answer } = (await x.gate.askOwner(
    "agent-needs",
    {
      kind: "question",
      jobId: job.id,
      taskId: task.id,
      raisedBy: "eye",
      title: command
        ? `${leg.legName} needs \`${shown.slice(0, 100)} for “${task.title}”`
        : `${leg.legName} needs you for “${task.title}”`,
      detail: `${prompt}\n\nIts words: “${said}”\n\nThe check that fails:\n${fence(failed.command)}\n${fence(failed.output.slice(-1500))}${command ? `\n\nThe command:\n${fence(command)}` : ""}`,
      options,
      defaultOption: null,
      questions,
    },
    {
      reason: `the agent needs the owner: ${said.slice(0, 200)}`,
      // Asked in the project's conversation too (ADR-045); answering there answers the item.
      opened: (itemId) => x.conversationAsks(prompt, questions, itemId),
      throwOnStop: true,
    },
  )) as { answer: string };
  return applyOutcome(agentNeedsAnswer(answer, command, task.title, ALLOW), x, t);
}

/** The ladder's last step: "keeps going wrong", asked of me; my answer ends the attempt. */
async function askKeepsGoingWrong(x: AttemptCtx, t: Turn, drift: Drift): Promise<"turn"> {
  const { d, job, task, leg } = x;
  const jobRow = d.db.select().from(jobs).where(eq(jobs.id, job.id)).get();
  const others = d.registry
    .all()
    .filter(
      (l) =>
        l.id !== leg.legId &&
        !l.paused &&
        (!job.allowedLegIds.length || job.allowedLegIds.includes(l.id)),
    );
  const dropped = dependentsOf(d.db, job.id, task.id);
  const asking = keepsGoingWrong({
    task: task.title,
    leg: `${leg.legName} · ${leg.model}`,
    evidence: drift.evidence,
    escalations: x.st.escalations,
    others: others.map((l) => ({ id: l.id, name: l.name })),
    dropped: dropped.map((t) => t.title),
    folder: x.ws.cwd,
    branch: jobRow?.branch ?? null,
  });
  // Withdrawn if the attempt stops before I answer (Audit 1 → D1-07).
  const { itemId, answer: text } = (await x.gate.askOwner(
    "keeps-going-wrong",
    {
      kind: "question",
      jobId: job.id,
      taskId: task.id,
      raisedBy: "eye",
      title: asking.title,
      detail: asking.detail,
      options: [],
      defaultOption: null,
      questions: asking.questions,
    },
    {
      // Asked in the project's conversation too (ADR-045); answering there answers the item.
      opened: (id) =>
        x.conversationAsks(
          `“${task.title}” keeps going wrong on ${leg.legName}: ${drift.evidence}. What should I do?`,
          asking.questions,
          id,
        ),
      // The session is closed: nothing to watch for a stall meanwhile.
      waits: false,
      throwOnStop: true,
    },
  )) as { itemId: string; answer: string };
  const choice = readKeepsGoingWrong(text, d.inbox.get(itemId)?.answers ?? null);
  const legName =
    choice.kind === "another-leg" && choice.legId
      ? (d.registry.get(choice.legId)?.name ?? null)
      : null;
  await applyOutcome(
    keepsGoingWrongAnswer({ ...choice, ...(legName ? { legName } : {}) }, task.title),
    x,
    t,
  );
  return "turn";
}

/** My "try again" (with advice, or on another Leg): redirected by me, not a failure. */
function ownerRetry(x: AttemptCtx, o: Extract<Outcome, { kind: "Retry"; session: "new" }>): never {
  const { d, job, task } = x;
  if (o.advice)
    d.silk.add({
      jobId: job.id,
      taskId: task.id,
      kind: "decision",
      title: `Guidance for ${task.title}`,
      body: o.advice,
      authoredBy: "owner",
    });
  d.db
    .update(tasks)
    .set({ stepUp: 0, escalation: 0, avoid: [] })
    .where(eq(tasks.id, task.id))
    .run();
  if (o.legId !== undefined) giveToLeg(d.db, job.id, task.id, x.leg.legId, o.legId);
  throw new EndAttempt({ kind: "retry", reason: o.reason }, o);
}

// ── Ends ────────────────────────────────────────────────────────────

/** Done: committed, one commit per repo it changed, each with its own message (ADR-042). */
async function done(x: AttemptCtx, o: Outcome): Promise<never> {
  const { d, job, task, leg, ws } = x;
  await x.closeSession();
  const subject = `${task.title.charAt(0).toLowerCase()}${task.title.slice(1)}`;
  const kind = PREFIX[task.kind as TaskKind];
  const made = await ws.tree.commit((repo, several) =>
    several && repo ? `${kind}(${repo}): ${subject}` : `${kind}: ${subject}`,
  );
  const commit = made[0]?.sha ?? null;
  const said = ws.tree.several
    ? made.length
      ? ` ${made.length === 1 ? "Commit" : "Commits"} ${made.map((c) => `${c.repo} ${c.sha.slice(0, 10)}`).join(", ")}.`
      : ""
    : commit
      ? ` Commit ${commit.slice(0, 10)}.`
      : "";
  d.silk.add({
    jobId: job.id,
    taskId: task.id,
    kind: "progress",
    title: `Done: ${task.title}`,
    body: `${task.verify.length ? `Verified by ${task.verify.map((v) => `\`${v}\``).join(", ")}` : "No verify command (a planning task)"} on ${leg.legName} · ${leg.model}${x.effort ? ` (${x.effort})` : ""}.${said}\n\n${(await ws.tree.diffStatSince(x.ckpt)).trim() || "No file changes."}`,
    authoredBy: "eye",
  });
  d.db.update(tasks).set({ escalation: 0 }).where(eq(tasks.id, task.id)).run();
  throw new EndAttempt(
    {
      kind: "done",
      commit,
      commits: ws.tree.several ? made.map((c) => ({ repo: c.repo as string, sha: c.sha })) : [],
    },
    o,
  );
}

/**
 * The job's folder stopped being a worktree of the project: put back and
 * the attempt fails (Jobs-and-Projects → Ending a job, after the piano job).
 */
async function strayed(
  x: AttemptCtx,
  t: Turn,
  o: Extract<Outcome, { kind: "Fail" }>,
): Promise<never> {
  const { d, job, task, ws } = x;
  await x.closeSession("kill");
  let restored = true;
  try {
    ws.tree.putBack(ws.trash);
  } catch (error) {
    restored = false;
    x.event("task.folder-not-restored", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  const reason = `The job's folder stopped belonging to the project: ${o.reason}. ${
    restored
      ? "Oraknid put it back as a worktree of the project, its files kept, and the task starts again."
      : "Oraknid couldn't put it back."
  }`;
  x.event("task.folder-restored", { problems: t.strayed, restored });
  d.silk.add({
    jobId: job.id,
    taskId: task.id,
    kind: "issue",
    title: `Folder put back: ${task.title}`,
    body: `${reason} Never run git init, nor move, delete or edit a .git: Oraknid commits the work on the job's branch, and merges and pushes at the end.`,
    authoredBy: "eye",
  });
  avoidThisModel(x);
  throw new EndAttempt(
    restored ? { kind: "retry", reason } : { kind: "blocked", reason, until: null },
    o,
  );
}

/** The agent failed, and its words don't say why it isn't the task's. */
async function failed(x: AttemptCtx, t: Turn, o: Outcome): Promise<never> {
  await x.handOff(false);
  await x.closeSession();
  avoidThisModel(x);
  throw new EndAttempt(
    { kind: "retry", reason: `${x.leg.legName} failed: ${t.end?.error ?? "unknown error"}` },
    o,
  );
}

/**
 * Its provider failed or its quota ran out, not the task (M13.22): the
 * model (or the Leg) rests, a deprecated model is replaced, a quota is kept
 * until its reset (ADR-052 §4); not counted against the task.
 */
async function unavailable(
  x: AttemptCtx,
  t: Turn,
  o: Extract<Outcome, { kind: "Unavailable" }>,
): Promise<never> {
  await x.handOff(false);
  await x.closeSession();
  const error = t.end?.error ?? null;
  if (o.cause === "limit") {
    // Its own words say until when: kept until then, never routed to before (ADR-052 §4).
    if (usageLimitOf(error, x.d.now())?.until) markUnusable(x, error);
    else markLimited(x);
    throw new EndAttempt({ kind: "retry", reason: `${x.leg.legName} hit a usage limit` }, o);
  }
  throw new EndAttempt(
    markUnusable(x, error) ?? { kind: "retry", reason: `${x.leg.legName} is unavailable` },
    o,
  );
}

/** A usage limit on this Leg: another account of its provider isn't a fallback unless I allowed it (ADR-009). */
function markLimited(x: Pick<AttemptCtx, "d" | "task" | "leg">) {
  const { d, task, leg } = x;
  task.limitedKinds = [
    ...new Set([...task.limitedKinds, `${d.registry.require(leg.legId).kind}:${leg.legId}`]),
  ];
  // Not "avoid": a quota is no failure, and the ladder climbs only on failures (ADR-052 §3).
  d.db.update(tasks).set({ limitedKinds: task.limitedKinds }).where(eq(tasks.id, task.id)).run();
}

/**
 * An end that isn't the task's, read from the Leg's own words (ADR-052
 * §4, M13.22; core's `unusableOf`), put on record: a deprecated model
 * hidden (the one it names offered instead), a usage limit kept until the
 * reset it says, its provider or its program resting. The attempt's
 * outcome; null: the task's own failure.
 */
export function markUnusable(
  x: Pick<AttemptCtx, "d" | "task" | "leg" | "event">,
  error: string | null,
  atStart = false,
): AttemptOutcome | null {
  const { d, leg } = x;
  const now = d.now();
  const u = unusableOf(error, leg.model, now, atStart);
  if (!u) return null;
  const what = `${leg.legName} · ${leg.model}`;
  if (u.kind === "deprecated") {
    const replacementId = d.registry.deprecateModel(leg.legModelId, u.replacement);
    x.event("task.model-deprecated", {
      legId: leg.legId,
      legModelId: leg.legModelId,
      model: leg.model,
      replacement: u.replacement,
      replacementId,
    });
    return {
      kind: "retry",
      reason: `${what} was deprecated by its provider${u.replacement ? `; ${u.replacement} takes its place` : "; it is hidden"}, and the attempt doesn't count against the task`,
    };
  }
  if (u.kind === "limit") {
    const until = u.until ?? now + 15 * 60_000;
    const l = d.registry.require(leg.legId);
    if (!l.limitedUntil || l.limitedUntil < until)
      d.registry.setHealth(
        leg.legId,
        "rate-limited",
        `Out of quota until ${new Date(until).toISOString()}: ${u.reason}`,
        until,
      );
    markLimited(x);
    x.event("task.leg-limited", { legId: leg.legId, until, reason: u.reason });
    return {
      kind: "retry",
      reason: `${leg.legName} is out of quota until ${whenSaid(until, now)} (${u.reason})`,
    };
  }
  const infra = u.failure;
  const { until, inARow } = d.registry.providerFailed(leg.legId, leg.legModelId, infra);
  x.event("task.provider-failed", {
    legId: leg.legId,
    legModelId: leg.legModelId,
    scope: infra.scope,
    reason: infra.reason,
    until,
    inARow,
  });
  return {
    kind: "retry",
    reason: `${infra.scope === "leg" ? leg.legName : what} failed at its provider (${infra.reason}); it rests until ${new Date(until).toISOString()}, and the attempt doesn't count against the task`,
  };
}
