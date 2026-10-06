import type { MetricsSample, ResourceThresholds } from "@oraknid/contracts";

// Parallel by default, admitted by resources (ADR-050): every ready task
// whose scope can't conflict may start, while the machine has room, its
// Legs have sessions free, and my cap allows. A guard watches for danger
// (memory and swap, disk, the OOM killer, heat, a session running away)
// and says so once per incident.

const MB = 1024 ** 2;
const GB = 1024 ** 3;

/** A Leg session's CLI and its helpers, before anything it runs. */
export const SESSION_BYTES = 600 * MB;
/** A build, an install, a test suite: what a heavy task may take besides its session. */
export const HEAVY_BYTES = 2 * GB;

/** The machine as admission and the guard read it: the last ten seconds, and the disks. */
export interface MachineReading {
  cores: number;
  /** CPU use of all cores, 0–1, averaged over the recent samples. */
  cpu: number;
  memoryTotal: number;
  memoryAvailable: number;
  /** Null when the machine doesn't say; 0 when it has no swap. */
  swapTotal: number | null;
  swapUsed: number;
  /** Bytes a second read back from swap. */
  swapInPerSec: number;
  load1: number | null;
  /** avg10 in percent; null without PSI. */
  pressure: { cpu: number; memory: number; memoryFull: number; io: number } | null;
  /** The data folder's disk and each running project's, by a label I recognise. */
  disks: { label: string; freeBytes: number; totalBytes: number }[];
  oomKills: number | null;
  thermalThrottles: number | null;
  /** What Oraknid's own processes (the daemon and its sessions) use together. */
  ownRss: number;
  /** Share of all cores they use, 0–1. */
  ownCpu: number;
}

/**
 * The reading of recent samples: CPU averaged (a one-second spike holds
 * nothing back), memory and swap as they are now. Null with no samples.
 */
export function readingOf(
  samples: MetricsSample[],
  disks: MachineReading["disks"] = [],
): MachineReading | null {
  const last = samples.at(-1);
  if (!last) return null;
  const s = last.system;
  const cpu = samples.reduce((n, x) => n + x.system.cpuPercent, 0) / samples.length / 100;
  const ownCpu = last.processes.reduce((n, p) => n + p.cpuPercent, 0) / 100 / (s.cores || 1);
  return {
    cores: s.cores,
    cpu: Math.min(1, cpu),
    memoryTotal: s.memoryTotalBytes,
    memoryAvailable: Math.max(0, s.memoryTotalBytes - s.memoryUsedBytes),
    swapTotal: s.swapTotalBytes ?? null,
    swapUsed: s.swapUsedBytes ?? 0,
    // Averaged too: one burst of swap-in is not thrashing.
    swapInPerSec:
      samples.reduce((n, x) => n + (x.system.swapInBytesPerSec ?? 0), 0) / samples.length,
    load1: s.load1 ?? null,
    pressure: s.pressure ?? null,
    disks,
    oomKills: s.oomKills ?? null,
    thermalThrottles: s.thermalThrottles ?? null,
    ownRss: last.processes.reduce((n, p) => n + p.rssBytes, 0),
    ownCpu: Math.min(1, ownCpu),
  };
}

// ── What a task may cost ──────────────────────────────────────────────

/** What a task is expected to take: heavy ones don't run beside each other. */
export interface TaskCost {
  heavy: boolean;
  /** Memory it may need at its peak: its session, and what it builds or tests. */
  memoryBytes: number;
  /** Why it counts as heavy, in words. */
  why: string | null;
}

/** What Oraknid saw tasks of one class take (their sessions' process trees at peak). */
export interface LearnedCost {
  /** Sessions seen. */
  n: number;
  peakRssBytes: number;
  /** Percent of one core, at peak. */
  peakCpuPercent: number;
}

/** Commands that build, install or run a whole suite: a CPU and memory hog while they run. */
const HEAVY_COMMAND =
  /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:install|i|ci|add)|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build|cargo\s+(?:build|test|install|bench)|docker\s+(?:build|compose\s+(?:up|build))|podman\s+build|go\s+(?:build|test)|mvn\s|gradle|cmake|bazel|xcodebuild|next\s+build|vite\s+build|webpack|playwright\s+test|cypress\s+run|pip\s+install|poetry\s+install|uv\s+sync|make\s+(?:all|build|-j))/i;

