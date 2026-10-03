import { z } from "zod";
import { CloudTransfer } from "./cloud.ts";
import { Event } from "./events.ts";
import { MetricsSample } from "./metrics.ts";
import { LogSource } from "./server-insight.ts";

// WebSocket frames on /live (docs/02-Architecture/Realtime-Transport.md).

export const Topic = z
  .string()
  .regex(/^(overview|inbox|metrics|mail|storage|(job|leg|chat):[0-9A-HJKMNP-TV-Z]{26})$/);
export type Topic = z.infer<typeof Topic>;

export const ClientFrame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("subscribe"), topics: z.array(Topic).min(1) }),
  z.object({ type: z.literal("unsubscribe"), topics: z.array(Topic).min(1) }),
  z.object({ type: z.literal("resume"), lastSeq: z.number().int().nonnegative() }),
  z.object({ type: z.literal("pong") }),
  /** A server's log, followed while its screen is open (ADR-043); `id` is the client's. */
  z.object({
    type: z.literal("logs-open"),
    id: z.string().min(1).max(40),
    serverId: z.string(),
    source: LogSource,
  }),
  z.object({ type: z.literal("logs-close"), id: z.string().min(1).max(40) }),
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
  /** A followed log's new lines, and its end (ADR-043); never stored. */
  z.object({ type: z.literal("log"), id: z.string(), lines: z.array(z.string()) }),
  z.object({ type: z.literal("log-end"), id: z.string(), error: z.string().nullable() }),
  /** An upload's or a download's progress, to clients subscribed to "storage" (ADR-046); never stored. */
  z.object({ type: z.literal("transfer"), transfer: CloudTransfer }),
]);
export type ServerFrame = z.infer<typeof ServerFrame>;

/** More missed events than this and the client gets "snapshot-needed". */
export const MAX_REPLAY = 5000;
