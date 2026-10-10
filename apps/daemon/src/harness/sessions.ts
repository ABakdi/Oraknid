import { createHash } from "node:crypto";
import {
  aheadOfPace,
  estimateTokens,
  HANDOFF_REQUEST,
  PACE_GRACE,
  type RouteCandidate,
} from "@oraknid/core";
import {
  asRequest,
  type Capabilities,
  capabilitiesOf,
  type LegEvent,
  type PermissionRequest,
} from "@oraknid/leg-sdk";
import { desc, eq } from "drizzle-orm";
import { sessions } from "../db/schema.ts";
import type { Supervised } from "../legs/supervisor.ts";
import { serversForLeg } from "../servers/for-leg.ts";
import type { JobServerRef } from "../servers/remote.ts";
import { handoffFromLog } from "../silk/handoff.ts";
import type { ToolRow } from "../tools/registry.ts";
import { EndAttempt, markUnusable } from "./apply.ts";
import type { AttemptState, TurnEnded } from "./facts.ts";
import { asPermission, asPreTool, type Gate } from "./gate.ts";
import type { AttemptLog } from "./log.ts";
import { contextPackSized } from "./pack.ts";
import { handoffFromAttempt, recordEvents } from "./record.ts";
import { jobTools } from "./tools.ts";
import type { AttemptDeps, AttemptJob, AttemptWhere, TaskRow } from "./types.ts";

// AgentSession by capability (ADR-056 §2): an attempt's sessions opened,
// resumed, handed off, rotated and closed for any kind of Leg through the
// supervisor, by what the Leg's probe says it can do — never by its kind.
// Each capability it lacks has its declared fallback:
//
//   | capability  | has it                              | lacks it                                    |
//   | inlineGate  | every action asked before it runs   | its actions audited after the fact, to drift |
//   | preToolHook | its own auto mode, Oraknid's hook   | every prompt is Oraknid's ("ask")            |
//   | stopHook    | the checks hold the turn's end       | the checks run after the turn ends           |
//   | resume      | the same model continues its session | a fresh session with a handoff from the log  |
//   | steer       | (not used yet)                       | my messages wait for the turn's end          |
//
// The session's events go to the attempt log (the agent's actions, results
// and words), to the Gate (results end the stuck row; the Leg's own
// refusals count) and to the attempt's observations (the drift monitors).

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);

/** A Leg's sessions for one attempt: the job's servers made reachable from its home, once. */
export function legServers(d: AttemptDeps, job: AttemptJob, legId: string) {
  /** The job's servers as its commands name them, production marked (ADR-049). */
  const list: JobServerRef[] = [];
  let text = "";
  let ready = false;
  return {
    list,
    text: () => text,
    /** Their state documents and a way in from the Leg's own home (ADR-026). */
    async prepare() {
      if (ready) return;
      ready = true;
      text = await serversForLeg(d, job, legId, list);
    },
  };
}

/** Where a session on a Leg short of tokens compacts, as a share of its window (ADR-066 §5). */
export const SCARCE_COMPACT_AT = 0.5;

/**
 * A Leg short of tokens (ADR-066 §5): a window with less than a quarter
 * left, or used well ahead of its time.
 */
export function scarce(leg: Pick<RouteCandidate, "windows">, now: number): boolean {
  return leg.windows.some(
    (w) =>
      (w.utilization !== null && w.utilization > 0.75) || (aheadOfPace(w, now) ?? 0) > PACE_GRACE,
  );
}

export interface SessionSpec {
  d: AttemptDeps;
  job: AttemptJob;
  task: TaskRow;
  leg: RouteCandidate;
  effort: string | null;
  attemptId: string;
  ws: AttemptWhere;
  ckpt: string;
  gate: Gate;
  log: AttemptLog;
  trail: ReturnType<AttemptLog["at"]>;
  signal: AbortSignal;
  st: AttemptState;
  servers: ReturnType<typeof legServers>;
  toolRows: ToolRow[];
  event: (type: string, payload: Record<string, unknown>) => void;
  /** The checks before the agent may end its turn (ADR-052 §2), for a Leg with a stop hook. */
  onStop: (said: string) => Promise<string | null>;
}

export type SessionManager = ReturnType<typeof createSessionManager>;

