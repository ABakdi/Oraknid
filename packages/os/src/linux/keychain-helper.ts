import { type ChildProcess, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import type { KeychainClient } from "./keychain.ts";

// ADR-070: the keychain never runs on the daemon's own thread pool. The
// native keyring's calls over D-Bus can wait forever (a locked collection
// waiting for its unlock prompt, a Secret Service not started yet): on the
// libuv pool four of them stopped every file read, and the web UI with
// them (seen 2026-10-16 after a reboot). They run in a helper process of
// their own, one at a time, each with a deadline; a helper that misses it
// is killed, and its D-Bus connection closes with it.

/** How long one keychain call may take before the helper is killed. */
export const KEYCHAIN_TIMEOUT_MS = 5000;

/** The keychain didn't answer in time: locked and waiting for a prompt, or not started yet. */
export class KeychainTimeout extends Error {
  constructor(ms: number) {
    super(
      `The desktop keychain didn't answer within ${Math.round(ms / 100) / 10} s (locked, or not started yet).`,
    );
    this.name = "KeychainTimeout";
  }
}

/**
 * The helper: the native keyring's synchronous calls, one request per line
 * on stdin, one answer per line on stdout. CommonJS run with `node -e`,
 * so it needs no file of its own in the build; the keyring module's path
 * is its first argument.
 */
export const HELPER_SOURCE = `
const k = require(process.argv[1]);
const rl = require("node:readline").createInterface({ input: process.stdin });
const opts = { linux: { store: "secret-service" } };
rl.on("line", (line) => {
  let r;
  try { r = JSON.parse(line); } catch { return; }
  let out;
  try {
    const e = () => new k.Entry(r.service, r.name, opts);
    let value;
    if (r.op === "get") value = e().getPassword() ?? undefined;
    else if (r.op === "set") e().setPassword(r.value);
    else if (r.op === "delete") value = e().deleteCredential();
    else if (r.op === "find") value = k.findCredentials(r.service).map((c) => c.account);
    out = { id: r.id, ok: true, value };
  } catch (err) {
    out = { id: r.id, ok: false, error: String((err && err.message) || err) };
  }
  process.stdout.write(JSON.stringify(out) + "\\n");
});
rl.on("close", () => process.exit(0));
`;

export interface HelperOptions {
  /** The helper's command (tests: a stand-in); the native keyring under this Node otherwise. */
  command?: () => { file: string; args: string[] };
  timeoutMs?: number;
  /** How long an idle helper stays: then its stdin closes and it ends. */
  idleMs?: number;
  /** Calls waiting behind the one in flight; more are refused at once. */
  maxQueued?: number;
  env?: NodeJS.ProcessEnv;
}

interface Request {
  op: "get" | "set" | "delete" | "find";
  service: string;
  name?: string;
  value?: string;
}

interface Pending {
  req: Request;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

/** What a helper client has done, for tests and `doctor`. */
export interface HelperStats {
  /** Helpers started since it was made. */
  spawned: number;
  /** Helpers running now (never more than one). */
  alive: number;
  /** Calls waiting behind the one in flight. */
  queued: number;
  /** Helpers killed for not answering in time. */
  timedOut: number;
}

function nativeCommand() {
  const keyring = createRequire(import.meta.url).resolve("@napi-rs/keyring");
  return { file: process.execPath, args: ["-e", HELPER_SOURCE, keyring] };
}

/**
 * A keychain client over the helper process: one call in flight, the rest
 * queued; a call that misses its deadline kills the helper (its D-Bus
 * connection goes with it) and fails with KeychainTimeout, as do the calls
 * queued behind it. The next call starts a new helper.
 */
export class HelperClient implements KeychainClient {
  #child: ChildProcess | null = null;
  #lines: ReturnType<typeof createInterface> | null = null;
  #queue: Pending[] = [];
  #current: (Pending & { id: number; timer: NodeJS.Timeout }) | null = null;
  #idle: NodeJS.Timeout | null = null;
  #nextId = 1;
  #stderr = "";
  #stats = { spawned: 0, timedOut: 0 };
  #closed = false;

  constructor(private readonly o: HelperOptions = {}) {}

  stats(): HelperStats {
    return {
      ...this.#stats,
      alive: this.#child ? 1 : 0,
      queued: this.#queue.length,
    };
  }

  async get(service: string, name: string) {
    return (await this.#call({ op: "get", service, name })) as string | undefined;
  }
  async set(service: string, name: string, value: string) {
    await this.#call({ op: "set", service, name, value });
  }
  async delete(service: string, name: string) {
    return Boolean(await this.#call({ op: "delete", service, name }));
  }
  async find(service: string) {
    return ((await this.#call({ op: "find", service })) as string[] | undefined) ?? [];
  }

  /** Ends the helper and fails what waits: the client is done with. */
  close() {
    this.#closed = true;
    this.#kill(new Error("The keychain connection was closed."));
  }

  #call(req: Request): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error("The keychain connection was closed."));
    if (this.#queue.length >= (this.o.maxQueued ?? 32))
      return Promise.reject(new Error("The desktop keychain is busy; try again in a moment."));
    return new Promise((resolve, reject) => {
      this.#queue.push({ req, resolve, reject });
      this.#pump();
    });
  }

  #pump() {
    if (this.#current) return;
    const next = this.#queue.shift();
    if (!next) {
      this.#armIdle();
      return;
    }
    if (this.#idle) clearTimeout(this.#idle);
    this.#idle = null;
    let child: ChildProcess;
    try {
      child = this.#child ?? this.#spawn();
    } catch (error) {
      next.reject(error instanceof Error ? error : new Error(String(error)));
      this.#pump();
      return;
    }
    const id = this.#nextId++;
    const ms = this.o.timeoutMs ?? KEYCHAIN_TIMEOUT_MS;
    // Ref'd while a call is in flight: a CLI awaiting the keychain stays up for its answer.
    const timer = setTimeout(() => {
      this.#stats.timedOut++;
      this.#kill(new KeychainTimeout(ms));
    }, ms);
    this.#current = { ...next, id, timer };
    child.stdin?.write(`${JSON.stringify({ id, ...next.req })}\n`);
  }

  #spawn(): ChildProcess {
    const { file, args } = (this.o.command ?? nativeCommand)();
    const child = spawn(file, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: this.o.env ?? process.env,
    });
    this.#stats.spawned++;
    this.#stderr = "";
    // A helper never keeps the daemon or a CLI alive by itself.
    child.unref();
    for (const s of [child.stdin, child.stdout, child.stderr])
      (s as unknown as { unref?: () => void } | null)?.unref?.();
    child.stdin?.on("error", () => {});
    child.stderr?.on("data", (d) => {
      this.#stderr = (this.#stderr + d).slice(-2000);
    });
    const lines = createInterface({ input: child.stdout as NodeJS.ReadableStream });
    lines.on("line", (line) => this.#answer(child, line));
    child.once("error", (e) => {
      if (this.#child === child)
        this.#kill(new Error(`The keychain helper didn't start: ${e.message}`));
    });
    child.once("exit", (code, signal) => {
      if (this.#child !== child) return;
      const why = this.#stderr.trim().split("\n").pop() || `exit ${code ?? signal}`;
      // Read by the link as a connection gone, so the call is made once more on a new one.
      this.#kill(new Error(`The keychain helper stopped (D-Bus connection lost?): ${why}`));
    });
    this.#child = child;
    this.#lines = lines;
    return child;
  }

  #answer(child: ChildProcess, line: string) {
    if (this.#child !== child || !this.#current) return;
    let r: { id: number; ok: boolean; value?: unknown; error?: string };
    try {
      r = JSON.parse(line);
    } catch {
      return;
    }
    if (r.id !== this.#current.id) return;
    const done = this.#current;
    clearTimeout(done.timer);
    this.#current = null;
    if (r.ok) done.resolve(r.value);
    else done.reject(new Error(r.error ?? "The keychain refused."));
    this.#pump();
  }

  /** The helper killed (its connection closes with it); the call in flight and those queued fail. */
  #kill(error: Error) {
    const child = this.#child;
    this.#child = null;
    this.#lines?.close();
    this.#lines = null;
    if (this.#idle) clearTimeout(this.#idle);
    this.#idle = null;
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    const failed = [...(this.#current ? [this.#current] : []), ...this.#queue];
    if (this.#current) clearTimeout(this.#current.timer);
    this.#current = null;
    this.#queue = [];
    for (const p of failed) p.reject(error);
  }

  #armIdle() {
    if (!this.#child || this.#idle) return;
    const child = this.#child;
    this.#idle = setTimeout(() => {
      this.#idle = null;
      if (this.#child !== child || this.#current) return;
      // Its stdin closed, it ends by itself; a moment later it is made to.
      this.#child = null;
      this.#lines?.close();
      this.#lines = null;
      child.stdin?.end();
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 1000).unref();
    }, this.o.idleMs ?? 15_000);
    this.#idle.unref();
  }
}
