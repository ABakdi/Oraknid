import { cpus, totalmem } from "node:os";
import {
  DEFAULT_THRESHOLDS_RESOURCES,
  ResourceSettings,
  type ResourceThresholds,
} from "@oraknid/contracts";
import {
  admit,
  autoTasksAtOnce,
  costClass,
  defaultLegSessions,
  type LearnedCost,
  type LegRoom,
  learnCost,
  type MachineReading,
  type TaskCost,
  taskCost,
  type Verdict,
  type WaitWhy,
} from "@oraknid/core";
import { z } from "zod";
import type { Db } from "../db/open.ts";
import type { EventBus } from "../events/bus.ts";
import { attemptsNow } from "../eye/leg-work.ts";
import type { LegRegistry } from "../legs/registry.ts";
import type { LegSupervisor } from "../legs/supervisor.ts";
import { readSetting, writeSetting } from "../settings.ts";

// Parallel by default, admitted by resources (ADR-050): the one place
// every job's tasks ask before starting, so the machine, the Legs and my
// cap are shared by all of them.

/** Tasks at once, my thresholds, pausing for my own work. */
export const RESOURCES = "work.resources";
/** What tasks of each class were seen to take (their sessions' process trees at peak). */
export const LEARNED_COSTS = "work.costs";
const Learned = z.record(
  z.string(),
  z.object({ n: z.number(), peakRssBytes: z.number(), peakCpuPercent: z.number() }),
);

export const readResources = (db: Db): ResourceSettings =>
  readSetting(db, RESOURCES, ResourceSettings, ResourceSettings.parse({}));

export function writeResources(db: Db, patch: Partial<ResourceSettings>) {
  const cur = readResources(db);
  writeSetting(db, RESOURCES, ResourceSettings, {
    ...cur,
    ...patch,
    thresholds: { ...cur.thresholds, ...(patch.thresholds ?? {}) },
  });
}

export const thresholdsOf = (s: ResourceSettings): ResourceThresholds => ({
  ...DEFAULT_THRESHOLDS_RESOURCES,
  ...s.thresholds,
});

/** A Leg's limit of task sessions at once: its own setting, else its kind's (ADR-050). */
export function legSessionLimit(registry: LegRegistry, legId: string): number {
  const leg = registry.require(legId);
  const n = (leg.config as { maxSessions?: unknown }).maxSessions;
  return typeof n === "number" && n >= 1 ? n : defaultLegSessions(leg.kind);
}

/** A task asking to start. */
export interface StartRequest {
  jobId: string;
  jobTitle: string;
  taskId: string;
  title: string;
  cost: TaskCost;
  /** The job's priority: a higher one's task goes first when room is short. */
  priority: number;
  allowedLegIds: string[];
}

interface Running {
  jobId: string;
  taskId: string;
  title: string;
  cost: TaskCost;
  startedAt: number;
}

interface Waiting {
  req: StartRequest;
  why: WaitWhy | "scope" | "held";
  reason: string;
  since: number;
  /** Asked last at: a waiter that stopped asking no longer goes first. */
  seen: number;
}

export interface WorkDeps {
  db: Db;
  bus: EventBus;
  registry: LegRegistry;
  supervisor: LegSupervisor;
  now: () => number;
  /** The machine now, disks included; null until the first samples. */
  reading?: () => MachineReading | null;
}

const key = (jobId: string, taskId: string) => `${jobId}/${taskId}`;

/** How long a started task's expected memory is set aside, until the readings show it. */
const RESERVE_MS = 20_000;

/**
 * Every job's tasks ask here before starting (ADR-050). Holds what runs,
 * what waits and why, the tasks paused to make room, and the danger the
 * guard sees; answers with the admission rules of `@oraknid/core`.
 */
export class Work {
  readonly #running = new Map<string, Running>();
  readonly #waiting = new Map<string, Waiting>();
  readonly #pausedForRoom = new Map<string, { jobId: string; taskId: string; title: string }>();
  /** Tasks held back a while after running away. */
  readonly #holds = new Map<string, { until: number; reason: string }>();
  #danger: string | null = null;
  readonly #wakers = new Set<() => void>();

  constructor(readonly d: WorkDeps) {}

