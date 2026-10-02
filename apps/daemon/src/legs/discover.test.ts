import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverAgents } from "./discover.ts";
import type { LegRow } from "./registry.ts";

const program = (dir: string, name: string, version: string) => {
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\necho "${version} (${name})"\n`, { mode: 0o755 });
  return file;
};

describe("finding agents on this machine", () => {
  it("lists the agents and model servers it finds, with names not yet taken, and says which are Legs already", async () => {
    const root = mkdtempSync(join(tmpdir(), "oraknid-discover-"));
    const bin = join(root, "bin");
    const versions = join(root, "versions");
    mkdirSync(bin);
    mkdirSync(versions);
    // Claude's launcher is a link to a versioned file: the launcher is what a Leg keeps.
    symlinkSync(program(versions, "2.1.0", "2.1.0"), join(bin, "claude"));
    program(bin, "opencode", "2.0.20");
    const server = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "qwen3:8b" }, { id: "llama3.2" }] }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const legs = [
      { name: "Claude", kind: "claude-code", config: { binary: join(bin, "claude") } },
    ] as unknown as LegRow[];
    try {
      const found = await discoverAgents(legs, {
        path: bin,
        home: join(root, "home"),
        servers: [
          { url: `http://127.0.0.1:${port}/v1`, label: "Ollama" },
          { url: "http://127.0.0.1:9/v1", label: "Nothing" },
        ],
      });
      expect(found.map((f) => [f.kind, f.label, f.suggestedName, f.usedBy])).toEqual([
        ["claude-code", "Claude Code 2.1.0", "Claude 2", ["Claude"]],
        ["opencode", "OpenCode 2.0.20", "OpenCode — free models", []],
        ["openai-compatible", "Ollama, 2 models", "Ollama on this machine", []],
      ]);
      expect(found[0]?.config).toEqual({ binary: join(bin, "claude") });
      expect(found[2]?.config).toEqual({ baseUrl: `http://127.0.0.1:${port}/v1` });
      expect(found[2]?.detail).toBe("qwen3:8b, llama3.2");
    } finally {
      server.close();
    }
  });
});
