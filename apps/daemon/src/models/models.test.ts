import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MachineReading } from "@oraknid/core";
import { createOraknidAgentAdapter } from "@oraknid/leg-oraknid-agent";
import { readUntil } from "@oraknid/leg-sdk/contract";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Router } from "../api/router.ts";
import { type Daemon, startDaemon } from "../daemon.ts";
import { resolvePaths } from "../paths.ts";
import { type FakeHub, fakeHub, OLLAMA_SEARCH } from "../testing/fake-model-hub.ts";
import { fakeOs } from "../testing/fake-os.ts";
import { kindsOf, parseOllamaSearch, quantOf } from "./catalog.ts";
import { download } from "./download.ts";
import { fitOf, type MachineRoom, runPlan } from "./fit.ts";
import { ggufBytes, readGguf } from "./gguf.ts";
import { llamaArgs } from "./runtime.ts";
import { modelName } from "./service.ts";
import { modelsServer } from "./tool.ts";

const GB = 1024 ** 3;
const FAKE_LLAMA = join(
  dirname(fileURLToPath(import.meta.url)),
  "../testing/fake-llama-server.mjs",
);
beforeAll(() => chmodSync(FAKE_LLAMA, 0o755));

const machine = (o: Partial<MachineRoom> = {}): MachineRoom => ({
  gpus: [{ name: "RTX", totalBytes: 12 * GB, usedBytes: 1 * GB }],
  memoryTotal: 32 * GB,
  memoryAvailable: 24 * GB,
  diskFree: 200 * GB,
  minFreeDisk: 2 * GB,
  ...o,
});

describe("finding models", () => {
  it("reads quantisation, kinds and Ollama's search page", () => {
    expect(quantOf("Qwen2.5-7B-Instruct-Q4_K_M.gguf")).toBe("Q4_K_M");
    expect(quantOf("model-IQ3_XS-00001-of-00002.gguf")).toBe("IQ3_XS");
    expect(quantOf("phi-3-mini.f16.gguf")).toBe("F16");
    expect(quantOf("model.gguf")).toBeNull();
    expect(kindsOf("image-text-to-text", [])).toEqual(["vision", "text"]);
    expect(kindsOf("feature-extraction", [])).toEqual(["embedding"]);
    expect(kindsOf("automatic-speech-recognition", [])).toEqual(["speech"]);
    expect(kindsOf(undefined, ["gguf"])).toEqual(["text"]);
    expect(parseOllamaSearch(OLLAMA_SEARCH)).toEqual([
      {
        name: "tinyllama",
        description:
          "The TinyLlama project is an open endeavor to train a compact 1.1B Llama model.",
        capabilities: [],
        sizes: ["1.1b"],
        pulls: 3_200_000,
      },
      {
        name: "llava",
        description: "A vision model & more.",
        capabilities: ["vision"],
        sizes: ["7b", "13b"],
        pulls: 12_000,
      },
    ]);
    expect(modelName("Qwen2.5-7B-Instruct-GGUF", "Q4_K_M")).toBe("qwen2.5-7b-instruct:q4_k_m");
  });

  it("says whether a file fits: the GPU, split, the CPU, or not at all", () => {
    expect(fitOf(4 * GB, machine())).toMatchObject({ fits: "yes", runsOn: "gpu" });
    expect(fitOf(14 * GB, machine())).toMatchObject({ fits: "tight", runsOn: "split" });
    expect(fitOf(14 * GB, machine({ gpus: [] }))).toMatchObject({ fits: "tight", runsOn: "cpu" });
    expect(fitOf(2 * GB, machine({ gpus: [] }))).toMatchObject({ fits: "yes", runsOn: "cpu" });
    expect(fitOf(60 * GB, machine())).toMatchObject({ fits: "no" });
    expect(fitOf(60 * GB, machine()).note).toMatch(/Too big/);
    expect(fitOf(4 * GB, machine({ diskFree: 5 * GB })).note).toMatch(/Not enough disk/);
    expect(fitOf(null, machine()).fits).toBe("unknown");
  });

  it("plans GPU layers and context automatically, and keeps mine", () => {
    const whole = runPlan(4 * GB, { layers: 32, contextLength: 32_768 }, machine(), {
      contextSize: "auto",
      gpuLayers: "auto",
    });
    expect(whole).toMatchObject({ gpuLayers: 999, gpuIndex: 0 });
    expect(whole.contextSize).toBeGreaterThanOrEqual(8192);
    const split = runPlan(14 * GB, { layers: 40, contextLength: 8192 }, machine(), {
      contextSize: "auto",
      gpuLayers: "auto",
    });
    expect(split.gpuLayers).toBeGreaterThan(0);
    expect(split.gpuLayers).toBeLessThan(40);
    expect(split.contextSize).toBe(8192);
    const cpu = runPlan(4 * GB, { layers: 32, contextLength: null }, machine({ gpus: [] }), {
      contextSize: 4096,
      gpuLayers: "auto",
    });
    expect(cpu).toMatchObject({ gpuLayers: 0, contextSize: 4096, vramBytes: 0, gpuIndex: null });
    expect(
      llamaArgs({
        binary: "llama-server",
        model: "/m.gguf",
        projector: "/p.gguf",
        alias: "m",
        port: 5,
        contextSize: 4096,
        gpuLayers: 999,
        embeddings: true,
        logFile: "/l",
      }),
    ).toEqual([
      "--model",
      "/m.gguf",
      "--alias",
      "m",
      "--host",
      "127.0.0.1",
      "--port",
      "5",
      "--ctx-size",
      "4096",
      "--n-gpu-layers",
      "999",
      "--jinja",
      "--mmproj",
      "/p.gguf",
      "--embeddings",
    ]);
  });

  it("reads a GGUF file's context length and layers, skipping its big arrays", () => {
    const dir = mkdtempSync(join(tmpdir(), "oraknid-gguf-"));
    const file = join(dir, "m.gguf");
    writeFileSync(
      file,
      ggufBytes({
        "general.architecture": "qwen2",
        "general.name": "Q",
        "qwen2.context_length": 32768,
        "qwen2.block_count": 28,
      }),
    );
    expect(readGguf(file)).toEqual({
      architecture: "qwen2",
      name: "Q",
      contextLength: 32768,
      layers: 28,
    });
    writeFileSync(join(dir, "x.bin"), "not a gguf");
    expect(readGguf(join(dir, "x.bin"))).toBeNull();
  });
});

