import { z } from "zod";
import { Timestamp } from "./common.ts";

// Parallel by default, admitted by resources (ADR-050): what I set, and
// what the machine's health looks like to Oraknid.

/** Thresholds of the admission controller and the guard; shares are of the total (0–1). */
export const ResourceThresholds = z.object({
  /** A task starts only while this share of memory stays available after what it may need. */
  minFreeMemory: z.number().min(0.02).max(0.6),
  /** No further task starts while CPU use (all cores, the last ten seconds) is above this. */
  maxCpu: z.number().min(0.3).max(1),
  /** Danger: available memory below this share while the machine swaps or stalls. */
  dangerMemory: z.number().min(0.02).max(0.4),
  /** No task starts, and I'm warned, with less than this free on the data or a project's disk. */
  minFreeDiskBytes: z.number().int().min(0),
  /** Heavy tasks (builds, installs, test suites) running at once. */
  heavyAtOnce: z.number().int().min(1).max(8),
});
export type ResourceThresholds = z.infer<typeof ResourceThresholds>;

export const DEFAULT_THRESHOLDS_RESOURCES: ResourceThresholds = {
  minFreeMemory: 0.15,
  maxCpu: 0.85,
  dangerMemory: 0.1,
  minFreeDiskBytes: 2 * 1024 ** 3,
  heavyAtOnce: 1,
};

export const ResourceSettings = z.object({
  /** Tasks at once across every job: decided by the machine and the Legs, or my number. */
  tasksAtOnce: z.union([z.literal("auto"), z.number().int().min(1).max(32)]).default("auto"),
  /** Also hold and pause work while the machine is busy with my own things. */
  pauseForMyWork: z.boolean().default(false),
  thresholds: ResourceThresholds.partial().default({}),
});
export type ResourceSettings = z.infer<typeof ResourceSettings>;

/** Something wrong on the machine, said once per incident (ADR-050). */
export const MachineIncident = z.object({
  /** memory, swap, disk, oom, thermal, busy, or runaway:<session>. */
  kind: z.string(),
  level: z.enum(["warning", "danger"]),
  /** What is happening, in plain words. */
  message: z.string(),
  /** What Oraknid did about it, if anything. */
  did: z.string().nullable(),
  since: Timestamp,
});
export type MachineIncident = z.infer<typeof MachineIncident>;

export const MachineHealth = z.object({
  state: z.enum(["ok", "busy", "danger"]),
  incidents: z.array(MachineIncident),
  /** Tasks running now across every job, and the most that may. */
  running: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  /** Whether the limit is the machine's own ("auto") or mine. */
  limitIsAuto: z.boolean(),
  /** Tasks paused to make room, which start again when there is. */
  pausedForRoom: z.array(z.object({ jobId: z.string(), taskId: z.string(), title: z.string() })),
  /** The last reading, in plain figures, when there is one. */
  reading: z
    .object({
      memoryUsed: z.number().min(0).max(1),
      cpu: z.number().min(0).max(1),
      swapUsed: z.number().min(0).max(1).nullable(),
      memoryPressure: z.number().nullable(),
      diskFreeBytes: z.number().nullable(),
    })
    .nullable(),
});
export type MachineHealth = z.infer<typeof MachineHealth>;
