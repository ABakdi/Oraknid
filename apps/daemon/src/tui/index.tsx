import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ServerView } from "@oraknid/contracts";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { render } from "ink";
import WebSocket from "ws";
import type { Api } from "./actions.ts";
import { App, type Snapshot } from "./app.tsx";
import { LiveSocket } from "./live.ts";

// `oraknid` in a terminal (ADR-055): loaded only when the terminal app opens,
// so the daemon's service never loads Ink or React.

export interface TuiOptions {
  url: string;
  token: string;
  /** Where the current project is remembered between two openings. */
  stateFile: string;
}

function remembered(file: string): Partial<Snapshot> {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Partial<Snapshot>;
  } catch {
    return {};
  }
}

function remember(file: string, s: Snapshot) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(s)}\n`, { mode: 0o600 });
  } catch {}
}

export async function runTui(o: TuiOptions): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      "The terminal app needs a terminal: run `oraknid` in one (or see `oraknid --help`).",
    );
  const api: Api = createORPCClient(
    new RPCLink({ url: `${o.url}/api`, headers: { authorization: `Bearer ${o.token}` } }),
  );
  const live = new LiveSocket(o.url, o.token);
  live.start();
  let snapshot: Partial<Snapshot> = remembered(o.stateFile);
  // The whole screen while it is open, given back as it was after.
  process.stdout.write("\x1b[?1049h\x1b[H");
  const restore = () => process.stdout.write("\x1b[?1049l");
  process.once("exit", restore);
  try {
    for (;;) {
      let shell: ServerView | null = null;
      const app = render(
        <App
          api={api}
          live={live}
          initial={snapshot}
          onShell={(server, snap) => {
            shell = server;
            snapshot = snap;
          }}
          onQuit={(snap) => {
            snapshot = snap;
            remember(o.stateFile, snap);
          }}
          bell={() => process.stdout.write("\x07")}
        />,
        { exitOnCtrlC: false },
      );
      await app.waitUntilExit();
      app.clear();
      const server = shell as ServerView | null;
      if (!server) break;
      restore();
      await openShell(o, server);
      process.stdout.write("\x1b[?1049h\x1b[H");
    }
  } finally {
    live.close();
    restore();
    process.removeListener("exit", restore);
  }
}

/**
 * /ssh: a shell on the server through the daemon's terminal (ADR-028), with
 * Oraknid's key, which never leaves the daemon; audited like the web's.
 * Ctrl+] leaves it.
 */
export function openShell(o: { url: string; token: string }, server: ServerView): Promise<void> {
  return new Promise((resolve) => {
    const out = process.stdout;
    const cols = out.columns ?? 80;
    const rows = out.rows ?? 24;
    out.write(`Connecting to ${server.name} (${server.user}@${server.host}) · Ctrl+] to leave\r\n`);
    const ws = new WebSocket(
      `${o.url.replace(/^http/, "ws")}/term?target=${encodeURIComponent(server.id)}&cols=${cols}&rows=${rows}&token=${encodeURIComponent(o.token)}`,
    );
    const stdin = process.stdin;
    const onData = (d: Buffer) => {
      if (d.length === 1 && d[0] === 0x1d) return ws.close();
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "in", d: d.toString() }));
    };
    const onResize = () => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ t: "resize", cols: out.columns ?? 80, rows: out.rows ?? 24 }));
    };
    let done = false;
    const end = (said?: string) => {
      if (done) return;
      done = true;
      stdin.off("data", onData);
      out.off("resize", onResize);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      if (said) out.write(`\r\n${said}\r\n`);
      // A moment to read why, before the app comes back.
      setTimeout(resolve, said ? 2500 : 0);
    };
    ws.on("unexpected-response", (_req, res) => {
      end(
        res.statusCode === 403
          ? "The terminal is off: turn it on with /settings terminal on (it is off until you do)."
          : `The shell didn't open (HTTP ${res.statusCode}).`,
      );
    });
    ws.on("error", (e) => end(`The shell didn't open: ${e.message}`));
    ws.on("open", () => {
      if (stdin.isTTY) stdin.setRawMode(true);
      stdin.resume();
      stdin.on("data", onData);
      out.on("resize", onResize);
    });
    ws.on("message", (d) => out.write(d.toString()));
    ws.on("close", () => end());
  });
}
