// Away from home (Nest-Protocol): the UI runs inside The Nest's loader,
// which holds the end-to-end tunnel to the daemon. Requests and the live
// socket go through it; nothing else changes in the app.

export interface RemoteTransport {
  request(r: { method: string; path: string; body?: string }): Promise<{
    status: number;
    headers: Record<string, string>;
    body: string;
  }>;
  /** Push to this device, registered by the loader. */
  subscribePush(): Promise<void>;
  openLive(h: { onOpen(): void; onMessage(frame: string): void; onClose(): void }): {
    send(frame: string): void;
    close(): void;
  };
}

/** The loader's transport, when the UI runs inside it. */
export function remote(): RemoteTransport | null {
  try {
    const t = (window.parent as unknown as { __ORAKNID_REMOTE__?: RemoteTransport })
      .__ORAKNID_REMOTE__;
    return window.parent !== window && t ? t : null;
  } catch {
    return null;
  }
}

/** fetch, through the tunnel. */
export async function remoteFetch(t: RemoteTransport, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const body = request.method === "GET" ? undefined : await request.text();
  const r = await t.request({
    method: request.method,
    path: `${url.pathname}${url.search}`,
    ...(body !== undefined ? { body } : {}),
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

  constructor(t: RemoteTransport) {
    this.#conn = t.openLive({
      onOpen: () => {
        this.readyState = 1;
        this.onopen?.();
      },
      onMessage: (frame) => this.onmessage?.({ data: frame }),
      onClose: () => {
        this.readyState = 3;
        this.onclose?.();
      },
    });
  }

  send(frame: string) {
    this.#conn.send(frame);
  }

  close() {
    this.#conn.close();
  }
}
