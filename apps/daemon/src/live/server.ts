import type { IncomingMessage, Server } from "node:http";
import {
  ClientFrame,
  type Event,
  MAX_REPLAY,
  type MetricsSample,
  type ServerFrame,
  type Topic,
} from "@oraknid/contracts";
import { type WebSocket, WebSocketServer } from "ws";
import type { EventBus } from "../events/bus.ts";
import { VERSION } from "../version.ts";

export interface LiveOptions {
  server: Server;
  bus: EventBus;
  /** Decides whether an upgrade request may connect. */
  allow: (req: IncomingMessage) => boolean;
  heartbeatMs?: number;
}

/**
 * The /live WebSocket (ADR-004): sequenced events per topic, with replay
 * from `lastSeq` after a reconnect.
 */
/** Events after which every socket is checked again. */
export const LOCKING = new Set([
  "lock.locked",
  "lock.pin-set",
  "lock.pin-reset",
  "device.revoked",
  "device.rights",
]);

const RELAYED = new Set([
  "job.state",
  "task.state",
  "session.started",
  "session.ended",
  "web.updated",
  "job.merged",
]);

export function attachLive({ server, bus, allow, heartbeatMs = 15_000 }: LiveOptions) {
  const wss = new WebSocketServer({ noServer: true });
  /** Clients subscribed to "metrics", for the ephemeral metrics stream. */
  const metricsClients = new Set<WebSocket>();

  server.on("upgrade", (req, socket, head) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    // The terminal's socket is its own (ADR-028).
    if (path === "/term") return;
    if (path !== "/live" || !allow(req)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  // A socket lives only while its device is paired and unlocked (ADR-029):
  // checked again at every heartbeat, and at once when anything locks.
  const open = new Map<WebSocket, IncomingMessage>();
  const recheck = () => {
    for (const [ws, req] of open) if (!allow(req)) ws.close(4401, "locked");
  };
  const offLock = bus.subscribe((e) => {
    if (LOCKING.has(e.type)) recheck();
  });
  server.on("close", offLock);

  wss.on("connection", (ws, req: IncomingMessage) => {
    open.set(ws, req);
    const topics = new Set<Topic>();
    // Seqs sent and not yet acknowledged by a resume: nothing is sent twice.
    const sent = new SentSeqs();
    let alive = true;

    const send = (frame: ServerFrame) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
    };
    // A job's state, its tasks' and its sessions' starts and ends also tell "overview" that
    // something changed, at most 4/s (Realtime-Transport; Audit 1 → Q1-05). A hint to reload:
    // not stored, not replayed.
    let relayTimer: ReturnType<typeof setTimeout> | undefined;
    let relayLatest: Event | undefined;
    const relay = (event: Event) => {
      relayLatest = { ...event, topic: "overview" };
      relayTimer ??= setTimeout(() => {
        relayTimer = undefined;
        if (relayLatest) send({ type: "event", event: relayLatest });
        relayLatest = undefined;
      }, 250);
    };
    const deliver = (event: Event) => {
      if (topics.has("overview") && event.topic.startsWith("job:") && RELAYED.has(event.type))
        relay(event);
      if (!topics.has(event.topic as Topic) || sent.has(event.seq)) return;
      sent.add(event.seq);
      send({ type: "event", event });
    };

    const off = bus.subscribe(deliver);
    send({ type: "hello", version: VERSION, seq: bus.lastSeq() });

    ws.on("message", (data) => {
      const parsed = ClientFrame.safeParse(safeJson(data.toString()));
      if (!parsed.success) {
        send({ type: "error", message: "That frame is not one Oraknid understands." });
        return;
      }
      const frame = parsed.data;
      switch (frame.type) {
        case "subscribe":
          for (const t of frame.topics) topics.add(t);
          if (topics.has("metrics")) metricsClients.add(ws);
          break;
        case "unsubscribe":
          for (const t of frame.topics) topics.delete(t);
          if (!topics.has("metrics")) metricsClients.delete(ws);
          break;
        case "resume":
          replay(frame.lastSeq);
          break;
        case "pong":
          alive = true;
          break;
      }
    });

    function replay(lastSeq: number) {
      // The client says it has everything up to lastSeq.
      sent.acknowledge(lastSeq);
      const wanted = [...topics];
      if (bus.countSince(lastSeq, wanted) > MAX_REPLAY) {
        send({ type: "snapshot-needed", seq: bus.lastSeq() });
        return;
      }
      for (const event of bus.since(lastSeq, wanted, MAX_REPLAY)) deliver(event);
    }

    const heartbeat = setInterval(() => {
      if (!allow(req)) {
        ws.close(4401, "locked");
        return;
      }
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      send({ type: "ping" });
    }, heartbeatMs);

    ws.on("close", () => {
      open.delete(ws);
      clearTimeout(relayTimer);
      clearInterval(heartbeat);
      metricsClients.delete(ws);
      off();
    });
  });

  return {
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => resolve());
      }),
    clientCount: () => wss.clients.size,
    /** How many clients watch metrics live now. */
    metricsWatchers: () => metricsClients.size,
    /** Metrics are not events: sent to "metrics" subscribers, never stored. */
    broadcastMetrics(sample: MetricsSample) {
      if (metricsClients.size === 0) return;
      const data = JSON.stringify({ type: "metrics", sample } satisfies ServerFrame);
      for (const ws of metricsClients) if (ws.readyState === ws.OPEN) ws.send(data);
    },
    wss: wss as WebSocketServer & { clients: Set<WebSocket> },
  };
}

/** The seqs sent to one client, pruned on acknowledgement and capped. */
class SentSeqs {
  static readonly CAP = 10_000;
  readonly #seqs = new Set<number>();
  #floor = 0;

  has(seq: number) {
    return seq <= this.#floor ? false : this.#seqs.has(seq);
  }

  add(seq: number) {
    this.#seqs.add(seq);
    if (this.#seqs.size > SentSeqs.CAP) {
      // Sets iterate in insertion order: drop the oldest.
      const oldest = this.#seqs.values().next().value;
      if (oldest !== undefined) this.#seqs.delete(oldest);
    }
  }

  acknowledge(upTo: number) {
    this.#floor = Math.max(this.#floor, upTo);
    for (const seq of this.#seqs) if (seq <= upTo) this.#seqs.delete(seq);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
