import { z } from "zod";
import { Event } from "./events.ts";
import { MetricsSample } from "./metrics.ts";

// WebSocket frames on /live (docs/02-Architecture/Realtime-Transport.md).

export const Topic = z
  .string()
  .regex(/^(overview|inbox|metrics|(job|leg):[0-9A-HJKMNP-TV-Z]{26})$/);
export type Topic = z.infer<typeof Topic>;

export const ClientFrame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("subscribe"), topics: z.array(Topic).min(1) }),
  z.object({ type: z.literal("unsubscribe"), topics: z.array(Topic).min(1) }),
  z.object({ type: z.literal("resume"), lastSeq: z.number().int().nonnegative() }),
  z.object({ type: z.literal("pong") }),
]);
export type ClientFrame = z.infer<typeof ClientFrame>;

export const ServerFrame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), version: z.string(), seq: z.number().int().nonnegative() }),
  z.object({ type: z.literal("event"), event: Event }),
  /** Ephemeral, to clients subscribed to "metrics"; not in the event log. */
  z.object({ type: z.literal("metrics"), sample: MetricsSample }),
  /** Sent instead of a replay when too many events were missed. */
  z.object({ type: z.literal("snapshot-needed"), seq: z.number().int().nonnegative() }),
  z.object({ type: z.literal("ping") }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type ServerFrame = z.infer<typeof ServerFrame>;

/** More missed events than this and the client gets "snapshot-needed". */
export const MAX_REPLAY = 5000;