export function createSessionManager(s: SessionSpec) {
  const { d, job, task, leg, gate, trail, st, signal } = s;
  /** What the Leg can do, from its probe (ADR-056 §2): never a list of kinds. */
  const caps: Capabilities = capabilitiesOf(d.registry.features(leg.legId));
  let session = null as Supervised | null;
  let sessionLog: string | null = null;
  const tools = jobTools(d, job, task.id, { toolRows: s.toolRows, gate, event: s.event });
  /** The agent's actions, their results (read by the Gate) and words, in the attempt log. */
  const logEvent = recordEvents(trail, gate.ran);
  /** Commands waiting for their result, by tool call id. */
  const pending = new Map<string, string>();
  /** Audits after the fact still being read (no inline gate): settled before a turn is decided. */
  const audits: Promise<unknown>[] = [];

  /** What every turn's events tell the log, the Gate and the drift monitors. */
  const watch = (e: LegEvent) => {
    const observed = st.observed;
    observed.lastActivityAt = d.now();
    logEvent(e);
    if (e.type === "tool.called") {
      if (typeof e.input.command === "string") pending.set(e.id, e.input.command);
      // No inline gate: what it ran is read by the Gate's rules after the fact, and feeds drift.
      if (!caps.inlineGate)
        audits.push(gate.afterTheFact(asRequest(e.tool, e.input)).catch(() => null));
    }
    if (e.type === "tool.result" && pending.has(e.id)) {
      observed.commands.push({
        command: pending.get(e.id) as string,
        outputHash: hash(`${e.ok}:${e.output}`),
      });
      pending.delete(e.id);
    }
    // The Leg's own auto mode refused a call (ADR-053): the Gate counts it like any other block.
    if (e.type === "permission.denied" && e.by === "leg") gate.legRefused(e.request, e.reason);
    if (e.type === "usage") {
      st.sessionTokens = e.usage.inputTokens + e.usage.outputTokens;
      observed.tokensSinceProgress = Math.max(0, st.sessionTokens - st.tokensBaseline);
      st.usage = e.usage;
    }
  };

  /** Reads events until a turn ends; null when `ms` pass first (time to look for a stall). */
  const nextTurnEnd = async (ms: number, onEvent?: (e: LegEvent) => void) => {
    if (!session) throw new Error("no session");
    const end = await turnEndOf(session, signal, ms, onEvent);
    if (end && audits.length) await Promise.all(audits.splice(0));
    return end;
  };

  /** The Leg's permission prompt; and its pre-tool hook in its own auto mode (ADR-053). */
  const onPermission = async (r: PermissionRequest) =>
    asPermission(await gate.decide({ source: "prompt", request: r }));
  const onPreToolUse = async (r: PermissionRequest) =>
    asPreTool(await gate.decide({ source: "hook", request: r }));

  const manager = {
    caps,
    current: () => session,

    /**
     * The native session the attempt continues (ADR-052 §1): the same model
     * again after an attempt that didn't succeed, its work not rolled back
     * (a kill), on a Leg that can resume. Otherwise null: a fresh session
     * with the handoff (no resume's fallback).
     */
    resumable(
      before: {
        id: string;
        legModelId: string;
        outcome: string | null;
        escalations: unknown;
      } | null,
    ): string | null {
      if (
        !before ||
        !caps.resume ||
        before.legModelId !== leg.legModelId ||
        before.outcome === "succeeded" ||
        (before.escalations as string[]).some((e) => e.endsWith(":kill"))
      )
        return null;
      return (
        d.db
          .select({ native: sessions.nativeSessionId })
          .from(sessions)
          .where(eq(sessions.attemptId, before.id))
          .orderBy(desc(sessions.startedAt))
          .all()
          .find((x) => x.native)?.native ?? null
      );
    },

    /** Opens a session (resumed when `resume` names one), with the hooks the Leg has. */
    async open(prompt: string, resume: string | null = null): Promise<Supervised> {
      await s.servers.prepare();
      st.observed.lastActivityAt = d.now();
      const mcp = await tools.open();
      // A new session counts its tokens from zero.
      st.sessionTokens = 0;
      st.tokensBaseline = 0;
      // Its own auto mode only with Oraknid's hook in it; careful keeps every prompt Oraknid's (ADR-053).
      const auto = caps.preToolHook && job.autonomy !== "careful";
      const packed = contextPackSized(d, job, task, {
        contextWindow: leg.profile.contextWindow ?? null,
        ws: s.ws,
        toolRows: s.toolRows,
        serversText: s.servers.text(),
      });
      try {
        session = await d.supervisor.start({
          legId: leg.legId,
          legModelId: leg.legModelId,
          effort: s.effort,
          jobId: job.id,
          taskId: task.id,
          attemptId: s.attemptId,
          cwd: s.ws.cwd,
          systemPrompt: packed.text,
          prompt,
          ...(resume ? { resumeFrom: resume } : {}),
          unsandboxed: job.unsandboxed,
          localPorts: job.localPorts ?? [],
          onPermission,
          // Without a stop hook the checks run after the turn ends (the controller's Verifying).
          ...(caps.stopHook ? { onStop: s.onStop } : {}),
          // Named in the session's prompt by adapters that list them; Oraknid runs them.
          checks: task.verify,
          permissionMode: auto ? "auto" : "ask",
          ...(auto ? { onPreToolUse } : {}),
          ...(mcp ? { tools: mcp } : {}),
          // A Leg whose tokens are scarce compacts its history earlier (ADR-066 §5).
          ...(scarce(leg, d.now()) ? { compactAt: SCARCE_COMPACT_AT } : {}),
        });
      } catch (error) {
        if (signal.aborted) throw error;
        // A Leg that fails to start is unusable for now, never the task failing (ADR-052 §4).
        const why = error instanceof Error ? error.message : String(error);
        const outcome = markUnusable({ d, task, leg, event: s.event }, why, true);
        throw new EndAttempt(
          outcome ?? {
            kind: "retry",
            reason: `${leg.legName} could not start a session (${why}); the attempt doesn't count against the task`,
          },
          { kind: "CouldNotStart" },
        );
      }
      sessionLog =
        d.db
          .select({ logFile: sessions.logFile })
          .from(sessions)
          .where(eq(sessions.id, session.id))
          .get()?.logFile ?? null;
      trail.append("SessionOpened", {
        sessionId: session.id,
        legId: leg.legId,
        model: leg.model,
        resumed: resume,
      });
      // What it was told, by part, before its first message (ADR-066 §4).
      trail.append("ContextSize", {
        sessionId: session.id,
        system: estimateTokens(packed.text),
        pack: packed.pack,
        ...packed.size,
        rest: packed.rest,
        first: estimateTokens(prompt),
      });
      return session;
    },

    /** The next turn's end, the events on the way watched; null when `ms` pass first. */
    turnEnd: (ms: number) => nextTurnEnd(ms, watch),

    /** Writes a handoff to Silk: asked of the Leg when it can still answer, rebuilt from its log otherwise. */
    async handOff(askLeg: boolean, failed = "") {
      let body = "";
      if (askLeg && session) {
        try {
          await session.session.send(HANDOFF_REQUEST);
          body = (await nextTurnEnd(120_000))?.text ?? "";
        } catch {}
      }
      if (!/## Goal of the task/.test(body)) {
        body = sessionLog
          ? handoffFromLog({
              goal: task.instructions,
              logFile: sessionLog,
              diffStat: await safeDiffStat(s.ws, s.ckpt),
            })
          : "No session ran yet.";
      }
      // What the attempt log says (ADR-056 §7): what was tried, what the Gate refused, the checks.
      const logged = handoffFromAttempt(s.log, s.attemptId);
      if (logged) body = `${body}\n\n${logged}`;
      const entry = d.silk.add({
        jobId: job.id,
        taskId: task.id,
        kind: "handoff",
        title: `Handoff: ${task.title}`,
        // What failed, for the model that takes it next (ADR-052 §3).
        body: failed
          ? `${body}\n\n## Why it was handed over\n${leg.legName} · ${leg.model} didn't get it done:\n${failed}`
          : body,
        authoredBy: session ? { legId: leg.legId } : "eye",
      });
      trail.append("HandoffWritten", { silkId: entry.id, failed: failed || null });
    },

    /** Ends the session: closed, stopped at a safe point, or killed. */
    async close(how: "close" | "kill" | "stop" = "close") {
      if (session)
        await (how === "kill"
          ? session.session.kill()
          : d.supervisor.close(session, how === "stop" ? "stopped" : "closed"));
      session = null;
    },

    /** Stopped (a pause, a cancel, a shutdown): the turn interrupted, the session closed, a handoff left. */
    async stop() {
      const open = session;
      if (!open) return;
      try {
        await open.session.interrupt();
      } catch {}
      await manager.close("stop");
      try {
        await manager.handOff(false);
      } catch {}
    },

    /** The attempt ended: the job's tools for its sessions close. */
    end() {
      tools.close();
    },
  };
  return manager;
}

