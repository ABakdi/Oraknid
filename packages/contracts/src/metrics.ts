import { z } from "zod";
import { Timestamp } from "./common.ts";

// Resource metrics (docs/01-Specification/Web-UI.md → Resources). Ephemeral:
// streamed at 1/s and kept in memory, not in the event log.

export const ProcessMetrics = z.object({
  /** What the process is to Oraknid: a Leg session id, "daemon", "verify:<task>". */
  id: z.string(),
  label: z.string(),
  pid: z.number().int().positive(),
  /** Number of processes in its tree, itself included. */
  processes: z.number().int().positive(),
  /** Percent of one core, summed over the tree (can exceed 100). */
  cpuPercent: z.number().nonnegative(),
  rssBytes: z.number().int().nonnegative(),
  readBytesPerSec: z.number().nonnegative(),
  writeBytesPerSec: z.number().nonnegative(),
  vramBytes: z.number().int().nonnegative(),
});
export type ProcessMetrics = z.infer<typeof ProcessMetrics>;

export const GpuMetrics = z.object({
  index: z.number().int().nonnegative(),
  name: z.string(),
  utilizationPercent: z.number().nonnegative(),
  memoryUsedBytes: z.number().int().nonnegative(),
  memoryTotalBytes: z.number().int().nonnegative(),
  temperatureC: z.number().nullable(),
  powerW: z.number().nullable(),
});
export type GpuMetrics = z.infer<typeof GpuMetrics>;

export const SystemMetrics = z.object({
  /** Percent of all cores together (0–100). */
  cpuPercent: z.number().nonnegative(),
  cores: z.number().int().positive(),
  memoryUsedBytes: z.number().int().nonnegative(),
  memoryTotalBytes: z.number().int().nonnegative(),
  diskReadBytesPerSec: z.number().nonnegative(),
  diskWriteBytesPerSec: z.number().nonnegative(),
  netRxBytesPerSec: z.number().nonnegative(),
  netTxBytesPerSec: z.number().nonnegative(),
});
export type SystemMetrics = z.infer<typeof SystemMetrics>;

export const MetricsSample = z.object({
  at: Timestamp,
  system: SystemMetrics,
  gpus: z.array(GpuMetrics),
  processes: z.array(ProcessMetrics),
});
export type MetricsSample = z.infer<typeof MetricsSample>;
