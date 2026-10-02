import { DeviceEnd, type KeyPair, ready } from "@oraknid/tunnel";

// The Nest's loader (Nest-Protocol, ADR-019): it keeps this device's keys,
// opens the end-to-end tunnel to my daemon through The Nest, gets the UI
// from the daemon through it, and runs it. The Nest serves only this.

interface Bundle {
  nest: string;
  daemon: string;
  daemonPublicKey: string;
  deviceId: string;
  keys: KeyPair;
  token: string;
}

const KEY = "oraknid.away";
const text = document.getElementById("text") as HTMLElement;
const say = (s: string) => {
  text.textContent = s;
};

/** A pairing link puts the bundle in the fragment, which never reaches The Nest. */
function bundle(): Bundle | null {
  const m = /#oraknid=([A-Za-z0-9_-]+)/.exec(location.hash);
  if (m) {
    const json = atob((m[1] as string).replace(/-/g, "+").replace(/_/g, "/"));
    localStorage.setItem(KEY, json);
    history.replaceState(null, "", location.pathname);
  }
  const stored = localStorage.getItem(KEY);
  return stored ? (JSON.parse(stored) as Bundle) : null;
}

/** This loader's own fingerprint, to compare with the one shown at home. */
async function showHash() {
  const src = (document.querySelector('script[type="module"]') as HTMLScriptElement | null)?.src;
  if (!src) return;
  const body = await (await fetch(src)).arrayBuffer();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", body));
  (document.getElementById("hash") as HTMLElement).textContent = `Loader ${[...digest]
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;
}

async function main() {
  void showHash();
  // For notifications while I'm away (M4.3); it caches nothing.
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  const b = bundle();
  if (!b) {
    say(
      "This device isn't paired for away. At home, open Oraknid → Settings → Devices & phone, and scan the code it shows with this device.",
    );
    return;
  }
  await ready();
  connect(b);
}

function connect(b: Bundle) {
  const ws = new WebSocket(
    `${location.origin.replace(/^http/, "ws")}/device?daemon=${encodeURIComponent(b.daemon)}`,
  );
  const end = new DeviceEnd({
    deviceId: b.deviceId,
    keys: b.keys,
    daemonPublicKey: b.daemonPublicKey,
  });
  const pending = new Map<
    number,
    (r: { status: number; headers: Record<string, string>; body: string }) => void
  >();
  let next = 1;
  let live: { onOpen(): void; onMessage(f: string): void; onClose(): void } | null = null;
  const ui: string[] = [];
  let started = false;

  // Messages from the UI while the tunnel (re)opens wait for it.
  const queued: unknown[] = [];
  const send = (m: unknown) => {
    if (end.ready && ws.readyState === WebSocket.OPEN) ws.send(end.seal(m));
    else queued.push(m);
  };
  ws.onopen = () => ws.send(end.hello());
  ws.onmessage = (event) => {
    let r: ReturnType<DeviceEnd["receive"]>;
    try {
      r = end.receive(String(event.data));
    } catch (error) {
      say(error instanceof Error ? error.message : String(error));
      ws.close();
      return;
    }
    for (const f of r.replies) ws.send(f);
    if (end.ready) for (const m of queued.splice(0)) ws.send(end.seal(m));
    if (end.ready && !started && ui.length === 0) send({ t: "ui" });
    for (const m of r.messages as Record<string, unknown>[]) {
      if (m.t === "res") {
        pending.get(m.id as number)?.(m as never);
        pending.delete(m.id as number);
      } else if (m.t === "live") live?.onMessage(String(m.frame));
      else if (m.t === "live-close") {
        const l = live;
        live = null;
        l?.onClose();
      } else if (m.t === "ui" && !started) {
        if (m.missing) {
          say("Your daemon has no remote UI built. Rebuild Oraknid at home.");
          return;
        }
        ui[m.part as number] = String(m.chunk);
        if (ui.filter((x) => x !== undefined).length === (m.of as number)) {
          started = true;
          run(ui.join(""));
        }
      }
    }
  };
  ws.onclose = () => {
    for (const resolve of pending.values())
      resolve({ status: 503, headers: {}, body: '{"message":"Reconnecting to your daemon…"}' });
    pending.clear();
    live?.onClose();
    live = null;
    if (!started) say("Your daemon isn't reachable right now. Retrying…");
    setTimeout(() => {
      if (!started) connect(b);
      else reconnect(b);
    }, 3000);
  };

  // What the UI uses, through its port (apps/web → lib/remote.ts). It never
  // sees this page's storage, the device's keys or its token (Audit 2).
  let unlock = "";
  transport = {
    request: (r: {
      method: string;
      path: string;
      body?: string;
      headers?: Record<string, string>;
    }) =>
      new Promise((resolve) => {
        const id = next++;
        pending.set(id, resolve);
        // Only the unlocked session travels from the UI; the token is added here.
        const session = r.headers?.["x-oraknid-unlock"];
        if (typeof session === "string") unlock = session;
        send({
          t: "req",
          id,
          method: r.method,
          path: r.path,
          headers: {
            authorization: `Bearer ${b.token}`,
            ...(unlock ? { "x-oraknid-unlock": unlock } : {}),
          },
          ...(r.body !== undefined ? { body: r.body } : {}),
        });
      }),
    /** Push to this device: the subscription is this page's (the UI's frame can't hold one). */
    subscribePush: async () => {
      if (!("serviceWorker" in navigator) || !("PushManager" in window))
        throw new Error("This browser can't receive push notifications.");
      if ((await Notification.requestPermission()) !== "granted")
        throw new Error("Notifications are blocked for this site in the browser.");
      const call = (path: string, json: unknown) =>
        new Promise<{ status: number; body: string }>((resolve) => {
          const id = next++;
          pending.set(id, resolve as never);
          send({
            t: "req",
            id,
            method: "POST",
            path,
            headers: {
              authorization: `Bearer ${b.token}`,
              ...(unlock ? { "x-oraknid-unlock": unlock } : {}),
            },
            body: JSON.stringify({ json }),
          });
        });
      const key = JSON.parse((await call("/api/notifications/vapidPublicKey", null)).body)
        .json as string;
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: fromBase64Url(key),
      });
      const j = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
      const r = await call("/api/notifications/subscribe", { endpoint: j.endpoint, keys: j.keys });
      if (r.status >= 400) throw new Error("Oraknid didn't take the subscription.");
    },
    openLive: (
      h: { onOpen(): void; onMessage(f: string): void; onClose(): void },
      session?: string,
    ) => {
      live = h;
      if (session) unlock = session;
      send({ t: "live-open", token: b.token, unlock });
      setTimeout(() => h.onOpen(), 0);
      return {
        send: (frame: string) => send({ t: "live", frame }),
        close: () => {
          live = null;
          send({ t: "live-close" });
        },
      };
    },
  };
}

function fromBase64Url(s: string): Uint8Array<ArrayBuffer> {
  const b = atob(
    s
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(s.length / 4) * 4, "="),
  );
  const out = new Uint8Array(new ArrayBuffer(b.length));
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

/** After the UI started, a dropped tunnel is opened again under it. */
function reconnect(b: Bundle) {
  connect(b);
}

interface Transport {
  request(r: unknown): Promise<unknown>;
  subscribePush(): Promise<void>;
  openLive(
    h: { onOpen(): void; onMessage(f: string): void; onClose(): void },
    session?: string,
  ): { send(frame: string): void; close(): void };
}
/** The tunnel's current transport; a reconnect replaces it under the running UI. */
let transport: Transport | null = null;

/**
 * The UI, from the daemon, in a sandboxed frame (Audit 2): an opaque
 * origin, so nothing in it can read this page's storage; it reaches the
 * tunnel only through a message port this page hands it.
 */
function run(html: string) {
  const frame = document.createElement("iframe");
  frame.sandbox.add(
    "allow-scripts",
    "allow-forms",
    "allow-popups",
    "allow-modals",
    "allow-downloads",
  );
  frame.name = "oraknid-remote";
  frame.srcdoc = html;
  frame.title = "Oraknid";
  frame.addEventListener("load", () => {
    const channel = new MessageChannel();
    let liveConn: { send(frame: string): void; close(): void } | null = null;
    const port = channel.port1;
    port.onmessage = async (e) => {
      const m = e.data as {
        id?: number;
        op: string;
        r?: unknown;
        session?: string;
        frame?: string;
      };
      if (m.op === "error") {
        console.error("Oraknid UI:", (m as { what?: string }).what);
        return;
      }
      if (!transport) return;
      if (m.op === "request") port.postMessage({ id: m.id, ok: await transport.request(m.r) });
      else if (m.op === "subscribePush")
        transport.subscribePush().then(
          () => port.postMessage({ id: m.id, ok: true }),
          (err: unknown) =>
            port.postMessage({ id: m.id, error: String(err instanceof Error ? err.message : err) }),
        );
      else if (m.op === "live-open") {
        liveConn?.close();
        liveConn = transport.openLive(
          {
            onOpen: () => port.postMessage({ op: "live-open" }),
            onMessage: (f) => port.postMessage({ op: "live", frame: f }),
            onClose: () => port.postMessage({ op: "live-close" }),
          },
          m.session,
        );
      } else if (m.op === "live-send" && typeof m.frame === "string") liveConn?.send(m.frame);
      else if (m.op === "live-close") {
        liveConn?.close();
        liveConn = null;
      }
    };
    frame.contentWindow?.postMessage("oraknid-remote", "*", [channel.port2]);
  });
  document.body.replaceChildren(frame);
}

void main();
