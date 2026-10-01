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
  const b = bundle();
  if (!b) {
    say(
      "This device isn't paired for away. At home, open Oraknid → Settings → Away from home, and open the link it gives on this device.",
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

  // What the UI uses, from inside its frame (apps/web → lib/remote.ts).
  (window as unknown as { __ORAKNID_REMOTE__: unknown }).__ORAKNID_REMOTE__ = {
    request: (r: { method: string; path: string; body?: string }) =>
      new Promise((resolve) => {
        const id = next++;
        pending.set(id, resolve);
        send({
          t: "req",
          id,
          method: r.method,
          path: r.path,
          headers: { authorization: `Bearer ${b.token}` },
          ...(r.body !== undefined ? { body: r.body } : {}),
        });
      }),
    openLive: (h: { onOpen(): void; onMessage(f: string): void; onClose(): void }) => {
      live = h;
      send({ t: "live-open", token: b.token });
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

/** After the UI started, a dropped tunnel is opened again under it. */
function reconnect(b: Bundle) {
  connect(b);
}

/** The UI, from the daemon, in a frame of this page so it can reach the tunnel. */
function run(html: string) {
  const frame = document.createElement("iframe");
  frame.srcdoc = html;
  frame.title = "Oraknid";
  document.body.replaceChildren(frame);
}

void main();
