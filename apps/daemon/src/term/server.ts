import { existsSync } from "node:fs";
import type { IncomingMessage, Server } from "node:http";
import { homedir } from "node:os";
import { WebSocketServer } from "ws";
import type { EventBus } from "../events/bus.ts";
import { LOCKING } from "../live/server.ts";
import type { Servers } from "../servers/service.ts";

// The terminal (ADR-028): one WebSocket per terminal, keystrokes and
// resizes in, output out; a real pty on this computer (node-pty), or an
// SSH shell on one of my servers. Off until I turn it on; audited.

export const TERMINAL_SETTING = "terminal.enabled";

type Frame = { t: "in"; d: string } | { t: "resize"; cols: number; rows: number };

interface Pty {
  write(d: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(f: (d: string) => void): void;
  onExit(f: () => void): void;
}

async function localPty(cols: number, rows: number, cwd = homedir()): Promise<Pty> {
  // Loaded only when a terminal opens: a native module the rest never needs.
  const pty = await import("node-pty");
  const shell = process.env.SHELL || "/bin/bash";
  const p = pty.spawn(shell, ["-l"], {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
  });
  return {
    write: (d) => p.write(d),
    resize: (c, r) => p.resize(c, r),
    kill: () => p.kill(),
    onData: (f) => p.onData(f),
    onExit: (f) => p.onExit(() => f()),
  };
}

async function serverPty(servers: Servers, id: string, cols: number, rows: number): Promise<Pty> {
  const ch = await servers.shell(id, cols, rows);
  return {
    write: (d) => ch.write(d),
    resize: (c, r) => ch.setWindow(r, c, 0, 0),
    kill: () => ch.close(),
    onData: (f) => {
      ch.on("data", (d: Buffer) => f(d.toString()));
      ch.stderr.on("data", (d: Buffer) => f(d.toString()));
    },
    onExit: (f) => ch.on("close", f),
  };
}

export function attachTerminal(o: {
  server: Server;
  bus: EventBus;
  servers: Servers;
  /** The paired, unlocked device asking, or null. */
  device: (req: IncomingMessage) => string | null;
  /** Typing in the terminal is activity: it keeps the session unlocked. */
  active?: (req: IncomingMessage) => void;
  enabled: () => boolean;
  /**
   * A project's folder, for a terminal opened from its page: the target is
   * `project:<id>`, never a path, so a terminal starts only in a folder that
   * is one of my projects. Null: no such project.
   */
  projectFolder?: (id: string) => string | null;
}) {
  const wss = new WebSocketServer({ noServer: true });
  const projectCwd = (id: string) => {
    const folder = o.projectFolder?.(id);
    if (!folder || !existsSync(folder)) throw new Error("That project's folder isn't here.");
    return folder;
  };
  // A terminal lives only while its device is paired and unlocked, and the
  // terminal is on (ADR-029): checked every 10 s and at once on a lock.
  const open = new Map<import("ws").WebSocket, IncomingMessage>();
  const recheck = () => {
    for (const [ws, req] of open) if (!o.device(req) || !o.enabled()) ws.close(4401, "locked");
  };
  const timer = setInterval(recheck, 10_000);
  timer.unref();
  const off = o.bus.subscribe((e) => {
    if (LOCKING.has(e.type) || e.type === "settings.updated") recheck();
  });
  o.server.on("close", () => {
    clearInterval(timer);
    off();
  });
  o.server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    // A review frame's own /term is its app's (ADR-064).
    if (
      url.pathname !== "/term" ||
      /^rv-[0-9a-f]{32}\.localhost(:\d+)?$/i.test(req.headers.host ?? "")
    )
      return;
    const device = o.device(req);
    if (!device || !o.enabled()) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, async (ws) => {
      open.set(ws, req);
      ws.on("close", () => open.delete(ws));
      const target = url.searchParams.get("target") ?? "local";
      const cols = Math.max(20, Math.min(500, Number(url.searchParams.get("cols")) || 80));
      const rows = Math.max(5, Math.min(200, Number(url.searchParams.get("rows")) || 24));
      // What comes while the shell starts waits for it: nothing typed is lost.
      let pty: Pty | null = null;
      let gone = false;
      const early: Frame[] = [];
      const apply = (f: Frame) => {
        if (!pty) return early.push(f);
        if (f.t === "in" && typeof f.d === "string") {
          o.active?.(req);
          pty.write(f.d);
        }
        if (f.t === "resize" && f.cols > 0 && f.rows > 0) pty.resize(f.cols, f.rows);
      };
      ws.on("message", (raw) => {
        try {
          apply(JSON.parse(String(raw)) as Frame);
        } catch {}
      });
      ws.on("close", () => {
        gone = true;
        if (!pty) return;
        pty.kill();
        o.bus.publish({
          type: "terminal.closed",
          topic: "overview",
          jobId: null,
          payload: { target },
        });
      });
      try {
        pty =
          target === "local"
            ? await localPty(cols, rows)
            : target.startsWith("project:")
              ? await localPty(cols, rows, projectCwd(target.slice("project:".length)))
              : await serverPty(o.servers, target, cols, rows);
      } catch (error) {
        ws.send(`\r\n\x1b[31m${error instanceof Error ? error.message : String(error)}\x1b[0m\r\n`);
        ws.close();
        return;
      }
      const shell = pty;
      if (gone) {
        shell.kill();
        return;
      }
      // Who opened what, from where, and when; never what is typed (ADR-028, ADR-030).
      o.bus.publish({
        type: "terminal.opened",
        topic: "overview",
        jobId: null,
        payload: { target, device, away: url.searchParams.get("via") === "nest" },
        actor: "owner",
      });
      shell.onData((d) => {
        if (ws.readyState === ws.OPEN) ws.send(d);
      });
      shell.onExit(() => ws.close());
      for (const f of early.splice(0)) apply(f);
    });
  });
}