describe("downloading", () => {
  let hub: FakeHub;
  afterEach(async () => hub?.close());

  it("resumes a paused download where it stopped, and checks the checksum", async () => {
    hub = await fakeHub();
    const dir = mkdtempSync(join(tmpdir(), "oraknid-dl-"));
    const dest = join(dir, "slow.gguf");
    const url = `${hub.url}/acme/Slow-GGUF/resolve/main/slow-Q4_0.gguf`;
    const bytes = hub.repos.find((r) => r.id === "acme/Slow-GGUF")?.files["slow-Q4_0.gguf"]
      ?.bytes as Buffer;
    const { createHash } = await import("node:crypto");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const abort = new AbortController();
    let seen = 0;
    await expect(
      download({
        url,
        dest,
        sha256,
        signal: abort.signal,
        onProgress: (done) => {
          seen = done;
          if (done > 50_000) abort.abort();
        },
      }),
    ).rejects.toThrow();
    expect(existsSync(`${dest}.part`)).toBe(true);
    expect(seen).toBeGreaterThan(0);
    const progress: number[] = [];
    await download({ url, dest, sha256, onProgress: (d) => progress.push(d) });
    expect(readFileSync(dest).equals(bytes)).toBe(true);
    expect(hub.ranges.get("slow-Q4_0.gguf")?.[0]).toMatch(/^bytes=\d+-$/);
    expect(progress.at(-1)).toBe(bytes.length);
    // A file that isn't what its source says is removed, and said so.
    await expect(
      download({ url, dest: join(dir, "liar.gguf"), sha256: "0".repeat(64) }),
    ).rejects.toThrow(/checksum doesn't match/);
    expect(existsSync(join(dir, "liar.gguf.part"))).toBe(false);
  });
});

// ── Through the daemon: find, download, load, use, unload ──────────────

let daemon: Daemon | undefined;
let hubs: FakeHub[] = [];
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  for (const h of hubs) await h.close();
  hubs = [];
});

