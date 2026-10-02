import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DaemonEnd, type KeyPair, newKeyPair, ready } from "@oraknid/tunnel";
import WebSocket from "ws";
import { z } from "zod";
import type { Devices } from "../auth/devices.ts";
import type { Db } from "../db/open.ts";
import type { EventBus } from "../events/bus.ts";
import { newId } from "../ids.ts";
import type { Secrets } from "../os/secrets.ts";
import { readSetting, writeSetting } from "../settings.ts";

// The daemon's link to The Nest (Nest-Protocol): one outbound socket that
// carries every device's end-to-end tunnel. Requests coming through it go
// to this daemon's own API with the device's own token, so every local
// rule applies; The Nest reads none of it.

const CONFIG = "nest.config";
const SECRET = "nest-secret";
const NestConfig = z.object({ url: z.url(), daemonId: z.string().min(1) });
type NestConfig = z.infer<typeof NestConfig>;

/** The UI goes in pieces small enough for any frame limit. */
const UI_CHUNK = 512 * 1024;

type Message =
  | {
      t: "req";
      id: number;
      method: string;
      path: string;
      headers?: Record<string, string>;
      body?: string;
    }
  | { t: "live-open"; token: string; unlock?: string }
  | { t: "live"; frame: string }
  | { t: "live-close" }
  | { t: "ui" };

export interface NestStatus {
  configured: boolean;
  url: string | null;
  daemonId: string | null;
  connected: boolean;
  publicKey: string | null;
  error: string | null;
  /** The fingerprint of the loader built with this Oraknid, to compare with The Nest's page. */
  loaderHash: string | null;
}

export class NestLink {
  #ws: WebSocket | null = null;
  #connected = false;
  #error: string | null = null;
  #retry = 0;
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;
  #keys: KeyPair | null = null;

  constructor(
    private readonly o: {
      db: Db;
      bus: EventBus;
      secrets: Secrets;
      devices: Devices;
      dataDir: string;
      /** The daemon's own address for tunnelled requests. */
      localUrl: () => string;
      /** The remote UI, one self-contained page, when it was built. */
      remoteUi: () => string | null;
      /** The loader's script as built here, when it was. */
      loaderScript?: () => Buffer | null;
    },
  ) {}

  /** The daemon's long-term key pair, made once and kept in its data folder (0600). */
  async keys(): Promise<KeyPair> {
    if (this.#keys) return this.#keys;
    await ready();
    const file = join(this.o.dataDir, "nest-key.json");
    if (existsSync(file)) this.#keys = JSON.parse(readFileSync(file, "utf8")) as KeyPair;
    else {
      this.#keys = await newKeyPair();
      writeFileSync(file, `${JSON.stringify(this.#keys)}\n`, { mode: 0o600 });
      chmodSync(file, 0o600);
    }
    return this.#keys;
  }

  #config(): NestConfig | null {
    return readSetting(this.o.db, CONFIG, NestConfig.nullable(), null);
  }

  async status(): Promise<NestStatus> {
    const c = this.#config();
    return {
      configured: c !== null,
      url: c?.url ?? null,
      daemonId: c?.daemonId ?? null,
      connected: this.#connected,
      publicKey: c ? (await this.keys()).publicKey : null,
      error: this.#error,
      loaderHash: (() => {
        const script = this.o.loaderScript?.();
        return script ? createHash("sha256").update(script).digest("hex").slice(0, 32) : null;
      })(),
    };
  }

  /** Where my Nest is, and the secret it knows this daemon by. */
  async configure(url: string, secret: string, daemonId?: string) {
    const cleaned = url.replace(/\/+$/, "");
    const config = {
      url: cleaned,
      daemonId: daemonId ?? this.#config()?.daemonId ?? `home-${newId().slice(-8).toLowerCase()}`,
    };
    writeSetting(this.o.db, CONFIG, NestConfig.nullable(), config);
    await this.o.secrets.set(SECRET, secret);
    this.#publish("nest.configured", { url: cleaned, daemonId: config.daemonId });
    this.#close();
    this.#stopped = false;
    await this.connect();
  }

