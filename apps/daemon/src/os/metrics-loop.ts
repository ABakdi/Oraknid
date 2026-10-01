import type { MetricsSample } from "@oraknid/contracts";
import type { Metrics, Watched } from "@oraknid/os";

export interface MetricsLoopOptions {
  metrics: Metrics;
  /** The process trees to measure right now: the daemon, Leg sessions, verifiers. */
  watched: () => Watched[];
  onSample: (sample: MetricsSample) => void;
  intervalMs?: number;
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

  const tick = async () => {
    if (running) return; // never overlap a slow sample
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
  const timer = setInterval(() => void tick(), options.intervalMs ?? 1000);
  timer.unref();

  return {
    /** Samples taken at or after `since` (epoch ms). */
    recent: (since = 0) => buffer.filter((s) => s.at >= since),
    tick,
    stop: () => clearInterval(timer),
  };
}
