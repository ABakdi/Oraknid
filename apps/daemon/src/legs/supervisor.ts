import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LegKind } from "@oraknid/contracts";
import type {
  LegAdapter,
  LegEvent,
  LegSession,
  PermissionDecision,
  PermissionRequest,
} from "@oraknid/leg-sdk";
import type { Sandbox, Watched } from "@oraknid/os";
import { eq, isNull } from "drizzle-orm";
import type { Db } from "../db/open.ts";
import { attempts, sessions } from "../db/schema.ts";
import type { EventBus } from "../events/bus.ts";
import { newId } from "../ids.ts";
import { sandboxPlan } from "./plan.ts";
import type { LegRegistry } from "./registry.ts";

export interface StartRequest {
  legId: string;
  legModelId: string;
  effort: string | null;
  jobId: string | null;
  taskId: string | null;
  attemptId?: string | null;
  cwd: string;
  systemPrompt: string;
  prompt: string;
  resumeFrom?: string | null;
  /** Only when I explicitly chose an unsandboxed job (ADR-006). */
  unsandboxed?: boolean;
  onPermission: (request: PermissionRequest) => Promise<PermissionDecision>;
}

export interface Supervised {
  id: string;
  session: LegSession;
  /** Every event, for The Eye to watch (drift, questions, turn ends). */
  events: AsyncIterable<LegEvent>;
}

interface Live {
  id: string;
  legId: string;
  label: string;
  session: LegSession;
}

/**
 * Runs Leg sessions (Architecture-Overview → Leg supervisor): starts them
 * in the sandbox, writes their raw stream to a log, records usage and
 * quota, publishes condensed events, and knows their processes for
 * metrics and recovery.
 */
export class LegSupervisor {
  readonly #live = new Map<string, Live>();

  constructor(
    private readonly o: {
      db: Db;
      bus: EventBus;
      registry: LegRegistry;
      adapters: Partial<Record<LegKind, LegAdapter>>;
      sandbox: Sandbox;
      legsDir: string;
      logsDir: string;
      now?: () => number;
      /** Secrets out of logs (BR-13). */
      scrub?: (text: string) => string;
    },
  ) {}