/** The class a task's observations are kept under. */
export const costClass = (kind: string, heavy: boolean) => `${kind}:${heavy ? "heavy" : "light"}`;

/**
 * A task's expected cost: from what its checks and instructions run, then
 * from what tasks of its class were seen to take (two sessions or more).
 */
export function taskCost(
  t: { kind: string; verify: string[]; instructions: string },
  learned?: LearnedCost | null,
): TaskCost {
  const command = [...t.verify, t.instructions]
    .map((x) => HEAVY_COMMAND.exec(x)?.[0])
    .find(Boolean);
  let heavy = !!command;
  let why = command ? `it runs \`${command.trim()}\`` : null;
  let memoryBytes = SESSION_BYTES + (heavy ? HEAVY_BYTES : 0);
  if (learned && learned.n >= 2) {
    memoryBytes = Math.max(SESSION_BYTES / 2, learned.peakRssBytes);
    if (learned.peakRssBytes >= 1.5 * GB || learned.peakCpuPercent >= 200) {
      heavy = true;
      why ??= `tasks like it took ${gb(learned.peakRssBytes)} and ${Math.round(learned.peakCpuPercent)}% CPU`;
    }
  }
  return { heavy, memoryBytes, why };
}

/** A session's peak folded into what its class is known to take (a moving average). */
export function learnCost(prev: LearnedCost | null | undefined, peak: LearnedCost): LearnedCost {
  if (!prev || prev.n === 0) return { ...peak, n: 1 };
  const w = Math.min(prev.n, 4) / (Math.min(prev.n, 4) + 1);
  return {
    n: prev.n + 1,
    peakRssBytes: Math.round(prev.peakRssBytes * w + peak.peakRssBytes * (1 - w)),
    peakCpuPercent: Math.round(prev.peakCpuPercent * w + peak.peakCpuPercent * (1 - w)),
  };
}

// ── How many at once ──────────────────────────────────────────────────

/**
 * The machine's own cap of tasks at once: three of every four cores, and
 * half of the memory in sessions, never more than twelve.
 */
export function autoTasksAtOnce(cores: number, memoryTotal: number): number {
  const byCpu = Math.max(1, Math.floor(cores * 0.75));
  const byMemory = Math.max(1, Math.floor((memoryTotal * 0.5) / SESSION_BYTES));
  return Math.min(12, byCpu, byMemory);
}

/**
 * A Leg's task sessions at once unless I set it: a Claude subscription runs
 * several, a local model server one (it shares this machine's GPU).
 */
export function defaultLegSessions(kind: string, local = false): number {
  if (local || kind === "openai-compatible") return 1;
  return kind === "claude-code" ? 3 : 2;
}

/** A Leg the task may use, and how full it is. */
export interface LegRoom {
  name: string;
  running: number;
  limit: number;
}

export interface AdmissionInput {
  title: string;
  cost: TaskCost;
  /** Tasks running now across every job. */
  running: { title: string; heavy: boolean }[];
  reading: MachineReading | null;
  /** An open danger incident's message: nothing new starts. */
  danger: string | null;
  /** The Legs it may use that can take work now; empty when none could (routing says why). */
  legs: LegRoom[];
  /** Tasks admitted that hold no Leg session yet. */
  pending: number;
  cap: number;
  capIsMine: boolean;
  thresholds: ResourceThresholds;
  /** Hold work while the machine is busy with my own things. */
  pauseForMyWork: boolean;
}

/** Why a ready task waits: what the UI groups it by. */
export type WaitWhy = "danger" | "cap" | "legs" | "disk" | "heavy" | "memory" | "cpu";

export type Verdict = { ok: true } | { ok: false; why: WaitWhy; reason: string };

/**
 * May this task start now? Checked in order: danger, my cap, its Legs'
 * sessions, disk, heavy beside heavy, memory, CPU. With nothing of
 * Oraknid's running, one task always may unless the machine is in danger,
 * out of disk or nearly out of memory, so work never stalls on a machine
 * busy with my own things (unless I asked for that).
 */
