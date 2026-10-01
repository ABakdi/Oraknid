import { z } from "zod";
import { Id, Timestamp } from "./common.ts";

/**
 * One entry of the append-only event stream. `seq` increases by one per
 * event and is what clients resume from (ADR-004).
 */
export const Event = z.object({
  seq: z.number().int().positive(),
  at: Timestamp,
  /** Dotted name, e.g. "job.state", "leg.health", "system.started". */
  type: z.string().min(1),
  /** The live topic it belongs to, e.g. "overview", "job:<id>". */
  topic: z.string().min(1),
  jobId: Id.nullable(),
  payload: z.unknown(),
  /** Who or what caused it (Security → Audit log): "owner", "eye", "leg:<id>", "oraknid". */
  actor: z.string(),
});
export type Event = z.infer<typeof Event>;

export const NewEvent = Event.omit({ seq: true, at: true, actor: true }).extend({
  actor: z.string().optional(),
});
export type NewEvent = z.infer<typeof NewEvent>;