  /**
   * On a public Nest (ADR-031): it gives this daemon an id and a secret,
   * which are kept as configure() keeps them.
   */
  async register(url: string, invite?: string): Promise<{ daemonId: string }> {
    const cleaned = url.replace(/\/+$/, "");
    let res: Response;
    try {
      res = await fetch(`${cleaned}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(invite ? { invite } : {}),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new Error(`Couldn't reach a Nest at ${cleaned}.`);
    }
    const body = (await res.json().catch(() => null)) as { message?: unknown } | null;
    if (res.status === 404) throw new Error("That Nest is private: it takes no registrations.");
    if (!res.ok)
      throw new Error(
        typeof body?.message === "string" ? body.message : `The Nest answered ${res.status}.`,
      );
    const given = z.object({ id: z.string().min(1), secret: z.string().min(32) }).safeParse(body);
    if (!given.success) throw new Error("The Nest's answer wasn't a registration.");
    await this.configure(cleaned, given.data.secret, given.data.id);
    return { daemonId: given.data.id };
  }

  /**
   * A device for away from home, paired here: its keys and token are made
   * now and go to it in a link I open on it (never through The Nest).
   */
  async pairAway(name: string): Promise<{ link: string; deviceId: string }> {
    const c = this.#config();
    if (!c) throw new Error("Set up The Nest first: its address and this daemon's secret.");
    await ready();
    const deviceKeys = await newKeyPair();
    const { deviceId, token } = this.o.devices.create(name, deviceKeys.publicKey);
    const bundle = {
      nest: c.url,
      daemon: c.daemonId,
      daemonPublicKey: (await this.keys()).publicKey,
      deviceId,
      keys: deviceKeys,
      token,
    };
    // In the fragment: a browser never sends it to The Nest.
    return {
      deviceId,
      link: `${c.url}/#oraknid=${Buffer.from(JSON.stringify(bundle)).toString("base64url")}`,
    };
  }

  async connect() {
    const c = this.#config();
    if (!c || this.#stopped) return;
    const secret = await this.o.secrets.get(SECRET);
    if (!secret) {
      this.#error = "The daemon's Nest secret is missing from the secret store.";
      return;
    }
    const keys = await this.keys();
    const url = `${c.url.replace(/^http/, "ws")}/daemon?id=${encodeURIComponent(c.daemonId)}`;
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${secret}` } });
    this.#ws = ws;
    const tunnels = new Map<number, Tunnel>();
    // A revoked device's tunnels end now, not at its next request (Audit 2).
    const offRevoked = this.o.bus.subscribe((e) => {
      if (e.type !== "device.revoked") return;
      for (const [id, t] of tunnels)
        if (t.deviceId === (e.payload as { id?: string }).id) {
          t.close();
          tunnels.delete(id);
          ws.send(JSON.stringify({ c: id, close: true }));
        }
    });
    ws.on("open", () => {
      this.#connected = true;
      this.#error = null;
      this.#retry = 0;
      this.#publish("nest.connected", { url: c.url });
    });
    ws.on("unexpected-response", (_req, res) => {
      this.#error =
        res.statusCode === 401
          ? "The Nest refused this daemon's secret."
          : `The Nest answered ${res.statusCode}.`;
    });
    ws.on("error", (e) => {
      this.#error ??= e.message;
    });
    ws.on("message", (data) => {
      let m: { c: number; open?: boolean; close?: boolean; f?: string };
      try {
        m = JSON.parse(String(data));
      } catch {
        return;
      }
      if (m.open) {
        tunnels.set(
          m.c,
          new Tunnel(
            this,
            keys,
            (f) => ws.send(JSON.stringify({ c: m.c, f })),
            () => ws.send(JSON.stringify({ c: m.c, close: true })),
          ),
        );
        return;
      }
      if (m.close) {
        tunnels.get(m.c)?.close();
        tunnels.delete(m.c);
        return;
      }
      if (typeof m.f === "string") void tunnels.get(m.c)?.receive(m.f);
    });
    ws.on("close", () => {
      offRevoked();
      for (const t of tunnels.values()) t.close();
      tunnels.clear();
      if (this.#connected) this.#publish("nest.disconnected", { url: c.url });
      this.#connected = false;
      if (this.#ws !== ws || this.#stopped) return;
      // Back again with a growing pause, up to a minute.
      const delay = Math.min(60_000, 1000 * 2 ** this.#retry++);
      this.#timer = setTimeout(() => void this.connect(), delay);
      this.#timer.unref();
    });
  }

  #close() {
    clearTimeout(this.#timer);
    const ws = this.#ws;
    this.#ws = null;
    ws?.close();
  }

  stop() {
    this.#stopped = true;
    this.#close();
  }

  /** Used by the tunnels. */
  get deps() {
    return this.o;
  }

  #publish(type: string, payload: Record<string, unknown>) {
    this.o.bus.publish({ type, topic: "overview", jobId: null, payload });
  }
}

/** One device's tunnel: its handshake, then its requests and live socket. */
class Tunnel {
  readonly #end: DaemonEnd;
  #live: WebSocket | null = null;

  constructor(
    private readonly link: NestLink,
    keys: KeyPair,
    private readonly send: (frame: string) => void,
    private readonly hangUp: () => void,
  ) {
    this.#end = new DaemonEnd({
      keys,
      devicePublicKey: (id) => link.deps.devices.publicKeyOf(id),
    });
  }

  /** The device at the other end, once its hello was checked. */
  get deviceId(): string | null {
    return this.#end.deviceId;
  }

  async receive(frame: string) {
    let r: ReturnType<DaemonEnd["receive"]>;
    try {
      r = this.#end.receive(frame);
    } catch {
      // A frame that fails its check ends the tunnel (ADR-017).
      this.close();
      this.hangUp();
      return;
    }
    for (const f of r.replies) this.send(f);
    for (const m of r.messages) await this.#handle(m as Message);
  }

  #reply(m: unknown) {
    this.send(this.#end.seal(m));
  }

  /** The token must be this tunnel's own device's: a stolen token can't ride another device's keys. */
  #owns(token: string) {
    return token && this.link.deps.devices.identify(token) === this.#end.deviceId;
  }

  async #handle(m: Message) {
    const local = this.link.deps.localUrl();
    if (m.t === "req") {
      const token = String(m.headers?.authorization ?? "").replace(/^Bearer /, "");
      const unlock = String(m.headers?.["x-oraknid-unlock"] ?? "");
      if (!m.path.startsWith("/api/") || !this.#owns(token)) {
        this.#reply({
          t: "res",
          id: m.id,
          status: 401,
          headers: {},
          body: '{"message":"Not this device."}',
        });
        return;
      }
      try {
        const res = await fetch(`${local}${m.path}`, {
          method: m.method,
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
            // Set here, never taken from the device: the API knows this came from away (ADR-029).
            "x-oraknid-remote": "1",
            ...(unlock ? { "x-oraknid-unlock": unlock } : {}),
          },
          ...(m.body !== undefined && m.method !== "GET" ? { body: m.body } : {}),
        });
        this.#reply({
          t: "res",
          id: m.id,
          status: res.status,
          headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
          body: await res.text(),
        });
      } catch {
        this.#reply({
          t: "res",
          id: m.id,
          status: 502,
          headers: {},
          body: JSON.stringify({ message: "Oraknid didn't answer; try again." }),
        });
      }
      return;
    }
    if (m.t === "live-open") {
      if (!this.#owns(m.token)) return this.#reply({ t: "live-close" });
      this.#live?.close();
      const unlock = typeof m.unlock === "string" ? `&unlock=${encodeURIComponent(m.unlock)}` : "";
      const ws = new WebSocket(
        `${local.replace(/^http/, "ws")}/live?token=${encodeURIComponent(m.token)}${unlock}`,
      );
      this.#live = ws;
      ws.on("message", (data) => this.#reply({ t: "live", frame: String(data) }));
      ws.on("close", () => {
        if (this.#live === ws) this.#reply({ t: "live-close" });
      });
      return;
    }
    if (m.t === "live") {
      if (this.#live?.readyState === WebSocket.OPEN) this.#live.send(m.frame);
      return;
    }
    if (m.t === "live-close") {
      this.#live?.close();
      this.#live = null;
      return;
    }
    if (m.t === "ui") {
      const html = this.link.deps.remoteUi();
      if (!html) return this.#reply({ t: "ui", part: 0, of: 1, chunk: "", missing: true });
      const of = Math.max(1, Math.ceil(html.length / UI_CHUNK));
      for (let part = 0; part < of; part++)
        this.#reply({
          t: "ui",
          part,
          of,
          chunk: html.slice(part * UI_CHUNK, (part + 1) * UI_CHUNK),
        });
    }
  }

  close() {
    const live = this.#live;
    this.#live = null;
    live?.close();
  }
}