export function admit(a: AdmissionInput): Verdict {
  const th = a.thresholds;
  const no = (why: WaitWhy, reason: string): Verdict => ({ ok: false, why, reason });
  if (a.danger) return no("danger", `waiting for the computer to recover: ${lower(a.danger)}`);
  if (a.running.length >= a.cap)
    return no(
      "cap",
      `${a.running.length} ${a.running.length === 1 ? "task runs" : "tasks run"} at once already, the most ${a.capIsMine ? "I allowed" : "this computer takes"}`,
    );
  if (a.legs.length) {
    const free = a.legs.reduce((n, l) => n + Math.max(0, l.limit - l.running), 0) - a.pending;
    if (free <= 0) {
      const [only] = a.legs;
      return no(
        "legs",
        a.legs.length === 1 && only
          ? `${only.name} busy with ${only.running} session${only.running === 1 ? "" : "s"}`
          : `every Leg is busy (${a.legs.map((l) => `${l.name}: ${l.running} of ${l.limit}`).join(", ")})`,
      );
    }
  }
  const r = a.reading;
  const low = r?.disks.find((d) => d.freeBytes < th.minFreeDiskBytes);
  if (low) return no("disk", `waiting for disk space: ${gb(low.freeBytes)} free on ${low.label}`);
  const heavyNow = a.running.filter((x) => x.heavy);
  if (a.cost.heavy && heavyNow.length >= th.heavyAtOnce)
    return no(
      "heavy",
      `heavy, like “${heavyNow[0]?.title}”: ${th.heavyAtOnce === 1 ? "heavy tasks run one at a time" : `at most ${th.heavyAtOnce} heavy tasks at once`}`,
    );
  if (!r?.memoryTotal) return { ok: true };
  const first = a.running.length === 0 && !a.pauseForMyWork;
  const left = r.memoryAvailable - a.cost.memoryBytes;
  const floor = (first ? th.dangerMemory : th.minFreeMemory) * r.memoryTotal;
  if (left < floor)
    return no(
      "memory",
      `waiting for memory: ${gb(r.memoryAvailable)} free, it may need ${gb(a.cost.memoryBytes)}`,
    );
  if (!first && r.pressure && r.pressure.memory >= 10)
    return no(
      "memory",
      `waiting for memory: the computer is short of it (pressure ${pct(r.pressure.memory / 100)})`,
    );
  if (!first && r.cpu > th.maxCpu) return no("cpu", `waiting for CPU: ${pct(r.cpu)} busy`);
  if (!first && r.load1 !== null && r.load1 > r.cores * 2)
    return no("cpu", `waiting for CPU: load ${r.load1.toFixed(1)} on ${r.cores} cores`);
  return { ok: true };
}

// ── The guard ─────────────────────────────────────────────────────────

/** Something wrong on the machine, as one reading shows it. */
export interface Finding {
  /** memory, swap, load, disk, oom, thermal, busy, or runaway:<id>. */
  kind: string;
  level: "warning" | "danger";
  message: string;
  /** Pausing some of Oraknid's work helps (memory, swap, load, my own work). */
  relieve: boolean;
}

/**
 * What is wrong now. `open` holds the incidents already open: each closes
 * only once well clear of where it opened (hysteresis), so a reading
 * hovering at a threshold is one incident, not many. `prev` is the
 * reading before, for counters that only rise (the OOM killer, throttling).
 */
