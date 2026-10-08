import type { CloudTransfer, Event, MetricsSample, ServerFrame } from "@oraknid/contracts";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { auth } from "./api";
import { lightEvent } from "./events";
import { checkFresh, watchFresh } from "./fresh";
import { unlock } from "./lock";
import { Coalescer, onPageVisible, RingBuffer } from "./pace";
import { RemoteSocket, remote } from "./remote";

export type LiveStatus = "live" | "reconnecting" | "offline";

type Listener = (e: Event) => void;

/**
 * The /live socket (Realtime-Transport): one connection, topics, replay
 * from the last seq after a reconnect, metrics as their own stream. The
 * UI never needs a refresh button.
 */
class Live {
  status: LiveStatus = "offline";
  lastSeq = 0;
  #ws: WebSocket | null = null;
  #topics = new Map<string, number>();
  #listeners = new Set<Listener>();
  #metrics = new Set<(m: MetricsSample) => void>();
  /** Uploads' and downloads' progress, on "storage" (ADR-046). */
  #transfers = new Set<(t: CloudTransfer) => void>();
  /** Server logs followed while their screen is open (ADR-043), opened again after a reconnect. */
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
  #statusListeners = new Set<() => void>();
  #retry = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  /** Bumped on "snapshot-needed": data hooks reload everything. */
  epoch = 0;
  #wasLive = false;

