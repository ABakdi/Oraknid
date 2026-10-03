import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { suspicious, wrapUntrusted } from "@oraknid/core";
import type { McpServer } from "@oraknid/leg-sdk";
import type { Sandbox } from "@oraknid/os";
import { toolchainDirs } from "../legs/plan.ts";
import { isBuiltIn, type ToolRegistry, type ToolRow } from "./registry.ts";

// The MCP broker (ADR-021): the daemon runs each tool's server in its own
// sandbox with its secrets, and a Leg reaches it only through a bridge on
// a unix socket. Every tools/call is judged before it reaches the server.

/** Pipes stdio to the broker's socket; all a Leg ever runs of a tool. */
const BRIDGE = `import { connect } from "node:net";
const s = connect(process.argv[2]);
s.on("error", (e) => { process.stderr.write(\`oraknid bridge: \${e.message}\\n\`); process.exit(1); });
s.on("close", () => process.exit(0));
process.stdin.pipe(s);
s.pipe(process.stdout);
`;

/** One JSON-RPC message in, its answer out (null: a notification, nothing to answer). */
export type McpHandler = (message: Rpc) => Promise<Rpc | null>;

/** A tool Oraknid answers itself, for one session of a job (ADR-032: the email tool). */
export type BuiltInServer = (session: { jobId: string | null }) => McpHandler;

export type CallDecision = { allow: true } | { allow: false; message: string };

export interface BrokerHooks {
  /** The job's policy on one call, as the tool `mcp__<tool>__<name>`; may wait for my answer. */
  decide(tool: ToolRow, name: string, args: Record<string, unknown>): Promise<CallDecision>;
  /** A call's outcome, for the job's events. */
  done(
    tool: ToolRow,
    name: string,
    o: {
      allowed: boolean;
      ok: boolean;
      bytes: number;
      flags: string[];
      args: Record<string, unknown>;
    },
  ): void;
}

export interface BrokerSession {
  /** What the Leg is given, by server name (`oraknid-<tool>`). */
  servers: Record<string, McpServer>;
  /** Folders the Leg's sandbox must reach: the sockets (writable) and the bridge's node (read). */
  writable: string[];
  readonly: string[];
  close(): void;
}

export interface Rpc {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
  result?: {
    content?: { type: string; text?: string }[];
    isError?: boolean;
    [key: string]: unknown;
  };
  error?: { code?: number; message?: string };
}

/** What the relay needs of a server: lines in, lines out, a way to stop it. */
type Endpoint = Pick<ChildProcess, "stdin" | "stdout" | "kill" | "on" | "once">;

export class McpBroker {
  constructor(
    private readonly o: {
      registry: ToolRegistry;
      /** null: the job runs unsandboxed, and so do its tools (ADR-006). */
      sandbox: Sandbox | null;
      /** Oraknid's own tools, by name: answered in the daemon, with no process. */
      builtIns?: Map<string, BuiltInServer>;
    },
  ) {}

