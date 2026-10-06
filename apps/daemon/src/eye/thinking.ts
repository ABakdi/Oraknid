import type { EyeThought } from "@oraknid/contracts";
import { and, desc, eq, inArray, like } from "drizzle-orm";
import type { Db } from "../db/open.ts";
import { events, legModels, legs, sessions } from "../db/schema.ts";
import type { EventBus } from "../events/bus.ts";

// The Eye thinks out loud (M13.25, The-Eye → Thinking out loud): each
// reasoning call of a job is shown in its conversation while it runs, what
// it does in words, its model, its time and what it writes as it comes
// (the Leg session's own log, read by `sessions.log`), then folded to one
// line saying what came of it. While it thinks I can stop it, or have it
// think again with a message of mine.

/** What each call is doing, in words, while it runs. */
const PURPOSE: Record<string, string> = {
  plan: "Planning the work",
  replan: "Planning fixes for the failed checks",
  extend: "Planning your new work into the job",
  interview: "Preparing the interview",
  triage: "Reading your message",
  "triage-open": "Reading your answer",
  evaluate: "Reviewing a task's result",
  "repair-check": "Looking at a failing check",
  classify: "Judging a command",
  "pick-skill": "Choosing the method",
  "job-summary": "Writing what was built",
  "name-job": "Naming the job",
  summarize: "Shortening the job's memory",
};

/** The calls I can stop or redo: The Eye's own thinking, not a quick judgement in passing. */
export const INTERRUPTIBLE = new Set([
  "plan",
  "replan",
  "extend",
  "interview",
  "triage",
  "triage-open",
  "evaluate",
  "repair-check",
  "pick-skill",
]);

/** The calls a job's program makes: stopping one pauses the job, to think again on resume. */
export const PROGRAM_CALLS = new Set([
  "plan",
  "replan",
  "interview",
  "evaluate",
  "repair-check",
  "pick-skill",
]);

export const purposeOf = (call: string, again = false) =>
  again
    ? `${PURPOSE[call] ?? "Thinking"} again, with what you said`
    : (PURPOSE[call] ?? "Thinking");

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const INTENT_WORDS: Record<string, string> = {
  instruction: "an instruction",
  task: "new work",
  context: "context to keep",
  later: "an idea for later",
  stop: "a request to stop",
  question: "a question",
};

/** What came of a call, in a line, from its answer. */
export function summaryOf(call: string, value: unknown): string {
  const v = (value ?? {}) as Record<string, unknown>;
  const count = (k: string) => (Array.isArray(v[k]) ? (v[k] as unknown[]).length : 0);
  switch (call) {
    case "plan":
      return `Planned ${plural(count("tasks"), "task")}`;
    case "replan":
      return `Planned ${plural(count("tasks"), "fix", "fixes")}`;
    case "extend":
      return `Planned ${plural(count("tasks"), "new task")} into the job`;
    case "interview":
      return v.done ? "Nothing more to ask" : `Asked ${plural(count("questions"), "question")}`;
    case "triage":
    case "triage-open":
      return `Read your message: ${INTENT_WORDS[String(v.intent)] ?? "understood"}`;
    case "evaluate":
      return v.accepted ? "Accepted the result" : "Sent the work back";
    case "repair-check":
      return v.broken ? "The check was wrong: repaired it" : "The check is right";
    case "classify":
      return v.decision === "allow" ? "Allowed the command" : "Asked you about the command";
    case "pick-skill":
      return "Chose the method";
    case "job-summary":
      return "Wrote what was built";
    case "name-job":
      return typeof v.title === "string" ? `Named it “${v.title}”` : "Named the job";
    case "summarize":
      return "Shortened the job's memory";
    default:
      return "Done";
  }
}

/** How a running thought was interrupted: stopped, or to think again with my words. */
export type Interruption = { kind: "stop" } | { kind: "redo"; text: string };

/** A thought running now, as the brain holds it. */
export interface Thinking {
  readonly thought: EyeThought;
  /** Set when I stop it or have it think again; the brain reads it once its session ends. */
  interruption: Interruption | null;
  /** Called on an interruption: the brain ends the Leg session. */
  onInterrupt(fn: () => void): void;
}

interface Live extends Thinking {
  thought: EyeThought;
  stop: (() => void) | null;
}

/** The Eye's reasoning calls, live and past, for the conversation (M13.25). */
export class EyeThinking {
  readonly #live = new Map<string, Live>();
  /** Messages I added as context while it thought: for the next call of the job. */
  readonly #notes = new Map<string, string[]>();

  constructor(private readonly o: { db: Db; bus: EventBus; now?: () => number }) {}