export function assess(
  r: MachineReading,
  th: ResourceThresholds,
  open: ReadonlySet<string>,
  prev?: Pick<MachineReading, "oomKills" | "thermalThrottles"> | null,
  pauseForMyWork = false,
): Finding[] {
  const out: Finding[] = [];
  const total = r.memoryTotal || 1;
  const free = r.memoryAvailable / total;
  const used = 1 - free;
  const p = r.pressure;
  const swapping = r.swapInPerSec >= 1 * MB || (p ? p.memoryFull >= 5 : false);
  const memoryLine = open.has("memory")
    ? free < th.dangerMemory + 0.05 &&
      (swapping || free < th.dangerMemory || (p?.memoryFull ?? 0) >= 2)
    : free < th.dangerMemory &&
      (swapping || free < th.dangerMemory / 2 || r.swapTotal === 0 || (p?.memory ?? 0) >= 20);
  if (memoryLine)
    out.push({
      kind: "memory",
      level: "danger",
      message:
        r.cpu >= 0.9
          ? `Memory and CPU are both nearly full (memory ${pct(used)} used, CPU ${pct(r.cpu)})${swapping ? ", and the computer is swapping" : ""}.`
          : `Memory is nearly full (${pct(used)} used, ${gb(r.memoryAvailable)} left)${swapping ? ", and the computer is swapping" : ""}.`,
      relieve: true,
    });
  const thrashing = open.has("swap")
    ? r.swapInPerSec >= 2 * MB || (p?.memoryFull ?? 0) >= 2
    : r.swapInPerSec >= 20 * MB || (p?.memoryFull ?? 0) >= 10;
  if (thrashing)
    out.push({
      kind: "swap",
      level: "danger",
      message: `The computer is thrashing: it reads ${mb(r.swapInPerSec)}/s back from swap${p ? ` and stalls on memory ${pct(p.memoryFull / 100)} of the time` : ""}.`,
      relieve: true,
    });
  if (r.load1 !== null) {
    const overloaded = open.has("load")
      ? r.load1 > r.cores * 2 && (free < 0.25 || (p?.memory ?? 0) >= 5)
      : r.load1 > r.cores * 4 && (free < 0.2 || (p?.memory ?? 0) >= 10);
    if (overloaded)
      out.push({
        kind: "load",
        level: "danger",
        message: `The computer is overloaded: load ${r.load1.toFixed(0)} on ${r.cores} cores, with memory short (${pct(used)} used).`,
        relieve: true,
      });
  }
  for (const d of r.disks) {
    const kind = `disk:${d.label}`;
    const short = open.has(kind)
      ? d.freeBytes < th.minFreeDiskBytes * 1.25
      : d.freeBytes < th.minFreeDiskBytes;
    if (short)
      out.push({
        kind,
        level: d.freeBytes < th.minFreeDiskBytes / 4 ? "danger" : "warning",
        message: `The disk is nearly full: ${gb(d.freeBytes)} free on ${d.label}.`,
        relieve: false,
      });
  }
  if (prev?.oomKills != null && r.oomKills != null && r.oomKills > prev.oomKills) {
    const n = r.oomKills - prev.oomKills;
    out.push({
      kind: "oom",
      level: "danger",
      message: `The kernel ran out of memory and killed ${n === 1 ? "a process" : `${n} processes`}.`,
      relieve: true,
    });
  }
  if (
    prev?.thermalThrottles != null &&
    r.thermalThrottles != null &&
    r.thermalThrottles > prev.thermalThrottles
  )
    out.push({
      kind: "thermal",
      level: "warning",
      message: "The CPU is slowing itself down to cool off (thermal throttling).",
      relieve: false,
    });
  if (pauseForMyWork && !memoryLine) {
    // Busy with my own things: mostly not Oraknid's doing.
    const owners = r.ownCpu < r.cpu / 2 && r.ownRss < (total - r.memoryAvailable) / 2;
    const busy = open.has("busy")
      ? r.cpu > th.maxCpu - 0.15 || free < th.minFreeMemory + 0.05
      : r.cpu > th.maxCpu || free < th.minFreeMemory;
    if (owners && busy)
      out.push({
        kind: "busy",
        level: "warning",
        message: `The computer is busy with your own work (CPU ${pct(r.cpu)}, memory ${pct(used)} used).`,
        relieve: true,
      });
  }
  return out;
}

/** An incident: a finding open since a time, until it has been gone a while. */
export interface Incident {
  finding: Finding;
  since: number;
  /** Seen last at; it closes once absent for the clearing time. */
  lastSeen: number;
}

/**
 * One step of the guard: what opened (told once) and what closed. A
 * finding opens at once; it closes after `clearMs` without it.
 */