  /** Opens the job's tools for one Leg session. Closing it stops every server. */
  async open(
    rows: ToolRow[],
    hooks: BrokerHooks,
    session: { jobId: string | null } = { jobId: null },
  ): Promise<BrokerSession> {
    const dir = mkdtempSync(join(tmpdir(), "oraknid-mcp-"));
    const bridge = join(dir, "bridge.mjs");
    writeFileSync(bridge, BRIDGE);
    const servers: Record<string, McpServer> = {};
    const listeners: Server[] = [];
    const children = new Set<Endpoint>();
    for (const row of rows) {
      // Read now: a missing secret fails the session's start, not a call later.
      const env = await this.o.registry.environment(row);
      const socket = join(dir, `${row.name}.sock`);
      const listener = createServer((client) => {
        const child = isBuiltIn(row) ? this.#builtIn(row, session) : this.#start(row, env, dir);
        children.add(child);
        child.once("exit", () => children.delete(child));
        relay(row, client, child, hooks);
      });
      await new Promise<void>((resolve, reject) => {
        listener.once("error", reject);
        listener.listen(socket, resolve);
      });
      listeners.push(listener);
      servers[`oraknid-${row.name}`] = { command: process.execPath, args: [bridge, socket] };
    }
    return {
      servers,
      writable: [dir],
      readonly: [dirname(process.execPath)],
      close: () => {
        for (const l of listeners) l.close();
        for (const c of children) c.kill("SIGKILL");
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  /** One of Oraknid's own tools: the same lines, answered in the daemon (its secrets never leave it). */
  #builtIn(row: ToolRow, session: { jobId: string | null }): Endpoint {
    const server = this.o.builtIns?.get(row.name);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const events = new EventEmitter();
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      stdout.end();
      events.emit("exit", 0, null);
    };
    const handle = server?.(session);
    createInterface({ input: stdin }).on("line", async (line) => {
      let m: Rpc;
      try {
        m = JSON.parse(line) as Rpc;
      } catch {
        return;
      }
      const answer = handle
        ? await handle(m).catch(
            (e): Rpc => ({
              jsonrpc: "2.0",
              id: m.id,
              error: { code: -32603, message: e instanceof Error ? e.message : String(e) },
            }),
          )
        : m.id !== undefined
          ? {
              jsonrpc: "2.0",
              id: m.id,
              error: { code: -32601, message: `${row.name} is not available` },
            }
          : null;
      if (answer && !ended) stdout.write(`${JSON.stringify(answer)}\n`);
    });
    const endpoint = {
      stdin,
      stdout,
      kill: () => {
        end();
        return true;
      },
      on: (event: string, fn: (...a: unknown[]) => void) => {
        events.on(event, fn);
        return endpoint;
      },
      once: (event: string, fn: (...a: unknown[]) => void) => {
        events.once(event, fn);
        return endpoint;
      },
    };
    return endpoint as unknown as Endpoint;
  }

  /** The tool's server, in its own sandbox: network on, a throwaway home, nothing of the job's. */
  #start(row: ToolRow, env: Record<string, string>, dir: string): ChildProcess {
    const home = mkdtempSync(join(dir, `${row.name}-home-`));
    const fullEnv = {
      PATH: process.env.PATH ?? "/usr/bin",
      LANG: process.env.LANG ?? "C.UTF-8",
      HOME: home,
      ...env,
    };
    const wrapped = this.o.sandbox
      ? this.o.sandbox.wrap({
          command: row.command,
          args: row.args,
          cwd: home,
          writable: [home],
          // The server itself: its program and any file it is given, read-only.
          readonly: [
            ...toolchainDirs(),
            dirname(process.execPath),
            ...[row.command, ...row.args].filter((p) => isAbsolute(p) && existsSync(p)),
          ],
          home,
          env: fullEnv,
        })
      : { command: row.command, args: row.args };
    const child = spawn(wrapped.command, wrapped.args, {
      cwd: home,
      env: fullEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stderr?.resume();
    return child;
  }
}

/** Moves JSON-RPC lines between the Leg and the server, judging each tools/call on the way. */
function relay(row: ToolRow, client: Socket, child: Endpoint, hooks: BrokerHooks) {
  const calls = new Map<number | string, { name: string; args: Record<string, unknown> }>();
  const toClient = (m: unknown) => {
    if (!client.destroyed) client.write(`${JSON.stringify(m)}\n`);
  };
  createInterface({ input: client }).on("line", async (line) => {
    let m: Rpc;
    try {
      m = JSON.parse(line) as Rpc;
    } catch {
      return;
    }
    if (m.method === "tools/call" && m.id !== undefined) {
      const name = String(m.params?.name ?? "");
      const args = m.params?.arguments ?? {};
      const verdict = await hooks.decide(row, name, args);
      if (!verdict.allow) {
        hooks.done(row, name, { allowed: false, ok: false, bytes: 0, flags: [], args });
        toClient({
          jsonrpc: "2.0",
          id: m.id,
          result: { content: [{ type: "text", text: verdict.message }], isError: true },
        });
        return;
      }
      calls.set(m.id, { name, args });
    }
    child.stdin?.write(`${line}\n`);
  });
  createInterface({ input: child.stdout as NodeJS.ReadableStream }).on("line", (line) => {
    let m: Rpc;
    try {
      m = JSON.parse(line) as Rpc;
    } catch {
      return;
    }
    const call = m.id !== undefined ? calls.get(m.id) : undefined;
    if (call !== undefined && m.id !== undefined) {
      const { name, args } = call;
      calls.delete(m.id);
      const content = m.result?.content ?? [];
      const text = content.map((c) => c.text ?? "").join("\n");
      hooks.done(row, name, {
        allowed: true,
        ok: !m.error && !m.result?.isError,
        bytes: text.length,
        flags: row.untrusted ? suspicious(text) : [],
        args,
      });
      // What came from outside is data, never instructions (BR-15).
      if (row.untrusted && m.result)
        m.result.content = content.map((c) =>
          c.type === "text" && c.text
            ? { ...c, text: wrapUntrusted(`the ${row.name} tool (${name})`, c.text) }
            : c,
        );
    }
    toClient(m);
  });
  client.on("close", () => child.kill("SIGTERM"));
  child.on("exit", () => client.end());
}