const roomy = (gpuUsed = 1 * GB, memoryAvailable = 24 * GB): MachineReading => ({
  cores: 8,
  cpu: 0.1,
  memoryTotal: 32 * GB,
  memoryAvailable,
  swapTotal: 0,
  swapUsed: 0,
  swapInPerSec: 0,
  load1: 0.5,
  pressure: null,
  disks: [],
  oomKills: null,
  thermalThrottles: null,
  ownRss: 0,
  ownCpu: 0,
  gpus: [{ name: "RTX", usedBytes: gpuUsed, totalBytes: 12 * GB }],
});

async function start(
  o: { llama?: boolean; ollama?: boolean; reading?: () => MachineReading } = {},
) {
  const hub = await fakeHub();
  hubs.push(hub);
  const dir = mkdtempSync(join(tmpdir(), "oraknid-models-"));
  const fake = fakeOs({ keychain: true });
  let reading = o.reading ?? (() => roomy());
  daemon = await startDaemon({
    paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
    port: 0,
    dbFile: ":memory:",
    os: fake.os,
    healthIntervalMs: 60_000,
    machineReading: () => reading(),
    models: {
      catalog: { huggingface: hub.url, ollamaWeb: hub.url, ollamaRegistry: hub.url },
      ollamaUrl: o.ollama ? hub.url : null,
      programs: { llamaServer: () => (o.llama === false ? null : FAKE_LLAMA), whisper: () => null },
      loadTimeoutMs: 20_000,
    },
  });
  const api = createORPCClient<RouterClient<Router>>(
    new RPCLink({
      url: `${daemon.url}/api`,
      headers: { authorization: `Bearer ${daemon.cliToken}` },
    }),
  );
  return {
    d: daemon,
    api,
    hub,
    dir,
    setReading: (r: () => MachineReading) => {
      reading = r;
    },
  };
}