  #now() {
    return (this.o.now ?? Date.now)();
  }

  /** Sessions being closed on purpose, not killed. */
  readonly #closing = new Map<string, string>();

  /** Ends a session Oraknid is done with: "closed", or "stopped" by a pause or shutdown, not "killed". */
  async close(s: Supervised, reason: "closed" | "stopped" = "closed") {
    this.#closing.set(s.id, reason);
    await s.session.kill();
  }

  async start(req: StartRequest): Promise<Supervised> {
    const { registry } = this.o;
    const leg = registry.require(req.legId);
    const model = registry.model(req.legModelId);
    if (!model || model.legId !== leg.id)
      throw new Error("That model does not belong to that Leg.");
    if (!leg.enabled) throw new Error(`${leg.name} is disabled.`);
    if (leg.paused) throw new Error(`${leg.name} is paused.`);
    if (leg.health === "unavailable" || leg.health === "rate-limited") {
      throw new Error(`${leg.name} is ${leg.health}: ${leg.healthDetail ?? ""}`.trim());
    }
    const adapter = this.o.adapters[leg.kind as LegKind];
    if (!adapter) throw new Error(`No adapter for ${leg.kind}.`);

    const id = newId(this.#now());
    const logDir = join(this.o.logsDir, req.jobId ?? "no-job");
    mkdirSync(logDir, { recursive: true });
    const logFile = join(logDir, `${id}.ndjson`);
    this.o.db
      .insert(sessions)
      .values({
        id,
        attemptId: req.attemptId ?? null,
        jobId: req.jobId,
        taskId: req.taskId,
        legId: leg.id,
        legModelId: model.id,
        effort: req.effort,
        logFile,
        startedAt: this.#now(),
      })
      .run();

    let session: LegSession;
    try {
      session = await adapter.start({
        leg: registry.toConfig(leg),
        model: model.model,
        effort: req.effort,
        cwd: req.cwd,
        systemPrompt: req.systemPrompt,
        prompt: req.prompt,
        resumeFrom: req.resumeFrom ?? null,
        sandbox: req.unsandboxed ? null : sandboxPlan(leg, this.o.sandbox, this.o.legsDir),
        credential: await registry.credential(leg),
        onPermission: req.onPermission,
      });
    } catch (error) {
      // A start that failed leaves no session looking alive (Audit 1 → Q1-13).
      this.#end(id, "crashed", error instanceof Error ? error.message : String(error));
      throw error;
    }

    // Killing through the supervisor records the end itself: after a kill nobody may read the stream's last event.
    const supervised: LegSession = {
      ...session,
      kill: async () => {
        await session.kill();
        const reason = this.#closing.get(id) ?? "killed";
        this.#closing.delete(id);
        this.#end(id, reason, null);
        this.#live.delete(id);
      },
    };
    this.#live.set(id, {
      id,
      legId: leg.id,
      label: `${leg.name} · ${model.displayName}`,
      session: supervised,
    });
    this.#publish(req, leg.id, "session.started", {
      sessionId: id,
      model: model.model,
      effort: req.effort,
    });
    return {
      id,
      session: supervised,
      events: this.#pump(id, req, leg.id, model.id, session, logFile),
    };
  }

  /** Tees the session's events: log, database, bus, then the caller. */
  async *#pump(
    id: string,
    req: StartRequest,
    legId: string,
    legModelId: string,
    session: LegSession,
    logFile: string,
  ): AsyncGenerator<LegEvent> {
    let text = "";
    let textTimer: NodeJS.Timeout | undefined;
    const flushText = () => {
      clearTimeout(textTimer);
      textTimer = undefined;
      if (!text) return;
      this.#publish(req, legId, "session.text", { sessionId: id, text });
      text = "";
    };
    try {
      for await (const e of session.events()) {
        const line = JSON.stringify({ at: this.#now(), ...e });
        appendFileSync(logFile, `${this.o.scrub ? this.o.scrub(line) : line}\n`);
        this.#recordPid(id, session);
        switch (e.type) {
          case "text.delta":
            // Coalesced: the activity stream gets lines, not tokens (Realtime-Transport).
            text += e.text;
            textTimer ??= setTimeout(flushText, 250);
            break;
          case "usage":
            this.o.db
              .update(sessions)
              .set({
                inputTokens: e.usage.inputTokens,
                outputTokens: e.usage.outputTokens,
                cacheReadTokens: e.usage.cacheReadTokens,
                cacheWriteTokens: e.usage.cacheWriteTokens,
                contextTokens: e.usage.contextTokens,
                usageEstimated: e.usage.estimated,
                nativeSessionId: session.nativeSessionId(),
              })
              .where(eq(sessions.id, id))
              .run();
            this.#publish(req, legId, "session.usage", { sessionId: id, ...e.usage });
            break;
          case "rate_limit":
            this.o.registry.applyQuota(legId, legModelId, e.quota);
            break;
          case "session.ended":
            break;
          default:
            flushText();
            this.#publish(req, legId, `session.${e.type}`, { sessionId: id, ...withoutType(e) });
        }
        yield e;
        if (e.type === "session.ended") {
          this.#end(id, e.reason, e.error);
          return;
        }
      }
      this.#end(id, "completed", null);
    } finally {
      flushText();
      this.#live.delete(id);
    }
  }

  #recordPid(id: string, session: LegSession) {
    const pid = session.pid();
    if (!pid) return;
    const row = this.o.db
      .select({ pid: sessions.pid })
      .from(sessions)
      .where(eq(sessions.id, id))
      .get();
    if (row?.pid === pid) return;
    this.o.db
      .update(sessions)
      .set({ pid, pidStartTime: pidStartTime(pid) })
      .where(eq(sessions.id, id))
      .run();
  }

  #end(id: string, reason: string, error: string | null) {
    const row = this.o.db.select().from(sessions).where(eq(sessions.id, id)).get();
    if (!row || row.endedAt) return;
    this.o.db
      .update(sessions)
      .set({ endedAt: this.#now(), endReason: reason, endError: error })
      .where(eq(sessions.id, id))
      .run();
    this.o.bus.publish({
      type: "session.ended",
      topic: row.jobId ? `job:${row.jobId}` : `leg:${row.legId}`,
      jobId: row.jobId,
      payload: { sessionId: id, reason, error },
    });
  }

  #publish(req: StartRequest, legId: string, type: string, payload: Record<string, unknown>) {
    const actor = `leg:${legId}`;
    if (req.jobId)
      this.o.bus.publish({ type, topic: `job:${req.jobId}`, jobId: req.jobId, payload, actor });
    this.o.bus.publish({ type, topic: `leg:${legId}`, jobId: req.jobId, payload, actor });
  }

  /** Process trees to measure (Overview → Resources). */
  watched(): Watched[] {
    return [...this.#live.values()].flatMap((l) => {
      const pid = l.session.pid();
      return pid ? [{ id: l.id, label: l.label, pid }] : [];
    });
  }

  live(): string[] {
    return [...this.#live.keys()];
  }

  async killAll() {
    await Promise.all([...this.#live.values()].map((l) => l.session.kill()));
  }

  /**
   * Recovery hook (Durability → step 3): sessions left open by a crash are
   * marked crashed, and their processes killed if they are still the same
   * processes (pid and start time).
   */
  recoverOrphans(): number {
    const open = this.o.db.select().from(sessions).where(isNull(sessions.endedAt)).all();
    for (const s of open) {
      if (s.pid && s.pidStartTime && pidStartTime(s.pid) === s.pidStartTime) {
        try {
          process.kill(-s.pid, "SIGKILL");
        } catch {
          try {
            process.kill(s.pid, "SIGKILL");
          } catch {}
        }
      }
      this.o.db
        .update(sessions)
        .set({
          endedAt: this.#now(),
          endReason: "crashed",
          endError: "Oraknid stopped while it ran.",
        })
        .where(eq(sessions.id, s.id))
        .run();
    }
    // An attempt open at startup was cut short with its process (Durability): closed as abandoned.
    this.o.db
      .update(attempts)
      .set({ endedAt: this.#now(), outcome: "abandoned" })
      .where(isNull(attempts.endedAt))
      .run();
    return open.length;
  }
}

/** Field 22 of /proc/<pid>/stat: start time in clock ticks since boot. */
export function pidStartTime(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
  } catch {
    return null;
  }
}

function withoutType(e: LegEvent): Record<string, unknown> {
  const { type: _t, ...rest } = e;
  return rest;
}
