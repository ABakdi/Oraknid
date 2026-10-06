import type { MachineHealth, MachineIncident, MetricsSample } from "@oraknid/contracts";
import {
  assess,
  type Finding,
  type Incident,
  type MachineReading,
  pickToPause,
  runaway,
  stepGuard,
  type TreePoint,
} from "@oraknid/core";
import type { EventBus } from "../events/bus.ts";
import { thresholdsOf, type Work } from "./work.ts";

// The guard (ADR-050): every few seconds it reads the machine; when work
// would crash it (memory and swap, an overloaded CPU, a session running
// away) it pauses Oraknid's newest or heaviest task at a safe point and
// tells me once per incident, what is happening and what it did. Work
// starts again by itself once the machine has recovered. It never touches
// my own processes.

/** A task's facts the guard needs: its name, and its class to learn its cost. */
export interface GuardTask {
  title: string;
  kind: string;
  verify: string[];
  instructions: string;
}

export interface GuardOptions {
  work: Work;
  bus: EventBus;
  now: () => number;
  reading: () => MachineReading | null;
  /** The last metrics sample, for each session's process tree. */
  lastSample: () => MetricsSample | null;
  /** Sessions running now: whose task each is, and when each last said anything. */
  sessions: () => {
    id: string;
    jobId: string | null;
    taskId: string | null;
    lastEventAt: number;
  }[];
  task: (taskId: string) => GuardTask | null;
  /** Pauses a task at a safe point; it starts again by itself once there is room. */
  pause: (jobId: string, taskId: string, why: string) => Promise<boolean>;
  intervalMs?: number;
  /** How long a finding must be gone before its incident closes. */
  clearMs?: number;
  /** At most one pause for room this often, so the machine settles in between. */
  pauseEveryMs?: number;
  /** How long a task that ran away is held back before it tries again. */
  holdMs?: number;
}

