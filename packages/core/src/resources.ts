import type { MetricsSample } from "@oraknid/contracts";

// Resource-aware scheduling (ADR-016 → Resources): a new session waits
// for room, so the machine stays responsive. A local model needs real
// headroom; any Leg waits when memory is nearly gone.

export interface Headroom {
  /** A local model may start below these (share of the total). */
  localMemory: number;
  localCpu: number;
  localVram: number;
  /** No session starts above this memory use. */
  anyMemory: number;
}

export const DEFAULT_HEADROOM: Headroom = {
  localMemory: 0.85,
  localCpu: 0.9,
  localVram: 0.9,
  anyMemory: 0.95,
};

const pct = (x: number) => `${Math.round(x * 100)}%`;

/**
 * Why a new session on this kind of Leg should wait now, or null. Reads
 * the average of the recent samples, so a one-second spike doesn't
 * hold work back; with no samples it never holds anything.
 */
export function busyMachine(
  samples: MetricsSample[],
  local: boolean,
  h: Headroom = DEFAULT_HEADROOM,
): string | null {
  if (!samples.length) return null;
  const avg = (f: (s: MetricsSample) => number) =>
    samples.reduce((n, s) => n + f(s), 0) / samples.length;
  const memory = avg((s) =>
    s.system.memoryTotalBytes ? s.system.memoryUsedBytes / s.system.memoryTotalBytes : 0,
  );
  if (memory > h.anyMemory) return `the machine is out of memory (${pct(memory)} used)`;
  if (!local) return null;
  if (memory > h.localMemory) return `the machine is busy: memory at ${pct(memory)}`;
  const cpu = avg((s) => s.system.cpuPercent / 100);
  if (cpu > h.localCpu) return `the machine is busy: CPU at ${pct(cpu)}`;
  const last = samples.at(-1) as MetricsSample;
  if (last.gpus.length) {
    const freest = Math.min(
      ...last.gpus.map((g) => (g.memoryTotalBytes ? g.memoryUsedBytes / g.memoryTotalBytes : 0)),
    );
    if (freest > h.localVram) return `the GPU is full: VRAM at ${pct(freest)}`;
  }
  return null;
}