const until = async (cond: () => boolean | Promise<boolean>, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

async function downloaded(
  api: Awaited<ReturnType<typeof start>>["api"],
  repo: string,
  file: string,
) {
  const m = await api.models.download({ source: "huggingface", repo, file });
  await until(
    async () => (await api.models.list()).find((x) => x.id === m.id)?.state !== "downloading",
  );
  const done = (await api.models.list()).find((x) => x.id === m.id);
  if (!done) throw new Error("gone");
  return done;
}

describe("local models through the daemon", () => {
  it("searches, downloads, loads a model as the Local Leg's, runs Oraknid's agent on it, and unloads it", async () => {
    const { api, d } = await start();
    const found = await api.models.search({ query: "tiny-chat", source: "huggingface" });
    expect(found.problems).toEqual([]);
    const entry = found.entries[0];
    expect(entry).toMatchObject({
      id: "acme/Tiny-Chat-GGUF",
      license: "apache-2.0",
      kinds: ["text"],
    });
    expect(entry?.files.map((f) => [f.name, f.quant, f.fit.fits, f.fit.runsOn])).toEqual([
      ["tiny-chat-Q4_K_M.gguf", "Q4_K_M", "yes", "gpu"],
      ["tiny-chat-Q8_0.gguf", "Q8_0", "yes", "gpu"],
    ]);

    const m = await downloaded(api, "acme/Tiny-Chat-GGUF", "tiny-chat-Q4_K_M.gguf");
    expect(m).toMatchObject({
      state: "ready",
      name: "tiny-chat:q4_k_m",
      runner: "llama.cpp",
      quant: "Q4_K_M",
      contextLength: 4096,
      license: "apache-2.0",
    });

    const loaded = await api.models.load({ id: m.id });
    expect(loaded).toMatchObject({ state: "loaded", tokensPerSec: 42.5, toolCalls: "native" });
    expect(loaded.loaded?.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    expect(loaded.loaded?.gpuLayers).toBe(999);

    // The Local Leg offers it, healthy, as a model that calls tools.
    const status = await api.models.status();
    expect(status.legId).toBeTruthy();
    const leg = await api.legs.get({ id: status.legId as string });
    expect(leg).toMatchObject({
      kind: "oraknid-agent",
      name: "Local",
      health: "healthy",
      remote: false,
    });
    expect(leg.models.map((x) => x.model)).toEqual(["tiny-chat:q4_k_m"]);
    expect(leg.models[0]?.profile.tools.edits).toBe(true);

    // Oraknid's own agent does a task on it, end to end.
    const row = d.registry.require(leg.id);
    const cwd = mkdtempSync(join(tmpdir(), "oraknid-local-work-"));
    const s = await createOraknidAgentAdapter().start({
      leg: d.registry.toConfig(row),
      model: "tiny-chat:q4_k_m",
      effort: null,
      cwd,
      systemPrompt: "pack",
      prompt: "Please write hello.txt",
      resumeFrom: null,
      sandbox: null,
      credential: null,
      onPermission: async () => ({ allow: true }),
    });
    const events = await readUntil(s, (e) => e.type === "turn.ended", 15_000);
    expect(events.at(-1)).toMatchObject({ reason: "completed", text: "done" });
    expect(readFileSync(join(cwd, "hello.txt"), "utf8")).toBe("hi from local\n");
    await s.kill();

    const unloaded = await api.models.unload({ id: m.id });
    expect(unloaded.state).toBe("ready");
    const after = await api.legs.get({ id: leg.id });
    expect(after.health).toBe("unavailable");
    expect(after.healthDetail).toMatch(/No local model is loaded/);
  });

  it("gives roles, and every agent's tool uses them: translate, summarise, OCR, embed", async () => {
    const { api, d, dir } = await start();
    const chat = await downloaded(api, "acme/Tiny-Chat-GGUF", "tiny-chat-Q4_K_M.gguf");
    const vision = await downloaded(api, "acme/Tiny-Vision-GGUF", "tiny-vision-Q4_K_M.gguf");
    const embed = await downloaded(api, "acme/Tiny-Embed-GGUF", "tiny-embed-F16.gguf");
    expect(vision.kinds).toContain("vision");
    expect(embed.kinds).toEqual(["embedding"]);
    // Suggested for this computer until I choose.
    let status = await api.models.status();
    expect(status.roles).toMatchObject({
      translate: chat.id,
      ocr: vision.id,
      embed: embed.id,
      transcribe: null,
    });
    status = await api.models.setRole({ role: "translate", id: vision.id });
    expect(status.roles.translate).toBe(vision.id);
    await expect(api.models.setRole({ role: "embed", id: chat.id })).rejects.toThrow(
      /isn't a embedding model/,
    );
    await api.models.setRole({ role: "translate", id: chat.id });

    // The tool, as the broker runs it for a job's session.
    const tool = modelsServer(d.models)({ jobId: null });
    const call = async (name: string, args: Record<string, unknown>) =>
      (
        await tool({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        })
      )?.result;
    expect((await call("translate", { text: "hello", to: "French" }))?.content?.[0]?.text).toBe(
      "[fr] hello",
    );
    expect((await call("summarize", { text: "long text" }))?.content?.[0]?.text).toBe(
      "short summary",
    );
    const vectors = JSON.parse(
      (await call("embed", { texts: ["ab", "abcd"] }))?.content?.[0]?.text ?? "{}",
    );
    expect(vectors.vectors).toEqual([
      [2, 1, 0],
      [4, 1, 0],
    ]);
    // OCR reads only the job's own files.
    const outside = await call("ocr", { path: join(dir, "x.png") });
    expect(outside?.isError).toBe(true);
    // The translate role's model loaded on demand: a model of the Local Leg now.
    expect((await api.models.list()).find((x) => x.id === chat.id)?.state).toBe("loaded");
    // The vision model was loaded with its projector.
    const visionRow = (await api.models.list()).find((x) => x.id === vision.id);
    expect(visionRow?.state).toBe("ready");
    expect(existsSync(join(dir, "models", vision.id, "mmproj-tiny-vision-f16.gguf"))).toBe(true);
    const list = await api.tools.list();
    expect(list.some((t) => t.name === "local-models" && t.builtIn)).toBe(true);
  });

  it("refuses a load the machine has no room for, and unloads idle models to make room", async () => {
    const { api, setReading } = await start();
    const a = await downloaded(api, "acme/Tiny-Chat-GGUF", "tiny-chat-Q4_K_M.gguf");
    setReading(() => roomy(11.5 * GB, 1 * GB));
    await expect(api.models.load({ id: a.id })).rejects.toThrow(
      /can't load now: not enough (GPU )?memory/,
    );
    setReading(() => roomy());
    await api.models.load({ id: a.id });
    // Under danger, an idle model is the first thing to go.
    expect(await daemon?.models.relieve()).toBe(
      "Unloaded the idle model tiny-chat:q4_k_m to free memory.",
    );
    expect((await api.models.list())[0]?.state).toBe("ready");
  });

  it("says a checksum mismatch, and removes a model with its files", async () => {
    const { api, dir } = await start();
    const liar = await downloaded(api, "acme/Liar-GGUF", "liar-Q4_0.gguf");
    expect(liar.state).toBe("failed");
    expect(liar.error).toMatch(/checksum doesn't match/);
    const ok = await downloaded(api, "acme/Tiny-Chat-GGUF", "tiny-chat-Q4_K_M.gguf");
    expect(existsSync(join(dir, "models", ok.id))).toBe(true);
    await api.models.remove({ id: ok.id });
    expect(existsSync(join(dir, "models", ok.id))).toBe(false);
    expect((await api.models.list()).map((m) => m.id)).toEqual([liar.id]);
  });

  it("pauses and resumes a download", async () => {
    const { api, hub } = await start();
    const m = await api.models.download({
      source: "huggingface",
      repo: "acme/Slow-GGUF",
      file: "slow-Q4_0.gguf",
    });
    await until(async () => ((await api.models.list())[0]?.download?.doneBytes ?? 0) > 0);
    await api.models.pause({ id: m.id });
    await until(async () => (await api.models.list())[0]?.state === "paused");
    await api.models.resume({ id: m.id });
    await until(async () => (await api.models.list())[0]?.state === "ready");
    expect(hub.ranges.get("slow-Q4_0.gguf")?.some((r) => /^bytes=[1-9]\d*-$/.test(r))).toBe(true);
  });

  it("downloads an Ollama library model from its registry for llama.cpp, its digest checked", async () => {
    const { api } = await start();
    const found = await api.models.search({ query: "tiny", source: "ollama" });
    expect(found.entries.map((e) => e.id)).toEqual(["tinyllama", "llava"]);
    expect(found.entries[1]?.kinds).toEqual(["text", "vision"]);
    expect(found.entries[0]?.files[0]).toMatchObject({ name: "1.1b", fit: { fits: "yes" } });
    const details = await api.models.details({ source: "ollama", id: "tinyllama" });
    expect(details.license).toBe("Apache License 2.0");
    const m = await api.models.download({ source: "ollama", repo: "tinyllama", file: "1.1b" });
    await until(async () => (await api.models.list())[0]?.state === "ready");
    expect((await api.models.list())[0]).toMatchObject({
      name: "tinyllama:1.1b",
      runner: "llama.cpp",
      contextLength: 2048,
    });
    expect(m.license).toBe("Apache License 2.0");
  });

  it("uses an Ollama already here when llama-server isn't installed: its models, pulls and loads", async () => {
    const { api, hub } = await start({ llama: false, ollama: true });
    await until(async () => (await api.models.list()).some((m) => m.name === "phi3:mini"));
    const status = await api.models.status();
    expect(status.runtimes).toMatchObject({ llamaServer: null, ollama: hub.url });
    const m = await api.models.download({ source: "ollama", repo: "tinyllama", file: "1.1b" });
    expect(m.runner).toBe("ollama");
    await until(
      async () => (await api.models.list()).find((x) => x.id === m.id)?.state === "ready",
    );
    expect(hub.ollamaCalls.some((c) => c.path === "/api/pull")).toBe(true);
    const loaded = await api.models.load({ id: m.id });
    expect(loaded.loaded?.baseUrl).toBe(`${hub.url}/v1`);
    expect(hub.ollamaCalls.find((c) => c.path === "/api/generate")?.body).toMatchObject({
      model: "tinyllama:1.1b",
    });
    await api.models.unload({ id: m.id });
    expect(hub.ollamaCalls.filter((c) => c.path === "/api/generate").at(-1)?.body).toMatchObject({
      keep_alive: 0,
    });
  });

  it("says plainly when llama-server isn't installed", async () => {
    const { api } = await start({ llama: false });
    const m = await downloaded(api, "acme/Tiny-Chat-GGUF", "tiny-chat-Q4_K_M.gguf");
    await expect(api.models.load({ id: m.id })).rejects.toThrow(/install\.sh --local-models/);
  });
});

void mkdirSync;