  #now() {
    return (this.o.now ?? Date.now)();
  }

  /** A call starts thinking: shown at once in the job's conversation. */
  begin(i: { id: string; jobId: string; call: string; model: string; again?: boolean }): Thinking {
    const thought: EyeThought = {
      id: i.id,
      jobId: i.jobId,
      call: i.call,
      purpose: purposeOf(i.call, i.again),
      model: i.model,
      startedAt: this.#now(),
      endedAt: null,
      outcome: "thinking",
      summary: null,
      again: !!i.again,
      interruptible: INTERRUPTIBLE.has(i.call),
    };
    const live: Live = {
      thought,
      interruption: null,
      stop: null,
      onInterrupt(fn) {
        live.stop = fn;
        if (live.interruption) fn();
      },
    };
    this.#live.set(i.id, live);
    this.#publish("eye.thinking.started", thought);
    return live;
  }

  /** A call ended: folded to one line saying what came of it. */
  end(t: Thinking, outcome: Exclude<EyeThought["outcome"], "thinking" | "lost">, summary: string) {
    if (!this.#live.delete(t.thought.id)) return;
    const thought: EyeThought = {
      ...t.thought,
      endedAt: this.#now(),
      outcome,
      summary: summary.slice(0, 300),
    };
    this.#publish("eye.thinking.ended", thought);
  }

  #publish(type: string, thought: EyeThought) {
    this.o.bus.publish({
      type,
      topic: `job:${thought.jobId}`,
      jobId: thought.jobId,
      payload: thought,
      actor: "eye",
    });
  }

  /** What The Eye is thinking now about these jobs. */
  running(jobIds: string[]): EyeThought[] {
    const ids = new Set(jobIds);
    return [...this.#live.values()].map((l) => l.thought).filter((t) => ids.has(t.jobId));
  }

  /**
   * Stops what The Eye is thinking about a job, or has it think again with
   * my words. Only its own thinking (plans, the interview, reading my
   * message, reviews), never a quick judgement in passing. Returns what it
   * interrupted.
   */
  interrupt(jobId: string, how: Interruption): EyeThought[] {
    const hit: EyeThought[] = [];
    for (const l of this.#live.values()) {
      if (l.thought.jobId !== jobId || !l.thought.interruptible || l.interruption) continue;
      l.interruption = how;
      hit.push(l.thought);
      l.stop?.();
    }
    return hit;
  }

  /** A message I added while it thought: read by the job's next call that plans or judges. */
  note(jobId: string, text: string) {
    const list = this.#notes.get(jobId) ?? [];
    list.push(text);
    this.#notes.set(jobId, list.slice(-10));
  }

  /** The messages added for a job's next call, taken once. */
  takeNotes(jobId: string): string[] {
    const list = this.#notes.get(jobId) ?? [];
    this.#notes.delete(jobId);
    return list;
  }

  /**
   * The thoughts of these jobs, oldest first, at most `limit` of the
   * newest: from their Leg sessions (so older calls are there too), with
   * what each came to from its end event, and those running now.
   */
  list(jobIds: string[], limit = 200): EyeThought[] {
    if (!jobIds.length) return [];
    const rows = this.o.db
      .select({ s: sessions, legName: legs.name, model: legModels.displayName })
      .from(sessions)
      .innerJoin(legs, eq(legs.id, sessions.legId))
      .innerJoin(legModels, eq(legModels.id, sessions.legModelId))
      .where(and(inArray(sessions.jobId, jobIds), like(sessions.attemptId, "eye:%")))
      .orderBy(desc(sessions.startedAt), desc(sessions.id))
      .limit(limit)
      .all();
    const ended = new Map<string, EyeThought>();
    for (const e of this.o.db
      .select({ payload: events.payload })
      .from(events)
      .where(and(inArray(events.jobId, jobIds), eq(events.type, "eye.thinking.ended")))
      .all()) {
      const t = e.payload as EyeThought | null;
      if (t?.id) ended.set(t.id, t);
    }
    return rows
      .flatMap(({ s, legName, model }): EyeThought[] => {
        const call = (s.attemptId ?? "").slice(4);
        // A shadow plan runs beside the real one, never shown (ADR-022).
        if (call.endsWith(":shadow")) return [];
        const live = this.#live.get(s.id);
        if (live) return [live.thought];
        const done = ended.get(s.id);
        if (done) return [done];
        return [
          {
            id: s.id,
            jobId: s.jobId ?? "",
            call,
            purpose: purposeOf(call),
            model: `${legName} · ${model}`,
            startedAt: s.startedAt,
            endedAt: s.endedAt,
            outcome:
              s.endedAt === null || s.endReason === "crashed"
                ? "lost"
                : s.endReason === "stopped"
                  ? "stopped"
                  : s.endReason === "closed" || s.endReason === "completed"
                    ? "done"
                    : "failed",
            summary: s.endReason === "crashed" ? "Oraknid stopped while it thought" : null,
            again: false,
            interruptible: false,
          },
        ];
      })
      .reverse();
  }
}

/** Thrown out of a call I stopped. */
export class BrainStopped extends Error {
  constructor(message = "I stopped The Eye's thinking.") {
    super(message);
  }
}
