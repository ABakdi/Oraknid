import type { Event, MetricsSample, ServerFrame } from "@oraknid/contracts";
import { useEffect, useState, useSyncExternalStore } from "react";
import { auth } from "./api";
import { unlock } from "./lock";
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
  #statusListeners = new Set<() => void>();
  #retry = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  /** Bumped on "snapshot-needed": data hooks reload everything. */
  epoch = 0;

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
      this.#retry = 0;
      this.#setStatus("live");
      const topics = [...this.#topics.keys()];
      if (topics.length) ws.send(JSON.stringify({ type: "subscribe", topics }));
      if (this.lastSeq) ws.send(JSON.stringify({ type: "resume", lastSeq: this.lastSeq }));
    };
    ws.onmessage = (m) => {
      const frame = JSON.parse(String(m.data)) as ServerFrame;
      if (frame.type === "hello" && !this.lastSeq) this.lastSeq = frame.seq;
      else if (frame.type === "event") {
        this.lastSeq = Math.max(this.lastSeq, frame.event.seq);
        for (const l of this.#listeners) l(frame.event);
      } else if (frame.type === "metrics") for (const l of this.#metrics) l(frame.sample);
      else if (frame.type === "snapshot-needed") {
        this.lastSeq = frame.seq;
        this.epoch++;
        this.#notify();
      } else if (frame.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
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

/**
 * Data that stays current: loads once, then reloads (debounced) whenever
 * a live event on `topics` matches `refreshOn`. On reconnect gaps the
 * server's snapshot request reloads it too.
 */
export function useLive<T>(
  load: () => Promise<T>,
  o: { topics: string[]; refreshOn?: (e: Event) => boolean; deps?: unknown[] },
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
    let t: ReturnType<typeof setTimeout> | undefined;
    const offEvents = live.on((e) => {
      if (!o.topics.includes(e.topic)) return;
      if (o.refreshOn && !o.refreshOn(e)) return;
      clearTimeout(t);
      t = setTimeout(() => setTick((n) => n + 1), 150);
    });
    return () => {
      off();
      offEvents();
      clearTimeout(t);
    };
  }, [o.topics.join(",")]);

  return { data, error, loading, reload: () => setTick((n) => n + 1) };
}

/** The latest events on some topics, newest first, kept in memory (activity streams). */
export function useEvents(topics: string[], limit = 200, seed: Event[] = []): Event[] {
  const [events, setEvents] = useState<Event[]>(seed);
  // biome-ignore lint/correctness/useExhaustiveDependencies: seed only matters when it arrives
  useEffect(() => {
    // The audit log holds every topic's copy of an event: keep only the ones this stream shows.
    if (seed.length) setEvents(seed.filter((e) => topics.includes(e.topic)));
  }, [seed.length]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: topics identify the subscription
  useEffect(() => {
    const off = live.subscribe(topics);
    const offEvents = live.on((e) => {
      if (topics.includes(e.topic))
        setEvents((xs) => [e, ...xs.filter((x) => x.seq !== e.seq)].slice(0, limit));
    });
    return () => {
      off();
      offEvents();
    };
  }, [topics.join(",")]);
  return events;
}

/** The last hour of resource samples, then live at 1/s. */
export function useMetrics(seed: () => Promise<MetricsSample[]>): MetricsSample[] {
  const [samples, setSamples] = useState<MetricsSample[]>([]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: loads once
  useEffect(() => {
    seed().then(
      (s) => setSamples(s.slice(-600)),
      () => {},
    );
    const off = live.subscribe(["metrics"]);
    const offM = live.onMetrics((m) => setSamples((xs) => [...xs.slice(-599), m]));
    return () => {
      off();
      offM();
    };
  }, []);
  return samples;
}