  start() {
    // Locked, nothing to listen to (ADR-029).
    if (this.#ws || !auth.token() || !unlock.get()) return;
    const session = unlock.get() ?? "";
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/live?token=${auth.token()}&unlock=${encodeURIComponent(session)}`;
    const t = remote();
    // Away from home, the live socket goes through the loader's tunnel.
    const ws = (t ? new RemoteSocket(t, session) : new WebSocket(url)) as WebSocket;
    this.#ws = ws;
    ws.onopen = () => {
      // Back after a drop: the daemon may have restarted on a new build (an update).
      if (this.#wasLive) void checkFresh();
      this.#wasLive = true;
      watchFresh();
      this.#retry = 0;
      this.#setStatus("live");
      const topics = [...this.#topics.keys()];
      if (topics.length) ws.send(JSON.stringify({ type: "subscribe", topics }));
      for (const [id, l] of this.#logs)
        ws.send(JSON.stringify({ type: "logs-open", id, serverId: l.serverId, source: l.source }));
      if (this.lastSeq) ws.send(JSON.stringify({ type: "resume", lastSeq: this.lastSeq }));
    };
    ws.onmessage = (m) => {
      const frame = JSON.parse(String(m.data)) as ServerFrame;
      if (frame.type === "hello" && !this.lastSeq) this.lastSeq = frame.seq;
      else if (frame.type === "event") {
        this.lastSeq = Math.max(this.lastSeq, frame.event.seq);
        for (const l of this.#listeners) l(frame.event);
      } else if (frame.type === "metrics") for (const l of this.#metrics) l(frame.sample);
      else if (frame.type === "transfer") for (const l of this.#transfers) l(frame.transfer);
      else if (frame.type === "snapshot-needed") {
        this.lastSeq = frame.seq;
        this.epoch++;
        this.#notify();
      } else if (frame.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
      else if (frame.type === "log") this.#logs.get(frame.id)?.onLines(frame.lines);
      else if (frame.type === "log-end") {
        const l = this.#logs.get(frame.id);
        this.#logs.delete(frame.id);
        l?.onEnd(frame.error);
      }
    };
    ws.onclose = () => {
      this.#ws = null;
      this.#setStatus(this.#retry > 5 ? "offline" : "reconnecting");
      const delay = Math.min(15_000, 500 * 2 ** this.#retry++);
      clearTimeout(this.#timer);
      this.#timer = setTimeout(() => this.start(), delay);
    };
  }

  stop() {
    clearTimeout(this.#timer);
    this.#ws?.close();
  }

  subscribe(topics: string[]) {
    const fresh = topics.filter((t) => !this.#topics.has(t));
    for (const t of topics) this.#topics.set(t, (this.#topics.get(t) ?? 0) + 1);
    if (fresh.length && this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify({ type: "subscribe", topics: fresh }));
    }
    return () => {
      const gone: string[] = [];
      for (const t of topics) {
        const n = (this.#topics.get(t) ?? 1) - 1;
        if (n <= 0) {
          this.#topics.delete(t);
          gone.push(t);
        } else this.#topics.set(t, n);
      }
      if (gone.length && this.#ws?.readyState === WebSocket.OPEN) {
        this.#ws.send(JSON.stringify({ type: "unsubscribe", topics: gone }));
      }
    };
  }

  on(l: Listener) {
    this.#listeners.add(l);
    return () => this.#listeners.delete(l);
  }

  /** Follows a server's log; the returned function stops it, there and on the server. */
  followLog(
    serverId: string,
    source: string,
    onLines: (l: string[]) => void,
    onEnd: (e: string | null) => void,
  ): () => void {
    const id = `log${this.#nextLog++}`;
    this.#logs.set(id, { serverId, source, onLines, onEnd });
    if (this.#ws?.readyState === WebSocket.OPEN)
      this.#ws.send(JSON.stringify({ type: "logs-open", id, serverId, source }));
    return () => {
      if (!this.#logs.delete(id)) return;
      if (this.#ws?.readyState === WebSocket.OPEN)
        this.#ws.send(JSON.stringify({ type: "logs-close", id }));
    };
  }

  /** Transfers' progress; subscribe to "storage" too for it to come. */
  onTransfer(l: (t: CloudTransfer) => void) {
    this.#transfers.add(l);
    return () => {
      this.#transfers.delete(l);
    };
  }

  onMetrics(l: (m: MetricsSample) => void) {
    this.#metrics.add(l);
    return () => this.#metrics.delete(l);
  }

  onStatus(l: () => void) {
    this.#statusListeners.add(l);
    return () => {
      this.#statusListeners.delete(l);
    };
  }

  #setStatus(s: LiveStatus) {
    this.status = s;
    this.#notify();
  }

  #notify() {
    for (const l of this.#statusListeners) l();
  }
}

export const live = new Live();

export function useLiveStatus(): LiveStatus {
  return useSyncExternalStore(
    (cb) => live.onStatus(cb),
    () => live.status,
  );
}

/** At most one reload of a piece of data in this many milliseconds (Web-UI → Performance). */
export const RELOAD_EVERY_MS = 500;

/**
 * Data that stays current: loads once, then reloads whenever a live event
 * on `topics` matches `refreshOn`, a burst of them folded into one reload
 * at most every `everyMs` (500 ms), none while the page is out of sight
 * (one when it is seen again). On reconnect gaps the server's snapshot
 * request reloads it too; `reload()` is at once.
 */
export function useLive<T>(
  load: () => Promise<T>,
  o: {
    topics: string[];
    refreshOn?: (e: Event) => boolean;
    deps?: unknown[];
    /** At most one live reload in this many milliseconds. */
    everyMs?: number;
  },
): { data: T | undefined; error: unknown; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const epoch = useSyncExternalStore(
    (cb) => live.onStatus(cb),
    () => live.epoch,
  );

  // Another job, project or filter: what was shown belongs to the old one (Audit 1 → Q1-22).
  const depsKey = JSON.stringify(o.deps ?? []);
  const [shownFor, setShownFor] = useState(depsKey);
  if (shownFor !== depsKey) {
    setShownFor(depsKey);
    setData(undefined);
    setLoading(true);
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloads on the caller's deps, a tick, or a snapshot
  useEffect(() => {
    let cancelled = false;
    load()
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setError(undefined);
      })
      .catch((e) => !cancelled && setError(e))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [tick, epoch, ...(o.deps ?? [])]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: topics identify the subscription
  useEffect(() => {
    const off = live.subscribe(o.topics);
    const reloads = new Coalescer(() => setTick((n) => n + 1), {
      everyMs: o.everyMs ?? RELOAD_EVERY_MS,
    });
    const offEvents = live.on((e) => {
      if (!o.topics.includes(e.topic)) return;
      if (o.refreshOn && !o.refreshOn(e)) return;
      reloads.request();
    });
    const offVisible = onPageVisible(() => reloads.visible());
    return () => {
      off();
      offEvents();
      offVisible();
      reloads.stop();
    };
  }, [o.topics.join(",")]);

  return { data, error, loading, reload: () => setTick((n) => n + 1) };
}

/** How often a live stream's list is drawn again, at most (Web-UI → Performance). */
export const STREAM_EVERY_MS = 500;

/**
 * The latest `limit` events of `seed` and `fresh`, newest first, each once:
 * a stream's list from what it was seeded with and what came since.
 */
export function newestEvents(seed: Event[], fresh: Event[], limit: number): Event[] {
  const bySeq = new Map<number, Event>();
  for (const e of seed) bySeq.set(e.seq, e);
  for (const e of fresh) bySeq.set(e.seq, e);
  return [...bySeq.values()].sort((a, b) => b.seq - a.seq).slice(0, limit);
}

/**
 * The latest events on some topics, newest first, kept in memory (activity
 * streams): at most `limit` of them in a ring buffer, the list drawn again
 * at most twice a second, and not while the page is out of sight.
 */
export function useEvents(topics: string[], limit = 200, seed: Event[] = []): Event[] {
  const [events, setEvents] = useState<Event[]>([]);
  const ring = useRef<RingBuffer<Event> | null>(null);
  ring.current ??= new RingBuffer<Event>(limit);
  const seeded = useRef<Event[]>([]);
  const draw = useRef<Coalescer | null>(null);
  draw.current ??= new Coalescer(
    () => setEvents(newestEvents(seeded.current, ring.current?.toArray() ?? [], limit)),
    { everyMs: STREAM_EVERY_MS, settleMs: 50 },
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: seed only matters when it arrives
  useEffect(() => {
    // The audit log holds every topic's copy of an event: keep only the ones this stream shows.
    if (!seed.length) return;
    seeded.current = seed.filter((e) => topics.includes(e.topic));
    setEvents(newestEvents(seeded.current, ring.current?.toArray() ?? [], limit));
  }, [seed.length]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: topics identify the subscription
  useEffect(() => {
    const off = live.subscribe(topics);
    const offEvents = live.on((e) => {
      if (!topics.includes(e.topic)) return;
      // One brought again (a replay) is drawn once: newestEvents keeps each seq once.
      ring.current?.push(lightEvent(e));
      draw.current?.request();
    });
    const offVisible = onPageVisible(() => draw.current?.visible());
    return () => {
      off();
      offEvents();
      offVisible();
    };
  }, [topics.join(",")]);
  useEffect(() => () => draw.current?.stop(), []);
  return events;
}

/** Resource samples kept for the charts: ten minutes at 1/s. */
export const METRICS_KEPT = 600;

/** The last ten minutes of resource samples, then live at 1/s; not drawn while out of sight. */
export function useMetrics(seed: () => Promise<MetricsSample[]>): MetricsSample[] {
  const [samples, setSamples] = useState<MetricsSample[]>([]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: loads once
  useEffect(() => {
    const ring = new RingBuffer<MetricsSample>(METRICS_KEPT);
    const draw = new Coalescer(() => setSamples(ring.toArray()), { everyMs: 1000, settleMs: 0 });
    let seeded = false;
    const done = (first: MetricsSample[]) => {
      // Live samples that came before the seed stay after it.
      const came = ring.toArray();
      const last = first.at(-1)?.at ?? 0;
      ring.clear();
      for (const x of first.slice(-METRICS_KEPT)) ring.push(x);
      for (const x of came) if (x.at > last) ring.push(x);
      seeded = true;
      setSamples(ring.toArray());
    };
    seed().then(done, () => done([]));
    const off = live.subscribe(["metrics"]);
    const offM = live.onMetrics((m) => {
      ring.push(m);
      if (seeded) draw.request();
    });
    const offVisible = onPageVisible(() => draw.visible());
    return () => {
      off();
      offM();
      offVisible();
      draw.stop();
    };
  }, []);
  return samples;
}
