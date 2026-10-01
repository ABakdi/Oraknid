import type { MetricsSample } from "@oraknid/contracts";
import type { Metrics, Watched } from "@oraknid/os";

export interface MetricsLoopOptions {
  metrics: Metrics;
  /** The process trees to measure right now: the daemon, Leg sessions, verifiers. */
  watched: () => Watched[];
  onSample: (sample: MetricsSample) => void;
  intervalMs?: number;
  /**
   * Someone watches live, or a Leg works: sample every interval. Otherwise
   * every `idleIntervalMs` (Audit 1 → P1-01: idle, the samples cost more than they tell).
   */
  busy?: () => boolean;
  idleIntervalMs?: number;
  /** Samples kept in memory: one hour at 1/s. */
  keep?: number;
}

/**
 * Samples resources once a second into a ring buffer. Metrics are
 * ephemeral: streamed live and kept for the last hour, never written to
 * the event log (Realtime-Transport).
 */
export function startMetricsLoop(options: MetricsLoopOptions) {
  const keep = options.keep ?? 3600;
  const buffer: MetricsSample[] = [];
  let running = false;
  let last = 0;

  const tick = async (force = true) => {
    if (running) return; // never overlap a slow sample
    if (
      !force &&
      !(options.busy?.() ?? true) &&
      Date.now() - last < (options.idleIntervalMs ?? 15_000)
    )
      return;
    last = Date.now();
    running = true;
    try {
      const sample = await options.metrics.sample(options.watched());
      buffer.push(sample);
      if (buffer.length > keep) buffer.splice(0, buffer.length - keep);
      options.onSample(sample);
    } catch (error) {
      console.error("metrics sample failed", error);
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(false), options.intervalMs ?? 1000);
  timer.unref();

  return {
    /** Samples taken at or after `since` (epoch ms). */
    recent: (since = 0) => buffer.filter((s) => s.at >= since),
    tick,
    stop: () => clearInterval(timer),
  };
}