/** What changed since a checkpoint, or nothing when git can't tell. */
export async function safeDiffStat(ws: { tree: AttemptWhere["tree"] }, since: string) {
  try {
    return await ws.tree.diffStatSince(since);
  } catch {
    return "";
  }
}

/** The read in flight on each session's events, kept across calls. */
const waiting = new WeakMap<AsyncIterator<LegEvent>, Promise<IteratorResult<LegEvent>>>();
const iterators = new WeakMap<Supervised, AsyncIterator<LegEvent>>();

/** Reads events until a turn ends; null when `ms` pass first (time to look for a stall). */
async function turnEndOf(
  s: Supervised,
  signal: AbortSignal,
  ms: number,
  onEvent?: (e: LegEvent) => void,
): Promise<TurnEnded | null> {
  const it = iterators.get(s) ?? s.events[Symbol.asyncIterator]();
  iterators.set(s, it);
  const deadline = Date.now() + ms;
  for (;;) {
    if (signal.aborted) throw signal.reason;
    const left = deadline - Date.now();
    if (left <= 0) return null;
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    // A read still pending from a call that timed out is reused, never dropped: dropping it
    // lost the event it later delivered (a turn's end), and the attempt waited for ever.
    const pending = waiting.get(it) ?? it.next();
    waiting.set(it, pending);
    const next = await Promise.race([
      pending,
      new Promise<"timeout">((r) => {
        timer = setTimeout(() => r("timeout"), left);
      }),
      new Promise<"abort">((r) => {
        onAbort = () => r("abort");
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]).finally(() => {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener("abort", onAbort);
    });
    if (next === "timeout") return null;
    if (next === "abort") throw signal.reason;
    waiting.delete(it);
    if (next.done)
      return { type: "turn.ended", reason: "error", text: "", error: "The session ended." };
    onEvent?.(next.value);
    if (next.value.type === "turn.ended") return next.value;
  }
}
