// Away from home (Nest-Protocol): the UI runs inside The Nest's loader,
// which holds the end-to-end tunnel to the daemon. Requests and the live
// socket go through it; nothing else changes in the app.

export interface RemoteTransport {
  request(r: {
    method: string;
    path: string;
    body?: string;
    /** Only x-oraknid-unlock travels; the loader adds the device's token. */
    headers?: Record<string, string>;
  }): Promise<{
    status: number;
    headers: Record<string, string>;
    body: string;
  }>;
  /** Push to this device, registered by the loader. */
  subscribePush(): Promise<void>;
  openLive(
    h: { onOpen(): void; onMessage(frame: string): void; onClose(): void },
    unlock?: string,
  ): {
    send(frame: string): void;
    close(): void;
  };
}

/**
 * The loader's transport, when the UI runs inside it (Audit 2): the UI's
 * frame is sandboxed, so it talks to the loader only through the message
 * port the loader hands it; until the port comes, calls wait.
 */
export function remote(): RemoteTransport | null {
  return window.parent !== window && window.name === "oraknid-remote" ? portTransport() : null;
}

let transport: RemoteTransport | null = null;

function portTransport(): RemoteTransport {
  if (transport) return transport;
  let port: MessagePort | null = null;
  const waiting: unknown[] = [];
  const replies = new Map<number, { ok(v: unknown): void; fail(e: Error): void }>();
  let next = 1;
  let live: { onOpen(): void; onMessage(frame: string): void; onClose(): void } | null = null;
  const post = (m: unknown) => (port ? port.postMessage(m) : waiting.push(m));
  const call = <T>(op: string, extra: object = {}) =>
    new Promise<T>((ok, fail) => {
      const id = next++;
      replies.set(id, { ok: ok as (v: unknown) => void, fail });
      post({ id, op, ...extra });
    });
  window.addEventListener("message", (e) => {
    // Only the loader, once: it's this frame's parent.
    if (port || e.source !== window.parent || e.data !== "oraknid-remote" || !e.ports[0]) return;
    port = e.ports[0];
    port.onmessage = (m) => {
      const d = m.data as {
        id?: number;
        ok?: unknown;
        error?: string;
        op?: string;
        frame?: string;
      };
      if (typeof d.id === "number") {
        const r = replies.get(d.id);
        replies.delete(d.id);
        if (d.error !== undefined) r?.fail(new Error(d.error));
        else r?.ok(d.ok);
      } else if (d.op === "live-open") live?.onOpen();
      else if (d.op === "live" && typeof d.frame === "string") live?.onMessage(d.frame);
      else if (d.op === "live-close") {
        const l = live;
        live = null;
        l?.onClose();
      }
    };
    for (const m of waiting.splice(0)) port.postMessage(m);
  });
  transport = {
    request: (r) => call("request", { r }),
    subscribePush: () => call<void>("subscribePush"),
    openLive: (h, session) => {
      live = h;
      post({ op: "live-open", session });
      return {
        send: (frame) => post({ op: "live-send", frame }),
        close: () => {
          live = null;
          post({ op: "live-close" });
        },
      };
    },
  };
  return transport;
}

/** fetch, through the tunnel. */
export async function remoteFetch(t: RemoteTransport, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const body = request.method === "GET" ? undefined : await request.text();
  const session = request.headers.get("x-oraknid-unlock");
  const r = await t.request({
    method: request.method,
    path: `${url.pathname}${url.search}`,
    ...(body !== undefined ? { body } : {}),
    ...(session ? { headers: { "x-oraknid-unlock": session } } : {}),
  });
  return new Response(r.body, { status: r.status, headers: r.headers });
}

/** Enough of a WebSocket for the live client, through the tunnel. */
export class RemoteSocket {
  static readonly OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  readonly #conn: { send(frame: string): void; close(): void };

  constructor(t: RemoteTransport, unlock?: string) {
    this.#conn = t.openLive(
      {
        onOpen: () => {
          this.readyState = 1;
          this.onopen?.();
        },
        onMessage: (frame) => this.onmessage?.({ data: frame }),
        onClose: () => {
          this.readyState = 3;
          this.onclose?.();
        },
      },
      unlock,
    );
  }

  send(frame: string) {
    this.#conn.send(frame);
  }

  close() {
    this.#conn.close();
  }
}