  settings(): ResourceSettings {
    return readResources(this.d.db);
  }

  /** The most tasks at once now: mine, else the machine's own. */
  cap(): { cap: number; mine: boolean } {
    const s = this.settings();
    if (s.tasksAtOnce !== "auto") return { cap: s.tasksAtOnce, mine: true };
    const r = this.d.reading?.() ?? null;
    return {
      cap: autoTasksAtOnce(r?.cores ?? cpus().length, r?.memoryTotal || totalmem()),
      mine: false,
    };
  }

  /** What a task is expected to take, from its commands and what its class was seen to take. */
  costOf(t: { kind: string; verify: string[]; instructions: string }): TaskCost {
    const learned = readSetting(this.d.db, LEARNED_COSTS, Learned, {});
    const guess = taskCost(t);
    return taskCost(t, learned[costClass(t.kind, guess.heavy)] ?? null);
  }

  /** A session's peak, learned for its task's class. */
  learn(t: { kind: string; verify: string[]; instructions: string }, peak: LearnedCost) {
    const learned = readSetting(this.d.db, LEARNED_COSTS, Learned, {});
    const k = costClass(t.kind, taskCost(t).heavy);
    learned[k] = learnCost(learned[k], peak);
    writeSetting(this.d.db, LEARNED_COSTS, Learned, learned);
  }

