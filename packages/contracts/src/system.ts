import { z } from "zod";
import { Timestamp } from "./common.ts";

export const SystemStatus = z.object({
  version: z.string(),
  startedAt: Timestamp,
  uptimeMs: z.number().int().nonnegative(),
  pid: z.number().int().positive(),
  dataDir: z.string(),
  lastSeq: z.number().int().nonnegative(),
  inhibitor: z.object({
    held: z.boolean(),
    mode: z.enum(["block", "delay"]).nullable(),
    why: z.string().nullable(),
    problem: z.string().nullable(),
  }),
  secrets: z.object({
    kind: z.enum(["keychain", "encrypted-file", "none"]),
    available: z.boolean(),
    detail: z.string(),
  }),
  sandbox: z.object({ available: z.boolean(), detail: z.string() }),
  service: z.object({
    installed: z.boolean(),
    enabled: z.boolean(),
    active: z.boolean(),
    startsAtBoot: z.boolean(),
    detail: z.string(),
  }),
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
