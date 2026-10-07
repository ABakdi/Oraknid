import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ggufBytes } from "../models/gguf.ts";

// Stand-ins for Hugging Face's API and file downloads, ollama.com's search
// page, Ollama's registry, and an Ollama on this computer: the models
// module's tests never reach the real ones, and never download a model.

export interface HubFile {
  bytes: Buffer;
  /** The checksum the hub claims; the real one unless a test lies. */
  sha256?: string;
  /** Serve this many bytes a tick, so a download can be paused. */
  slow?: boolean;
}

export function ggufFile(meta: Record<string, string | number>, pad = 4096): Buffer {
  return Buffer.concat([ggufBytes(meta), Buffer.alloc(pad, 7)]);
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

export interface HubRepo {
  id: string;
  pipeline: string;
  tags: string[];
  files: Record<string, HubFile>;
}

export interface FakeHub {
  url: string;
  repos: HubRepo[];
  /** Range headers seen on downloads, by file. */
  ranges: Map<string, string[]>;
  /** Ollama API calls (the local Ollama stand-in). */
  ollamaCalls: { path: string; body: unknown }[];
  /** Models "in" the Ollama stand-in. */
  ollamaModels: { name: string; size: number; digest: string }[];
  close(): Promise<void>;
}

export const chatGguf = ggufFile({
  "general.architecture": "llama",
  "general.name": "Tiny Chat",
  "llama.context_length": 4096,
  "llama.block_count": 22,
});

export function defaultRepos(): HubRepo[] {
  return [
    {
      id: "acme/Tiny-Chat-GGUF",
      pipeline: "text-generation",
      tags: ["gguf", "license:apache-2.0", "conversational"],
      files: {
        "tiny-chat-Q4_K_M.gguf": { bytes: chatGguf },
        "tiny-chat-Q8_0.gguf": { bytes: Buffer.concat([chatGguf, Buffer.alloc(4096)]) },
      },
    },
    {
      id: "acme/Tiny-Vision-GGUF",
      pipeline: "image-text-to-text",
      tags: ["gguf", "license:mit"],
      files: {
        "tiny-vision-Q4_K_M.gguf": { bytes: chatGguf },
        "mmproj-tiny-vision-f16.gguf": { bytes: ggufFile({ "general.architecture": "clip" }, 100) },
      },
    },
    {
      id: "acme/Tiny-Embed-GGUF",
      pipeline: "feature-extraction",
      tags: ["gguf", "license:mit", "sentence-transformers"],
      files: { "tiny-embed-F16.gguf": { bytes: chatGguf } },
    },
    {
      id: "acme/Liar-GGUF",
      pipeline: "text-generation",
      tags: ["gguf"],
      files: { "liar-Q4_0.gguf": { bytes: chatGguf, sha256: "0".repeat(64) } },
    },
    {
      id: "acme/Slow-GGUF",
      pipeline: "text-generation",
      tags: ["gguf"],
      files: {
        "slow-Q4_0.gguf": {
          bytes: ggufFile({ "general.architecture": "llama" }, 400_000),
          slow: true,
        },
      },
    },
  ];
}

const OLLAMA_BLOB = ggufFile({ "general.architecture": "llama", "llama.context_length": 2048 });

export const OLLAMA_SEARCH = `<html><body><ul>
<li x-test-model class="flex"><a href="/library/tinyllama"><div><h2><span x-test-search-response-title>tinyllama</span></h2>
<p class="max-w-lg">The TinyLlama project is an open endeavor to train a compact 1.1B Llama model.</p>
<span x-test-size class="x">1.1b</span><span x-test-pull-count>3.2M</span></div></a></li>
<li x-test-model class="flex"><a href="/library/llava"><div><h2>llava</h2>
<p>A vision model &amp; more.</p><span x-test-capability>vision</span>
<span x-test-size>7b</span><span x-test-size>13b</span><span x-test-pull-count>12K</span></div></a></li>
</ul></body></html>`;

export async function fakeHub(repos = defaultRepos()): Promise<FakeHub> {
  const ranges = new Map<string, string[]>();
  const ollamaCalls: FakeHub["ollamaCalls"] = [];
  const ollamaModels: FakeHub["ollamaModels"] = [
    { name: "phi3:mini", size: 2_000_000_000, digest: "abc" },
  ];
  const blobDigest = `sha256:${sha(OLLAMA_BLOB)}`;
  const json = (res: ServerResponse, body: unknown, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const serveBytes = (req: IncomingMessage, res: ServerResponse, key: string, f: HubFile) => {
    const range = req.headers.range;
    if (range) ranges.set(key, [...(ranges.get(key) ?? []), range]);
    const start = range ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0;
    if (start >= f.bytes.length) {
      res.writeHead(416);
      return res.end();
    }
    const body = f.bytes.subarray(start);
    res.writeHead(range ? 206 : 200, {
      "content-type": "application/octet-stream",
      "content-length": String(body.length),
      ...(range
        ? { "content-range": `bytes ${start}-${f.bytes.length - 1}/${f.bytes.length}` }
        : {}),
    });
    if (!f.slow) return res.end(body);
    let at = 0;
    const timer = setInterval(() => {
      if (res.destroyed) return clearInterval(timer);
      res.write(body.subarray(at, at + 20_000));
      at += 20_000;
      if (at >= body.length) {
        clearInterval(timer);
        res.end();
      }
    }, 20);
    res.on("close", () => clearInterval(timer));
  };

  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => {
      raw += d;
    });
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      const path = decodeURIComponent(url.pathname);
      // Hugging Face
      if (path === "/api/models") {
        const q = (url.searchParams.get("search") ?? "").toLowerCase();
        return json(
          res,
          repos
            .filter((r) => r.id.toLowerCase().includes(q))
            .map((r) => ({
              id: r.id,
              downloads: 10,
              likes: 1,
              tags: r.tags,
              pipeline_tag: r.pipeline,
            })),
        );
      }
      const info = /^\/api\/models\/([^/]+\/[^/]+)$/.exec(path);
      if (info) {
        const r = repos.find((x) => x.id === info[1]);
        if (!r) return json(res, { error: "not found" }, 404);
        return json(res, {
          id: r.id,
          downloads: 10,
          likes: 1,
          tags: r.tags,
          pipeline_tag: r.pipeline,
          lastModified: "2026-09-01T00:00:00.000Z",
          siblings: [
            { rfilename: "README.md", size: 10 },
            ...Object.entries(r.files).map(([name, f]) => ({
              rfilename: name,
              size: f.bytes.length,
              lfs: { sha256: f.sha256 ?? sha(f.bytes), size: f.bytes.length },
            })),
          ],
        });
      }
      const file = /^\/([^/]+\/[^/]+)\/resolve\/main\/(.+)$/.exec(path);
      if (file) {
        const f = repos.find((x) => x.id === file[1])?.files[file[2] ?? ""];
        if (!f) return json(res, { error: "not found" }, 404);
        return serveBytes(req, res, file[2] ?? "", f);
      }
      // ollama.com and its registry
      if (path === "/search") {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end(OLLAMA_SEARCH);
      }
      const manifest = /^\/v2\/library\/([\w.-]+)\/manifests\/([\w.-]+)$/.exec(path);
      if (manifest)
        return json(res, {
          layers: [
            {
              mediaType: "application/vnd.ollama.image.model",
              digest: blobDigest,
              size: OLLAMA_BLOB.length,
            },
            { mediaType: "application/vnd.ollama.image.license", digest: "sha256:lic", size: 20 },
          ],
        });
      if (path === "/v2/library/tinyllama/blobs/sha256:lic") {
        res.writeHead(200);
        return res.end("Apache License 2.0\nmore");
      }
      if (path === `/v2/library/tinyllama/blobs/${blobDigest}`)
        return serveBytes(req, res, "tinyllama", { bytes: OLLAMA_BLOB });
      // An Ollama on this computer
      if (path.startsWith("/api/") || path.startsWith("/v1/")) {
        const body = raw ? JSON.parse(raw) : null;
        ollamaCalls.push({ path, body });
        if (path === "/api/version") return json(res, { version: "0.9.0" });
        if (path === "/api/tags") return json(res, { models: ollamaModels });
        if (path === "/api/ps") return json(res, { models: [] });
        if (path === "/api/generate") return json(res, { done: true });
        if (path === "/api/pull") {
          res.writeHead(200, { "content-type": "application/x-ndjson" });
          res.write(`${JSON.stringify({ status: "pulling manifest" })}\n`);
          res.write(
            `${JSON.stringify({ status: "pulling", digest: "d1", total: 1000, completed: 500 })}\n`,
          );
          res.write(
            `${JSON.stringify({ status: "pulling", digest: "d1", total: 1000, completed: 1000 })}\n`,
          );
          ollamaModels.push({ name: (body as { model: string }).model, size: 1000, digest: "d1" });
          return res.end(`${JSON.stringify({ status: "success" })}\n`);
        }
        if (path === "/v1/chat/completions")
          return json(res, {
            choices: [{ message: { role: "assistant", content: "from ollama" } }],
            usage: { completion_tokens: 5 },
          });
      }
      json(res, { error: `no ${path}` }, 404);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    repos,
    ranges,
    ollamaCalls,
    ollamaModels,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
