import type { GateBy, Grant, GrantScope } from "@oraknid/core";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/open.ts";
import { attemptEvents } from "../db/schema.ts";

// The attempt log (ADR-056 §1): an append-only, typed record per attempt,
// in the database. What the agent did and what the Gate decided, the
// results, my questions, the checks' reports, the signals, the outcome.
// The Gate's memory of a task (grants, refusals, the stuck count, the
// untrusted mark, what it asked me) is read from it; the handoff is built
// from it. Reads are bounded: an attempt's last N, a task's by kind.

/** Who blocked an action, as the stuck rule counts it. */
export type BlockLayer = 1 | 2 | "leg" | "owner";

/** A check's result as the log keeps it: the end of its output. */
export interface CheckLine {
  command: string;
  ok: boolean;
  exitCode: number | null;
  output: string;
  refused?: boolean;
  broken?: string;
  guard?: boolean;
}

/** Each kind of event and its data. */
export interface AttemptEventData {
  SessionOpened: { sessionId: string; legId: string; model: string; resumed: string | null };
  /**
   * What a session was told before its first message, in tokens (ADR-066
   * §4): Oraknid's whole system prompt, its context pack and each part of
   * it, the rest (repos, git, servers, GitHub) and the opening message. The
   * agent's own prompt and tools come on top and aren't counted here.
   */
  ContextSize: {
    sessionId: string;
    system: number;
    pack: number;
    task: number;
    checks: number;
    goal: number;
    skill: number;
    silk: number;
    handoff: number;
    digest: number;
    rest: number;
    first: number;
  };
  /** What the agent said in a turn, condensed: once per turn, not every delta. */
  AgentText: { text: string; reason: string };
  ActionRequested: { id: string; tool: string; input: string };
  GateDecision: {
    actionId: string;
    /** `audit`: a Leg without an inline gate ran it, read after the fact (ADR-056 §2). */
    source: "prompt" | "hook" | "mcp" | "owner" | "leg" | "audit";
    tool: string;
    /** The action in its plain form, short. */
    action: string;
    by: GateBy;
    verdict: "allow" | "deny" | "ask";
    reason: string;
    scope?: GrantScope;
    /** Counted toward the stuck rule, on this layer. */
    counts?: BlockLayer;
    /** It ran: the stuck row ends. */
    endsRow?: boolean;
    /** A grant I gave (what I let run once). */
    grant?: Grant;
    /** The once-grant this action used, by what it matches. */
    spent?: string;
    /** What I refused, its key: asked again, it is refused at once (D8). */
    refusal?: string;
  };
  /** `out`: a fingerprint of its output, for the stuck monitor (the same result again). */
  ActionResult: { actionId: string; ok: boolean; out?: string };
  /** An action with no result after a restart: never re-run blindly (ADR-056 §1). */
  ActionUncertain: { actionId: string; tool: string; input: string };
  QuestionAsked: { itemId: string; ask: string; title: string };
  QuestionAnswered: { itemId: string; answer: string | null; withdrawn?: boolean };
  StopRequested: { text: string };
  ChecksRan: {
    passed: boolean;
    results: CheckLine[];
    /** Why they ran: the turn's end, the stop hook, before the work, a repair. */
    why: string;
  };
  Signal: {
    kind: "stuck" | "drift" | "budget" | "stall" | "untrusted";
    code: string | null;
    evidence: string;
  };
  /**
   * A suspicion judged (ADR-056 → Monitors suspect, a model confirms): its
   * verdict, by the judge's stage, from the task's cache, or not judged
   * (the judge failed: acted on gently); the by-products learned for the
   * project from it.
   */
  Judged: {
    key: string;
    code: string;
    evidence: string;
    verdict: "expected" | "drift" | "unsure" | "unjudged";
    reason: string;
    stage: 1 | 2 | null;
    cached: boolean;
    learned: string[];
  };
  /** The judge was unsure: the agent asked once, in its session; then what it answered. */
  SuspicionAsked: { key: string; code: string; question: string };
  SuspicionAnswered: { key: string; code: string; answer: string };
  Outcome: { kind: string; reason: string | null };
  /**
   * The controller moved (ADR-056 §8): from a state to the next, why (the
   * outcome or the event), its idempotency key. A step with side effects
   * carries what it needs to be reconciled after a crash (Done: the
   * checkpoint its commit is measured from).
   */
  Transition: { from: string; to: string; why: string; key: string; ckpt?: string };
  /**
   * What became of an action a restart left uncertain (ADR-056 §1), never
   * re-run to find out: the tree looked at (a file changed, a commit made),
   * or the agent asked to look (a command on a server, a command whose
   * effect the tree doesn't show), then what it said.
   */
  Reconciled: {
    actionId: string;
    tool: string;
    input: string;
    finding: "happened" | "not-happened" | "ask-agent" | "agent-said";
    detail: string;
  };
  HandoffWritten: { silkId: string; failed: string | null };
  AttemptEnded: { reason: string };
  /** The task settled, or its job ended: what the Gate remembered of it is forgotten. */
  Forgotten: { reason: string };
}

