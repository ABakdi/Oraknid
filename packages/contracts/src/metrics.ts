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
  /** Defunct processes in its tree, waiting to be reaped (a zombie storm, ADR-050). */
  zombies: z.number().int().nonnegative().optional(),
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
  // What the machine's safety needs besides (ADR-050); absent where /proc can't tell.
  swapTotalBytes: z.number().int().nonnegative().optional(),
  swapUsedBytes: z.number().int().nonnegative().optional(),
  /** Pages read back from swap, as bytes a second: thrashing when it stays high. */
  swapInBytesPerSec: z.number().nonnegative().optional(),
  /** The one-minute load average. */
  load1: z.number().nonnegative().optional(),
  /** Pressure stall information, avg10 in percent (/proc/pressure), null without PSI. */
  pressure: z
    .object({
      cpu: z.number().nonnegative(),
      memory: z.number().nonnegative(),
      memoryFull: z.number().nonnegative(),
      io: z.number().nonnegative(),
    })
    .nullable()
    .optional(),
  /** Processes the kernel's OOM killer ended since boot (/proc/vmstat oom_kill). */
  oomKills: z.number().int().nonnegative().nullable().optional(),
  /** Times the CPU was throttled for heat since boot, when the kernel tells. */
  thermalThrottles: z.number().int().nonnegative().nullable().optional(),
});
export type SystemMetrics = z.infer<typeof SystemMetrics>;

export const MetricsSample = z.object({
  at: Timestamp,
  system: SystemMetrics,
  gpus: z.array(GpuMetrics),
  processes: z.array(ProcessMetrics),
});
export type MetricsSample = z.infer<typeof MetricsSample>;