  /**
   * May the task start now? Yes: it is counted as running until `release`.
   * No: it waits, with the reason shown on it.
   */
  tryStart(req: StartRequest): { ok: true; release: () => void } | { ok: false; reason: string } {
    const k = key(req.jobId, req.taskId);
    const now = this.d.now();
    const hold = this.#holds.get(k);
    if (hold && hold.until > now) {
      this.#wait(req, "held", hold.reason);
      return { ok: false, reason: hold.reason };
    }
    const verdict = this.#verdict(req);
    if (!verdict.ok) {
      // Paused to make room: it says so until it starts again.
      const reason = this.#pausedForRoom.has(k)
        ? `paused to make room, ${verdict.reason}`
        : verdict.reason;
      this.#wait(req, verdict.why, reason);
      return { ok: false, reason };
    }
    // Room for one: a waiting task of a job with a higher priority (or asking longer) goes first.
    const before = this.#ahead(req, now);
    if (before) {
      const reason = `waiting its turn: “${before.req.title}” of “${before.req.jobTitle}” goes first`;
      this.#wait(req, "cap", reason);
      return { ok: false, reason };
    }
    this.#clear(req.jobId, req.taskId);
    this.#pausedForRoom.delete(k);
    this.#running.set(k, {
      jobId: req.jobId,
      taskId: req.taskId,
      title: req.title,
      cost: req.cost,
      startedAt: now,
    });
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.#running.delete(k);
        this.wake();
      },
    };
  }

  /** A job's own reason a ready task waits (an overlap, its own limit), shown on it. */
  waitFor(req: StartRequest, reason: string) {
    this.#wait(req, "scope", reason);
  }

  /** Why the task waits, or null. */
  reasonOf(jobId: string, taskId: string): string | null {
    return this.#waiting.get(key(jobId, taskId))?.reason ?? null;
  }

  /** It no longer waits: it started, ended, or isn't ready any more. */
  clear(jobId: string, taskId: string) {
    this.#clear(jobId, taskId);
  }

  /** A job that stopped forgets its waiting tasks. */
  forgetJob(jobId: string) {
    for (const w of [...this.#waiting.values()])
      if (w.req.jobId === jobId) this.#clear(jobId, w.req.taskId);
    for (const [k, p] of this.#pausedForRoom) if (p.jobId === jobId) this.#pausedForRoom.delete(k);
    this.wake();
  }

  /** Tasks running now, across every job. */
  running(): (Running & { key: string })[] {
    return [...this.#running].map(([k, r]) => ({ key: k, ...r }));
  }

  runningIn(jobId: string): number {
    let n = 0;
    for (const r of this.#running.values()) if (r.jobId === jobId) n++;
    return n;
  }

  /** The danger the guard sees: nothing new starts while it lasts. */
  setDanger(message: string | null) {
    if (this.#danger === message) return;
    this.#danger = message;
    this.wake();
  }

  danger() {
    return this.#danger;
  }

  /** A task the guard paused for room; it starts again by itself once there is room. */
  pausedForRoom(jobId: string, taskId: string, title: string) {
    this.#pausedForRoom.set(key(jobId, taskId), { jobId, taskId, title });
  }

  pausedNow() {
    return [...this.#pausedForRoom.values()];
  }

  /** Held back a while: it ran away (ADR-050). */
  holdBack(jobId: string, taskId: string, ms: number, reason: string) {
    this.#holds.set(key(jobId, taskId), { until: this.d.now() + ms, reason });
  }

  /** Resolves when something changed (a task ended, danger passed, a setting), or after `ms`. */
  changed(ms = 2000): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        this.#wakers.delete(done);
        resolve();
      };
      const t = setTimeout(done, ms);
      t.unref?.();
      this.#wakers.add(done);
    });
  }

  wake() {
    for (const w of [...this.#wakers]) w();
  }

  #verdict(req: StartRequest): Verdict {
    const s = this.settings();
    const { cap, mine } = this.cap();
    // A task just started hasn't taken its memory yet: what it may need is set aside for it.
    const r = this.d.reading?.() ?? null;
    const now = this.d.now();
    let reserved = 0;
    for (const x of this.#running.values())
      if (now - x.startedAt < RESERVE_MS) reserved += x.cost.memoryBytes;
    return admit({
      title: req.title,
      cost: req.cost,
      running: [...this.#running.values()].map((x) => ({ title: x.title, heavy: x.cost.heavy })),
      reading: r && { ...r, memoryAvailable: Math.max(0, r.memoryAvailable - reserved) },
      danger: this.#danger,
      legs: this.#legs(req.allowedLegIds),
      pending: this.#pending(),
      cap,
      capIsMine: mine,
      thresholds: thresholdsOf(s),
      pauseForMyWork: s.pauseForMyWork,
    });
  }

  /** The Legs the task may use that can take work now, and how full each is. */
  #legs(allowed: string[]): LegRoom[] {
    return this.d.registry
      .all()
      .filter(
        (l) =>
          (!allowed.length || allowed.includes(l.id)) &&
          l.enabled &&
          !l.paused &&
          (l.health === "healthy" || l.health === "degraded"),
      )
      .map((l) => ({
        name: l.name,
        running: this.d.supervisor.busy(l.id),
        limit: legSessionLimit(this.d.registry, l.id),
      }));
  }

  /** Tasks admitted that hold no Leg session yet. */
  #pending(): number {
    const holding = new Set(attemptsNow().map((a) => key(a.jobId, a.taskId)));
    let n = 0;
    for (const k of this.#running.keys()) if (!holding.has(k)) n++;
    return n;
  }

  /** A task asking for longer, or of a job with a higher priority, that would start now. */
  #ahead(req: StartRequest, now: number): Waiting | null {
    for (const w of this.#waiting.values()) {
      if (w.req.jobId === req.jobId || w.why === "scope" || w.why === "held" || now - w.seen > 5000)
        continue;
      const first =
        w.req.priority > req.priority || (w.req.priority === req.priority && w.since < now - 1000);
      if (first && this.#verdict(w.req).ok) return w;
    }
    return null;
  }

  #wait(req: StartRequest, why: Waiting["why"], reason: string) {
    const k = key(req.jobId, req.taskId);
    const was = this.#waiting.get(k);
    const now = this.d.now();
    this.#waiting.set(k, { req, why, reason, since: was?.since ?? now, seen: now });
    // Told when what it waits for changes, not each time a figure moves.
    if (was?.why !== why || (why === "scope" && was.reason !== reason))
      this.d.bus.publish({
        type: "task.waiting",
        topic: `job:${req.jobId}`,
        jobId: req.jobId,
        payload: { taskId: req.taskId, reason },
      });
  }

  #clear(jobId: string, taskId: string) {
    const k = key(jobId, taskId);
    if (!this.#waiting.delete(k)) return;
    this.d.bus.publish({
      type: "task.waiting",
      topic: `job:${jobId}`,
      jobId,
      payload: { taskId, reason: null },
    });
  }
}
