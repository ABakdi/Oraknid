import { z } from "zod";
import { Timestamp } from "./common.ts";

export const SystemStatus = z.object({
  version: z.string(),
  startedAt: Timestamp,
  uptimeMs: z.number().int().nonnegative(),
  pid: z.number().int().positive(),
  dataDir: z.string(),
  lastSeq: z.number().int().nonnegative(),
});
export type SystemStatus = z.infer<typeof SystemStatus>;

export const DoctorCheck = z.object({
  name: z.string(),
  ok: z.boolean(),
  /** What was found, in plain words (BR-17). */
  detail: z.string(),
  /** What to do about it, when not ok. */
  fix: z.string().nullable(),
});
export type DoctorCheck = z.infer<typeof DoctorCheck>;
