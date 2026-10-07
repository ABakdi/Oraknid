import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { delimiter, dirname, join } from "node:path";

// What runs local models (ADR-054): llama.cpp's llama-server, one per
// loaded model on a free port of this computer, or an Ollama already
// here; whisper.cpp for speech. Found on the PATH or in <data>/bin, where
// `install.sh --local-models` puts them.

/** A program on the PATH or in one of `dirs`, or null. */
export function findProgram(
  names: string[],
  dirs: string[],
  path = process.env.PATH ?? "",
): string | null {
  for (const dir of [...dirs, ...path.split(delimiter)]) {
    if (!dir) continue;
    for (const name of names) {
      const p = join(dir, name);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

/** The folders install.sh fills, under the data folder. */
export const binDirs = (dataDir: string) => [
  join(dataDir, "bin"),
  join(dataDir, "bin", "llama.cpp"),
  join(dataDir, "bin", "whisper.cpp"),
];

/** A free port on 127.0.0.1. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const address = s.address();
      const port = typeof address === "object" && address ? address.port : 0;
      s.close(() => resolve(port));
    });
  });
}

export interface LlamaStart {
  binary: string;
  model: string;
  projector: string | null;
  alias: string;
  port: number;
  contextSize: number;
  gpuLayers: number;
  embeddings: boolean;
  logFile: string;
}

/** llama-server's command line: this computer only, its chat template's tool calls on. */
export function llamaArgs(o: LlamaStart): string[] {
  return [
    "--model",
    o.model,
    "--alias",
    o.alias,
    "--host",
    "127.0.0.1",
    "--port",
    String(o.port),
    "--ctx-size",
    String(o.contextSize),
    "--n-gpu-layers",
    String(o.gpuLayers),
    "--jinja",
    ...(o.projector ? ["--mmproj", o.projector] : []),
    ...(o.embeddings ? ["--embeddings"] : []),
  ];
}

export interface Running {
  child: ChildProcess;
  baseUrl: string;
  /** Resolves when the server has ended. */
  exited: Promise<void>;
  stop(): Promise<void>;
}

/** Starts llama-server and waits until it answers /health (the model loaded). */
export async function startLlamaServer(
  o: LlamaStart,
  deps: { fetch?: typeof fetch; spawn?: typeof spawn; timeoutMs?: number } = {},
): Promise<Running> {
  const http = deps.fetch ?? fetch;
  mkdirSync(dirname(o.logFile), { recursive: true });
  const log = createWriteStream(o.logFile, { flags: "a" });
  const child = (deps.spawn ?? spawn)(o.binary, llamaArgs(o), {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  let ended = false;
  let tail = "";
  child.stderr?.on("data", (d: Buffer) => {
    tail = (tail + d.toString()).slice(-2000);
  });
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => {
      ended = true;
      resolve();
    }),
  );
  const baseUrl = `http://127.0.0.1:${o.port}/v1`;
  const stop = async () => {
    if (ended) return;
    child.kill("SIGTERM");
    const t = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(t);
    log.end();
  };
  const deadline = Date.now() + (deps.timeoutMs ?? 180_000);
  while (Date.now() < deadline) {
    if (ended)
      throw new Error(
        `llama-server stopped while loading the model${tail ? `: ${tail.trim().split("\n").slice(-3).join(" / ")}` : ""}`,
      );
    try {
      const res = await http(`http://127.0.0.1:${o.port}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) return { child, baseUrl, exited, stop };
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  await stop();
  throw new Error("llama-server didn't load the model within 3 minutes.");
}

/** Tokens a second, from a short answer: llama.cpp's own timings, else counted. */
export async function measureSpeed(
  http: typeof fetch,
  baseUrl: string,
  model: string,
): Promise<number | null> {
  const t0 = Date.now();
  try {
    const res = await http(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Count from 1 to 40, separated by spaces." }],
        max_tokens: 64,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      timings?: { predicted_per_second?: number };
      usage?: { completion_tokens?: number };
    };
    const own = body.timings?.predicted_per_second;
    if (own && own > 0) return Math.round(own * 10) / 10;
    const n = body.usage?.completion_tokens;
    const s = (Date.now() - t0) / 1000;
    return n && s > 0 ? Math.round((n / s) * 10) / 10 : null;
  } catch {
    return null;
  }
}

/** An Ollama already on this computer (ADR-054). */
export class OllamaClient {
  constructor(
    readonly url: string,
    private readonly http: typeof fetch = fetch,
  ) {}

  get baseUrl() {
    return `${this.url}/v1`;
  }

  async version(): Promise<string | null> {
    try {
      const res = await this.http(`${this.url}/api/version`, { signal: AbortSignal.timeout(1500) });
      return res.ok ? (((await res.json()) as { version?: string }).version ?? "?") : null;
    } catch {
      return null;
    }
  }

  async tags(): Promise<{ name: string; size: number; digest: string }[]> {
    const res = await this.http(`${this.url}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`Ollama answered ${res.status}`);
    return (
      ((await res.json()) as { models?: { name: string; size: number; digest: string }[] })
        .models ?? []
    );
  }

  /** Pulls a model, reporting bytes as Ollama does; Ollama checks every layer's digest. */
  async pull(
    name: string,
    onProgress: (done: number, total: number | null) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const res = await this.http(`${this.url}/api/pull`, {
      method: "POST",
      body: JSON.stringify({ model: name, stream: true }),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok || !res.body) throw new Error(`Ollama couldn't pull ${name}: ${res.status}`);
    const decoder = new TextDecoder();
    let buffer = "";
    const layers = new Map<string, { done: number; total: number }>();
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      for (let cut = buffer.indexOf("\n"); cut >= 0; cut = buffer.indexOf("\n")) {
        const line = buffer.slice(0, cut).trim();
        buffer = buffer.slice(cut + 1);
        if (!line) continue;
        const m = JSON.parse(line) as {
          status?: string;
          digest?: string;
          total?: number;
          completed?: number;
          error?: string;
        };
        if (m.error) throw new Error(`Ollama: ${m.error}`);
        if (m.digest && m.total) layers.set(m.digest, { done: m.completed ?? 0, total: m.total });
        const all = [...layers.values()];
        onProgress(
          all.reduce((n, l) => n + l.done, 0),
          all.length ? all.reduce((n, l) => n + l.total, 0) : null,
        );
      }
    }
  }

  /** Loads it into memory, kept for `minutes` (-1: until unloaded). */
  async load(name: string, minutes: number): Promise<void> {
    const res = await this.http(`${this.url}/api/generate`, {
      method: "POST",
      body: JSON.stringify({
        model: name,
        prompt: "",
        keep_alive: minutes < 0 ? -1 : `${minutes}m`,
      }),
      signal: AbortSignal.timeout(300_000),
    });
    if (!res.ok)
      throw new Error(`Ollama couldn't load ${name}: ${(await res.text()).slice(0, 300)}`);
  }

  async unload(name: string): Promise<void> {
    await this.http(`${this.url}/api/generate`, {
      method: "POST",
      body: JSON.stringify({ model: name, prompt: "", keep_alive: 0 }),
      signal: AbortSignal.timeout(30_000),
    }).catch(() => {});
  }

  async remove(name: string): Promise<void> {
    await this.http(`${this.url}/api/delete`, {
      method: "DELETE",
      body: JSON.stringify({ model: name }),
      signal: AbortSignal.timeout(30_000),
    }).catch(() => {});
  }

  /** What each loaded model holds in VRAM. */
  async ps(): Promise<Map<string, number>> {
    try {
      const res = await this.http(`${this.url}/api/ps`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return new Map();
      const body = (await res.json()) as { models?: { name: string; size_vram?: number }[] };
      return new Map((body.models ?? []).map((m) => [m.name, m.size_vram ?? 0]));
    } catch {
      return new Map();
    }
  }
}
