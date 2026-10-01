import type { GpuMetrics, MetricsSample, ProcessMetrics, SystemMetrics } from "@oraknid/contracts";

export type { GpuMetrics, MetricsSample, ProcessMetrics, SystemMetrics };

/** A process tree Oraknid wants measured. */
export interface Watched {
  id: string;
  label: string;
  pid: number;
}

export interface Metrics {
  /** One sample; rates are measured since the previous call. */
  sample(watched: Watched[]): Promise<MetricsSample>;
}
