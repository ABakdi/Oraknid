import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import type { Readable } from "node:stream";
import sodium from "libsodium-wrappers";

// rclone (ADR-046): Oraknid runs it as a child process with a config file
// of its own, encrypted with rclone's config encryption under a password
// from the keychain. The password reaches rclone in its environment
// (RCLONE_CONFIG_PASS), never on its command line; no credential is ever
// an argument: Oraknid writes the config itself.

/** How to get rclone, for the pages and `oraknid doctor`. */
export const RCLONE_FIX =
  "Install rclone with your package manager (sudo pacman -S rclone, sudo apt install rclone, sudo dnf install rclone), or run install.sh again.";

/** rclone on this machine: ORAKNID_RCLONE, else the first on the PATH. */
export function findRclone(env: NodeJS.ProcessEnv = process.env): string | null {
  const pinned = env.ORAKNID_RCLONE;
  if (pinned) return executable(pinned) ? pinned : null;
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, "rclone");
    if (executable(p)) return p;
  }
  return null;
}

function executable(p: string) {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function rcloneVersion(bin: string): string | null {
  const r = spawnSync(bin, ["version"], { encoding: "utf8", timeout: 10_000, env: cleanEnv() });
  if (r.status !== 0) return null;
  return r.stdout.trim().split("\n")[0] ?? null;
}

/** Mine, without any RCLONE_* of the shell's that would change what rclone does. */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("RCLONE_")) env[k] = v;
  return { ...env, ...extra };
}

// ── The config file, in rclone's own encrypted format

const HEADER = "# Encrypted rclone configuration File\n\nRCLONE_ENCRYPT_V0:\n";
const configKey = (password: string) =>
  createHash("sha256").update(`[${password}][rclone-config]`).digest();

/** As rclone writes it: NaCl secretbox, the key from the password, the nonce first, base64. */
export async function encryptConfig(plain: string, password: string): Promise<string> {
  await sodium.ready;
  const nonce = randomBytes(24);
  const box = sodium.crypto_secretbox_easy(Buffer.from(plain, "utf8"), nonce, configKey(password));
  return `${HEADER}${Buffer.concat([nonce, Buffer.from(box)]).toString("base64")}\n`;
}

export async function decryptConfig(text: string, password: string): Promise<string> {
  const at = text.indexOf("RCLONE_ENCRYPT_V0:");
  if (at < 0) throw new Error("The cloud storage config isn't encrypted.");
  await sodium.ready;
  const raw = Buffer.from(text.slice(at + "RCLONE_ENCRYPT_V0:".length).trim(), "base64");
  try {
    const plain = sodium.crypto_secretbox_open_easy(
      raw.subarray(24),
      raw.subarray(0, 24),
      configKey(password),
    );
    return Buffer.from(plain).toString("utf8");
  } catch {
    throw new Error("The cloud storage config can't be opened with the keychain's password.");
  }
}

export type Sections = Map<string, Map<string, string>>;

export function parseIni(text: string): Sections {
  const out: Sections = new Map();
  let cur: Map<string, string> | null = null;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || t.startsWith(";")) continue;
    const head = /^\[(.+)\]$/.exec(t);
    if (head) {
      cur = new Map();
      out.set(head[1] as string, cur);
      continue;
    }
    const eq = t.indexOf("=");
    if (cur && eq > 0) cur.set(t.slice(0, eq).trim(), t.slice(eq + 1).trim());
  }
  return out;
}

export function writeIni(s: Sections): string {
  return [...s]
    .map(([name, kv]) => `[${name}]\n${[...kv].map(([k, v]) => `${k} = ${v}`).join("\n")}\n`)
    .join("\n");
}

/** A value for one line of the config: no line breaks can get in. */
const oneLine = (v: string) => {
  if (/[\r\n]/.test(v)) throw new Error("A value can't hold a line break.");
  return v;
};

// ── Running it

export interface RcloneResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface Stats {
  bytes: number;
  total: number | null;
}

/** rclone's own words for what went wrong, from its JSON log. */
export function rcloneError(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map((l) => {
      try {
        return JSON.parse(l) as { level?: string; msg?: string };
      } catch {
        return l.trim() ? { level: "error", msg: l.trim() } : null;
      }
    })
    .filter((x): x is { level?: string; msg?: string } => !!x?.msg);
  const pick =
    lines.filter((l) => l.level === "critical" || l.level === "error").at(-1) ??
    lines.filter((l) => l.level === "notice" || l.level === "warning").at(-1);
  const msg = (pick?.msg ?? "rclone stopped without saying why.").trim();
  // "Failed to copy: …" says the same twice.
  return msg.replace(/^Failed to [a-z]+:\s*/i, "").split("\n")[0] as string;
}

export interface RcloneOptions {
  /** The binary; found on the PATH when not given. */
  bin?: () => string | null;
  configFile: string;
  /** The config's password, from the keychain. */
  password: () => Promise<string>;
}