export function stepGuard(
  open: ReadonlyMap<string, Incident>,
  findings: Finding[],
  now: number,
  clearMs = 30_000,
): { open: Map<string, Incident>; opened: Finding[]; closed: Incident[] } {
  const next = new Map(open);
  const opened: Finding[] = [];
  for (const f of findings) {
    const was = next.get(f.kind);
    if (was) next.set(f.kind, { ...was, finding: f, lastSeen: now });
    else {
      next.set(f.kind, { finding: f, since: now, lastSeen: now });
      opened.push(f);
    }
  }
  const closed: Incident[] = [];
  const seen = new Set(findings.map((f) => f.kind));
  for (const [kind, i] of next)
    if (!seen.has(kind) && now - i.lastSeen >= clearMs) {
      next.delete(kind);
      closed.push(i);
    }
  return { open: next, opened, closed };
}

// ── A session running away ────────────────────────────────────────────

/** One sample of a session's process tree. */
export interface TreePoint {
  at: number;
  rssBytes: number;
  processes: number;
  /** Percent of one core. */
  cpuPercent: number;
  zombies: number;
  /** When the session last said anything; null when unknown. */
  lastOutputAt: number | null;
}

/**
 * A session's processes running away: memory growing without bound, a
 * fork bomb, a CPU pegged for minutes with no output, a storm of zombies.
 * Reads the last few minutes of its tree, oldest first.
 */
export function runaway(points: TreePoint[]): { kind: string; message: string } | null {
  const last = points.at(-1);
  if (!last) return null;
  if (last.zombies >= 50)
    return {
      kind: "zombies",
      message: `${last.zombies} defunct processes pile up in its tree, never reaped.`,
    };
  if (last.processes >= 400)
    return { kind: "fork", message: `it started ${last.processes} processes: a fork bomb.` };
  const recent = points.filter((p) => p.at >= last.at - 30_000);
  const before = recent[0];
  if (before && last.processes - before.processes >= 150)
    return {
      kind: "fork",
      message: `its processes went from ${before.processes} to ${last.processes} in ${Math.round((last.at - before.at) / 1000)} s: a fork bomb.`,
    };
  // Memory: two minutes or more of growth, doubled, past 2 GB, its last third never as low
  // as its first third's highest (a build that rises and falls back is not running away).
  const window = points.filter((p) => p.at >= last.at - 5 * 60_000);
  const start = window[0];
  if (start && last.at - start.at >= 120_000 && last.rssBytes >= 2 * GB) {
    const third = Math.max(1, Math.floor(window.length / 3));
    const early = Math.max(...window.slice(0, third).map((p) => p.rssBytes));
    const late = Math.min(...window.slice(-third).map((p) => p.rssBytes));
    if (last.rssBytes >= start.rssBytes * 2 && late > early)
      return {
        kind: "memory",
        message: `its memory grew from ${gb(start.rssBytes)} to ${gb(last.rssBytes)} in ${Math.round((last.at - start.at) / 60_000)} minutes and keeps growing.`,
      };
  }
  // CPU: pegged for five minutes with nothing said.
  const pegged = points.filter((p) => p.at >= last.at - 5 * 60_000);
  const first = pegged[0];
  if (
    first &&
    last.at - first.at >= 5 * 60_000 - 1 &&
    pegged.every((p) => p.cpuPercent >= 90) &&
    last.lastOutputAt !== null &&
    last.at - last.lastOutputAt >= 5 * 60_000
  )
    return {
      kind: "cpu",
      message: `it has kept a CPU core busy for ${Math.round((last.at - first.at) / 60_000)} minutes without saying anything.`,
    };
  return null;
}

/**
 * Which running task to pause for room: the heaviest when it clearly is
 * (a quarter of a gigabyte more than the next), else the newest.
 */
export function pickToPause<T extends { startedAt: number; rssBytes: number }>(
  running: T[],
): T | null {
  if (!running.length) return null;
  const byRss = [...running].sort((a, b) => b.rssBytes - a.rssBytes);
  const [heaviest, next] = byRss;
  if (heaviest && (!next || heaviest.rssBytes - next.rssBytes >= 256 * MB)) return heaviest;
  return [...running].sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
}

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1).replace(/\.$/, "");
const pct = (x: number) => `${Math.round(x * 100)}%`;
const mb = (b: number) => `${Math.round(b / MB)} MB`;
export const gb = (b: number) => `${(b / GB).toFixed(1)} GB`;