/** Starts the guard; `tick` runs one look at once (tests drive it so). */
export function startGuard(o: GuardOptions) {
  let open = new Map<string, Incident>();
  const did = new Map<string, string>();
  let prev: MachineReading | null = null;
  let lastSampleAt = 0;
  let lastPauseAt = Number.NEGATIVE_INFINITY;
  const histories = new Map<string, TreePoint[]>();
  const peaks = new Map<string, { taskId: string; rss: number; cpu: number }>();
  let busy = false;

  const publish = (type: string, payload: Record<string, unknown>) =>
    o.bus.publish({ type, topic: "overview", jobId: null, payload });

  /** Each session's tree, sampled; a session that ended teaches its task's class what it took. */
  function watchSessions(
    found: Finding[],
    runaways: Map<string, { jobId: string; taskId: string }>,
  ) {
    const sample = o.lastSample();
    if (!sample || sample.at === lastSampleAt) return;
    lastSampleAt = sample.at;
    const live = new Map(o.sessions().map((s) => [s.id, s]));
    for (const p of sample.processes) {
      const s = live.get(p.id);
      if (!s?.taskId || !s.jobId) continue;
      const h = histories.get(p.id) ?? [];
      h.push({
        at: sample.at,
        rssBytes: p.rssBytes,
        processes: p.processes,
        cpuPercent: p.cpuPercent,
        zombies: p.zombies ?? 0,
        lastOutputAt: s.lastEventAt,
      });
      while (h.length && (h[0] as TreePoint).at < sample.at - 6 * 60_000) h.shift();
      histories.set(p.id, h);
      const peak = peaks.get(p.id) ?? { taskId: s.taskId, rss: 0, cpu: 0 };
      peaks.set(p.id, {
        taskId: s.taskId,
        rss: Math.max(peak.rss, p.rssBytes),
        cpu: Math.max(peak.cpu, p.cpuPercent),
      });
      const away = runaway(h);
      if (away) {
        const title = o.task(s.taskId)?.title ?? "A task";
        found.push({
          kind: `runaway:${p.id}`,
          level: "danger",
          message: `“${title}” is running away: ${away.message}`,
          relieve: false,
        });
        runaways.set(`runaway:${p.id}`, { jobId: s.jobId, taskId: s.taskId });
      }
    }
    for (const id of [...histories.keys()])
      if (!live.has(id)) {
        histories.delete(id);
        const peak = peaks.get(id);
        peaks.delete(id);
        const t = peak ? o.task(peak.taskId) : null;
        if (peak && t && peak.rss > 0)
          o.work.learn(t, { n: 1, peakRssBytes: peak.rss, peakCpuPercent: peak.cpu });
      }
  }

  /** What each running task's session uses now. */
  function rssOf(taskId: string): number {
    const sample = o.lastSample();
    const ids = new Set(
      o
        .sessions()
        .filter((s) => s.taskId === taskId)
        .map((s) => s.id),
    );
    return (sample?.processes ?? [])
      .filter((p) => ids.has(p.id))
      .reduce((n, p) => n + p.rssBytes, 0);
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const r = o.reading();
      if (!r) return;
      const s = o.work.settings();
      const now = o.now();
      const found = assess(r, thresholdsOf(s), new Set(open.keys()), prev, s.pauseForMyWork);
      prev = r;
      const runaways = new Map<string, { jobId: string; taskId: string }>();
      watchSessions(found, runaways);
      const step = stepGuard(open, found, now, o.clearMs ?? 30_000);
      open = step.open;

      // A session running away: its task is paused and held back a while.
      for (const f of step.opened) {
        const who = runaways.get(f.kind);
        if (!who) continue;
        const title = o.task(who.taskId)?.title ?? "the task";
        const hold = o.holdMs ?? 10 * 60_000;
        o.work.holdBack(
          who.jobId,
          who.taskId,
          hold,
          `it ran away and was paused; it tries again at ${new Date(now + hold).toTimeString().slice(0, 5)}`,
        );
        did.set(
          f.kind,
          `Paused “${title}”; it tries again in ${Math.round(hold / 60_000)} minutes, or look at it first.`,
        );
        void o.pause(who.jobId, who.taskId, `Paused: it ran away (${f.message})`);
      }

      // Memory, swap, load or my own work pressing: nothing new starts, and one task is paused.
      const pressing = [...open.values()].filter((i) => i.finding.relieve);
      const worst = pressing.find((i) => i.finding.level === "danger") ?? pressing[0];
      o.work.setDanger(worst ? worst.finding.message : null);
      if (worst && now - lastPauseAt >= (o.pauseEveryMs ?? 20_000)) {
        const pick = pickToPause(
          o.work.running().map((x) => ({ ...x, rssBytes: rssOf(x.taskId) })),
        );
        if (pick) {
          lastPauseAt = now;
          const mine = worst.finding.kind === "busy";
          const what = mine ? "the computer for your work" : "memory";
          const back = mine ? "the computer is free again" : "memory is back";
          o.work.pausedForRoom(pick.jobId, pick.taskId, pick.title);
          const line = `Paused “${pick.title}” to free ${what}; it resumes when ${back}.`;
          did.set(
            worst.finding.kind,
            did.has(worst.finding.kind) ? `${did.get(worst.finding.kind)} ${line}` : line,
          );
          void o.pause(pick.jobId, pick.taskId, `Paused to free ${what}; it resumes when ${back}.`);
          if (!step.opened.some((f) => f.kind === worst.finding.kind))
            publish("machine.health", { kind: worst.finding.kind, did: line });
        }
      }

      // Told once per incident: what is happening and what Oraknid did.
      for (const f of step.opened)
        publish("machine.incident", {
          kind: f.kind,
          level: f.level,
          message: f.message,
          did: did.get(f.kind) ?? null,
        });
      for (const c of step.closed) {
        did.delete(c.finding.kind);
        publish("machine.recovered", { kind: c.finding.kind, message: c.finding.message });
      }
    } finally {
      busy = false;
    }
  }

  const timer = setInterval(() => void tick(), o.intervalMs ?? 5000);
  timer.unref();

  return {
    tick,
    stop: () => clearInterval(timer),
    /** The machine's health as the UI shows it (Overview, the banner). */
    health(): MachineHealth {
      const incidents: MachineIncident[] = [...open.values()].map((i) => ({
        kind: i.finding.kind,
        level: i.finding.level,
        message: i.finding.message,
        did: did.get(i.finding.kind) ?? null,
        since: i.since,
      }));
      const { cap, mine } = o.work.cap();
      const r = prev;
      return {
        state: incidents.some((i) => i.level === "danger")
          ? "danger"
          : incidents.length
            ? "busy"
            : "ok",
        incidents,
        running: o.work.running().length,
        limit: cap,
        limitIsAuto: !mine,
        pausedForRoom: o.work.pausedNow(),
        reading: r
          ? {
              memoryUsed: r.memoryTotal ? 1 - r.memoryAvailable / r.memoryTotal : 0,
              cpu: r.cpu,
              swapUsed: r.swapTotal ? Math.min(1, r.swapUsed / r.swapTotal) : null,
              memoryPressure: r.pressure?.memory ?? null,
              diskFreeBytes: r.disks.length ? Math.min(...r.disks.map((d) => d.freeBytes)) : null,
            }
          : null,
      };
    },
  };
}

export type Guard = ReturnType<typeof startGuard>;
