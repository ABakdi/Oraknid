import type { Event, ServerFrame } from "@oraknid/contracts";
import WebSocket from "ws";

// The live socket for the terminal app (ADR-055): the same /live as the web
// (Realtime-Transport), from Node: topics, replay after a reconnect, a
// server's log followed. With the CLI's token, which needs no unlocking.

export type LiveStatus = "live" | "reconnecting" | "offline";

/** What the app needs of the live socket; tests give a stand-in. */
export interface LiveFeed {
  status(): LiveStatus;
  onStatus(l: () => void): () => void;
  subscribe(topics: string[]): () => void;
  on(l: (e: Event) => void): () => void;
  /** Bumped when the daemon says to read everything again. */
  epoch(): number;
  followLog(
    serverId: string,
    source: string,
    onLines: (lines: string[]) => void,
    onEnd: (error: string | null) => void,
  ): () => void;
  close(): void;
}

export class LiveSocket implements LiveFeed {
  #status: LiveStatus = "offline";
  #ws: WebSocket | null = null;
  #topics = new Map<string, number>();
  #listeners = new Set<(e: Event) => void>();
  #statusListeners = new Set<() => void>();
  #logs = new Map<
    string,
    {
      serverId: string;
      source: string;
      onLines: (l: string[]) => void;
      onEnd: (e: string | null) => void;
    }
  >();
  #nextLog = 1;
  #lastSeq = 0;
  #retry = 0;
  #epoch = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;

  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  start() {
    if (this.#ws || this.#closed) return;
    const ws = new WebSocket(
      `${this.url.replace(/^http/, "ws")}/live?token=${encodeURIComponent(this.token)}`,
    );
    this.#ws = ws;
    const send = (frame: unknown) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
    };
    ws.on("open", () => {
      this.#retry = 0;
      this.#setStatus("live");
      const topics = [...this.#topics.keys()];
      if (topics.length) send({ type: "subscribe", topics });
      for (const [id, l] of this.#logs)
        send({ type: "logs-open", id, serverId: l.serverId, source: l.source });
      if (this.#lastSeq) send({ type: "resume", lastSeq: this.#lastSeq });
    });
    ws.on("message", (data) => {
      let frame: ServerFrame;
      try {
        frame = JSON.parse(String(data)) as ServerFrame;
      } catch {
        return;
      }
      if (frame.type === "hello" && !this.#lastSeq) this.#lastSeq = frame.seq;
      else if (frame.type === "event") {
        this.#lastSeq = Math.max(this.#lastSeq, frame.event.seq);
        for (const l of this.#listeners) l(frame.event);
      } else if (frame.type === "snapshot-needed") {
        this.#lastSeq = frame.seq;
        this.#epoch++;
        this.#notify();
      } else if (frame.type === "ping") send({ type: "pong" });
      else if (frame.type === "log") this.#logs.get(frame.id)?.onLines(frame.lines);
      else if (frame.type === "log-end") {
        const l = this.#logs.get(frame.id);
        this.#logs.delete(frame.id);
        l?.onEnd(frame.error);
      }
    });
    ws.on("error", () => {});
    ws.on("close", () => {
      this.#ws = null;
      if (this.#closed) return;
      this.#setStatus(this.#retry > 5 ? "offline" : "reconnecting");
      const delay = Math.min(15_000, 500 * 2 ** this.#retry++);
      clearTimeout(this.#timer);
      this.#timer = setTimeout(() => this.start(), delay);
    });
  }

  close() {
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#ws?.close();
  }

  status() {
    return this.#status;
  }

  epoch() {
    return this.#epoch;
  }

  onStatus(l: () => void) {
    this.#statusListeners.add(l);
    return () => {
      this.#statusListeners.delete(l);
    };
  }

  #send(frame: unknown) {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(frame));
  }

  subscribe(topics: string[]) {
    const fresh = topics.filter((t) => !this.#topics.has(t));
    for (const t of topics) this.#topics.set(t, (this.#topics.get(t) ?? 0) + 1);
    if (fresh.length) this.#send({ type: "subscribe", topics: fresh });
    return () => {
      const gone: string[] = [];
      for (const t of topics) {
        const n = (this.#topics.get(t) ?? 1) - 1;
        if (n <= 0) {
          this.#topics.delete(t);
          gone.push(t);
        } else this.#topics.set(t, n);
      }
      if (gone.length) this.#send({ type: "unsubscribe", topics: gone });
    };
  }

  on(l: (e: Event) => void) {
    this.#listeners.add(l);
    return () => {
      this.#listeners.delete(l);
    };
  }

  followLog(
    serverId: string,
    source: string,
    onLines: (l: string[]) => void,
    onEnd: (e: string | null) => void,
  ) {
    const id = `log${this.#nextLog++}`;
    this.#logs.set(id, { serverId, source, onLines, onEnd });
    this.#send({ type: "logs-open", id, serverId, source });
    return () => {
      if (!this.#logs.delete(id)) return;
      this.#send({ type: "logs-close", id });
    };
  }

  #setStatus(s: LiveStatus) {
    this.#status = s;
    this.#notify();
  }

  #notify() {
    for (const l of this.#statusListeners) l();
  }
}