export class Rclone {
  readonly #children = new Set<ChildProcess>();
  /** Writes of the config, one at a time. */
  #writing: Promise<unknown> = Promise.resolve();

  constructor(private readonly o: RcloneOptions) {}

  bin(): string | null {
    return this.o.bin ? this.o.bin() : findRclone();
  }

  #need(): string {
    const b = this.bin();
    if (!b) throw new Error(`rclone isn't installed. ${RCLONE_FIX}`);
    return b;
  }

  async #spawn(args: string[], extraEnv: Record<string, string> = {}) {
    const bin = this.#need();
    const password = await this.o.password();
    const child = spawn(
      bin,
      ["--config", this.o.configFile, "--ask-password=false", "--use-json-log", ...args],
      {
        env: cleanEnv({ RCLONE_CONFIG_PASS: password, ...extraEnv }),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.#children.add(child);
    child.once("close", () => this.#children.delete(child));
    // A command that ends without reading its stdin is not an error of ours.
    child.stdin?.on("error", () => {});
    return child;
  }

  /** One command to its end: its output, and progress from its stats when asked. */
  async run(
    args: string[],
    o: { stdin?: string; onStats?: (s: Stats) => void; signal?: AbortSignal } = {},
  ): Promise<RcloneResult> {
    const full = o.onStats ? ["--stats", "500ms", "-v", ...args] : args;
    const child = await this.#spawn(full);
    const out: Buffer[] = [];
    let err = "";
    let partial = "";
    child.stdout?.on("data", (d: Buffer) => out.push(d));
    child.stderr?.on("data", (d: Buffer) => {
      const text = d.toString("utf8");
      // The progress lines are many: only the last few hundred lines of the rest are kept.
      partial += text;
      const lines = partial.split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) {
        if (o.onStats && line.includes('"stats"')) {
          try {
            const s = (JSON.parse(line) as { stats?: { bytes?: number; totalBytes?: number } })
              .stats;
            if (s) o.onStats({ bytes: s.bytes ?? 0, total: s.totalBytes ?? null });
          } catch {}
          continue;
        }
        err = `${err}${line}\n`.slice(-20_000);
      }
    });
    const abort = () => child.kill("SIGTERM");
    o.signal?.addEventListener("abort", abort, { once: true });
    child.stdin?.end(o.stdin ?? "");
    const code = await new Promise<number | null>((resolve) => {
      child.once("error", () => resolve(-1));
      child.once("close", (c) => resolve(c));
    });
    o.signal?.removeEventListener("abort", abort);
    return { code, stdout: Buffer.concat(out).toString("utf8"), stderr: err + partial };
  }

  /** Throws rclone's own words when it fails. */
  async ok(args: string[], o: Parameters<Rclone["run"]>[1] = {}): Promise<string> {
    const r = await this.run(args, o);
    if (r.code !== 0) throw new Error(rcloneError(r.stderr));
    return r.stdout;
  }

  async json<T>(args: string[]): Promise<T> {
    return JSON.parse(await this.ok(args)) as T;
  }

  /** A file's bytes as they come (`rclone cat`), and its end. */
  async stream(args: string[]): Promise<{ stdout: Readable; done: Promise<string | null> }> {
    const child = await this.#spawn(args);
    child.stdin?.end();
    let err = "";
    child.stderr?.on("data", (d: Buffer) => {
      err = `${err}${d.toString("utf8")}`.slice(-20_000);
    });
    const done = new Promise<string | null>((resolve) => {
      child.once("error", (e) => resolve(e.message));
      child.once("close", (c) => resolve(c === 0 ? null : rcloneError(err)));
    });
    return { stdout: child.stdout as Readable, done };
  }

  /** A long-running command whose output is read as it comes (authorize). */
  async start(args: string[]): Promise<ChildProcess> {
    return this.#spawn(args);
  }

  /** A password as rclone keeps it in its config (obscured), given on stdin. */
  async obscure(value: string): Promise<string> {
    return (await this.ok(["obscure", "-"], { stdin: `${oneLine(value)}\n` })).trim();
  }

  // ── The config

  async read(): Promise<Sections> {
    if (!existsSync(this.o.configFile)) return new Map();
    const text = readFileSync(this.o.configFile, "utf8");
    if (!text.trim()) return new Map();
    return parseIni(await decryptConfig(text, await this.o.password()));
  }

  /** Changes the config: read, changed, encrypted, written whole (0600) in its place. */
  edit(fn: (s: Sections) => void): Promise<void> {
    const next = this.#writing.then(async () => {
      const s = await this.read();
      fn(s);
      for (const kv of s.values()) for (const v of kv.values()) oneLine(v);
      const text = await encryptConfig(writeIni(s), await this.o.password());
      const tmp = `${this.o.configFile}.${randomBytes(4).toString("hex")}.tmp`;
      writeFileSync(tmp, text, { mode: 0o600 });
      renameSync(tmp, this.o.configFile);
    });
    this.#writing = next.catch(() => {});
    return next;
  }

  stopAll() {
    for (const c of this.#children) c.kill("SIGTERM");
  }
}