export type AttemptEventKind = keyof AttemptEventData;

export type AttemptEvent<K extends AttemptEventKind = AttemptEventKind> = {
  [P in K]: {
    id: number;
    jobId: string;
    taskId: string;
    attemptId: string | null;
    seq: number;
    at: number;
    kind: P;
    data: AttemptEventData[P];
  };
}[K];

/** Where an event belongs. */
export interface LogPlace {
  jobId: string;
  taskId: string;
  attemptId: string | null;
}

/** An attempt's events, bounded: a handoff or a report never loads a whole history. */
const LAST = 200;

export class AttemptLog {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  /** Appends one event; its `seq` follows the attempt's last (the task's, without one). */
  append<K extends AttemptEventKind>(
    at: LogPlace,
    kind: K,
    data: AttemptEventData[K],
  ): AttemptEvent<K> {
    // One statement: the next seq is read where the row is written.
    const next = at.attemptId
      ? sql`(select coalesce(max(${attemptEvents.seq}), 0) + 1 from ${attemptEvents} where ${attemptEvents.attemptId} = ${at.attemptId})`
      : sql`(select coalesce(max(${attemptEvents.seq}), 0) + 1 from ${attemptEvents} where ${attemptEvents.taskId} = ${at.taskId} and ${attemptEvents.attemptId} is null)`;
    const row = this.db
      .insert(attemptEvents)
      .values({
        jobId: at.jobId,
        taskId: at.taskId,
        attemptId: at.attemptId,
        seq: next,
        at: this.now(),
        kind,
        data: data as unknown as Record<string, unknown>,
      })
      .returning()
      .get();
    return row as AttemptEvent<K>;
  }

  /** A writer bound to one place. */
  at(place: LogPlace) {
    return {
      place,
      append: <K extends AttemptEventKind>(kind: K, data: AttemptEventData[K]) =>
        this.append(place, kind, data),
    };
  }

  /** An attempt's events in order, the last `limit` of them (of these kinds). */
  attempt<K extends AttemptEventKind>(
    attemptId: string,
    o: { kinds?: K[]; limit?: number } = {},
  ): AttemptEvent<K>[] {
    const rows = this.db
      .select()
      .from(attemptEvents)
      .where(
        and(
          eq(attemptEvents.attemptId, attemptId),
          o.kinds?.length ? inArray(attemptEvents.kind, o.kinds) : undefined,
        ),
      )
      .orderBy(desc(attemptEvents.seq))
      .limit(o.limit ?? LAST)
      .all();
    return rows.reverse() as AttemptEvent<K>[];
  }

  /**
   * A task's events of these kinds, across its attempts, in order: those
   * after `afterId`, the last `limit` of them.
   */
  task<K extends AttemptEventKind>(
    taskId: string,
    o: { kinds: K[]; afterId?: number; limit?: number },
  ): AttemptEvent<K>[] {
    const rows = this.db
      .select()
      .from(attemptEvents)
      .where(
        and(
          eq(attemptEvents.taskId, taskId),
          inArray(attemptEvents.kind, o.kinds),
          o.afterId ? gt(attemptEvents.id, o.afterId) : undefined,
        ),
      )
      .orderBy(desc(attemptEvents.id))
      .limit(o.limit ?? LAST)
      .all();
    return rows.reverse() as AttemptEvent<K>[];
  }

  /** The last event of a kind for a task, or null. */
  lastOf<K extends AttemptEventKind>(taskId: string, kind: K): AttemptEvent<K> | null {
    return (this.task(taskId, { kinds: [kind], limit: 1 })[0] ?? null) as AttemptEvent<K> | null;
  }

  /** How many events an attempt has (for tests and the report). */
  count(attemptId: string): number {
    return (
      this.db
        .select({ n: sql<number>`count(*)` })
        .from(attemptEvents)
        .where(eq(attemptEvents.attemptId, attemptId))
        .get()?.n ?? 0
    );
  }

  /**
   * Actions an attempt asked for and never saw the result of (ADR-056 §1),
   * not yet marked uncertain: what was in flight when it stopped.
   */
  unmatched(attemptId: string): AttemptEvent<"ActionRequested">[] {
    const rows = this.attempt(attemptId, {
      kinds: ["ActionRequested", "ActionResult", "ActionUncertain"],
      limit: 1000,
    });
    const closed = new Set(
      rows
        .filter((r) => r.kind === "ActionResult" || r.kind === "ActionUncertain")
        .map((r) => (r.data as { actionId: string }).actionId),
    );
    return rows.filter(
      (r): r is AttemptEvent<"ActionRequested"> =>
        r.kind === "ActionRequested" && !closed.has(r.data.id),
    );
  }
}

/** A tool call's input, short: what the log keeps of it. */
export function inputSummary(input: Record<string, unknown>, max = 300): string {
  const command = input.command;
  if (typeof command === "string") return command.slice(0, max);
  const path = input.file_path ?? input.path ?? input.url;
  if (typeof path === "string") return path.slice(0, max);
  try {
    return JSON.stringify(input).slice(0, max);
  } catch {
    return "";
  }
}
