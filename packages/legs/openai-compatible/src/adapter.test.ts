import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionStart } from "@oraknid/leg-sdk";
import { legContract, readUntil } from "@oraknid/leg-sdk/contract";
import { createBwrapSandbox, sandboxForTests } from "@oraknid/os";
import { afterAll, describe, expect, it } from "vitest";
import { createOpenAICompatibleAdapter } from "./adapter.ts";
import { fakeServer } from "./fake-server.ts";
import { inside, runTool } from "./tools.ts";

const servers: { close(): void }[] = [];
afterAll(() => {
  for (const s of servers) s.close();
});

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "oraknid-oai-"));
  const work = join(root, "work");
  const home = join(root, "home");
  mkdirSync(work);
  mkdirSync(home);
  return { root, work, home };
}

// The real sandbox where it works; a CI runner without one runs the commands as they are.
const { sandbox, isolated } = sandboxForTests(createBwrapSandbox());

function startFor(baseUrl: string, over: Partial<SessionStart> = {}): SessionStart {
  const w = workspace();
  return {
    leg: { id: "l", name: "Ollama", kind: "openai-compatible", config: { baseUrl } },
    model: "qwen",
    effort: null,
    cwd: w.work,
    systemPrompt: "context pack",
    prompt: "do it",
    resumeFrom: null,
    sandbox: { sandbox, home: w.home, writable: [], readonly: [], env: { PATH: "/usr/bin" } },
    credential: null,
    onPermission: async () => ({ allow: true }),
    ...over,
  };
}

legContract("OpenAI-compatible (stand-in server, real sandbox)", () => ({
  supportsResume: false,
  async start(script, over) {
    const server = await fakeServer(script);
    servers.push(server);
    return createOpenAICompatibleAdapter().start(startFor(server.baseUrl, over));
  },
}));

describe("OpenAI-compatible adapter", () => {
  it("lists models with their context windows", async () => {
    const server = await fakeServer("reply");
    servers.push(server);
    const p = await createOpenAICompatibleAdapter().probe(
      { id: "l", name: "o", kind: "openai-compatible", config: { baseUrl: server.baseUrl } },
      null,
    );
    expect(p.ok).toBe(true);
    expect(p.models.map((m) => [m.model, m.contextWindow])).toEqual([
      ["qwen", 32768],
      ["tiny", 8192],
    ]);
    expect(p.models.map((m) => m.toolCalls)).toEqual(["native", "native"]);
    expect(p.features.tools).toBe(true);
  });

  it("tests tool calling instead of assuming it", async () => {
    const server = await fakeServer("reply", { tools: false });
    servers.push(server);
    const p = await createOpenAICompatibleAdapter().probe(
      { id: "l", name: "o", kind: "openai-compatible", config: { baseUrl: server.baseUrl } },
      null,
    );
    expect(p.models.map((m) => m.toolCalls)).toEqual(["none", "none"]);
    expect(p.features.tools).toBe(false);
    expect(p.detail).toMatch(/2 without tool calls, kept to text work/);
  });

  it("says plainly when no server answers", async () => {
    const p = await createOpenAICompatibleAdapter().probe(
      {
        id: "l",
        name: "o",
        kind: "openai-compatible",
        config: { baseUrl: "http://127.0.0.1:9/v1" },
      },
      null,
    );
    expect(p.ok).toBe(false);
    expect(p.detail).toMatch(/No OpenAI-compatible server answers at http:\/\/127.0.0.1:9\/v1/);
  });

  it("sends the context pack as the system message and the tools, and keeps the session's history", async () => {
    const server = await fakeServer("tool");
    servers.push(server);
    const s = await createOpenAICompatibleAdapter().start(startFor(server.baseUrl));
    await readUntil(s, (e) => e.type === "turn.ended");
    const second = server.requests[1];
    expect(second?.messages[0]).toEqual({ role: "system", content: "context pack" });
    expect(second?.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect((second?.tools as unknown[] | undefined)?.length).toBe(6);
    await s.kill();
  });

  it("estimates usage when the server reports none, and says so", async () => {
    const server = await fakeServer("reply", { usage: false });
    servers.push(server);
    const s = await createOpenAICompatibleAdapter().start(startFor(server.baseUrl));
    await readUntil(s, (e) => e.type === "turn.ended");
    expect(s.usage().estimated).toBe(true);
    expect(s.usage().outputTokens).toBeGreaterThan(0);
    await s.kill();
  });

  it("passes the API key only as a bearer token", async () => {
    let auth: string | undefined;
    const server = await fakeServer("reply");
    servers.push(server);
    const spy: typeof fetch = async (url, init) => {
      auth = (init?.headers as Record<string, string> | undefined)?.authorization;
      return fetch(url, init);
    };
    const s = await createOpenAICompatibleAdapter({ fetch: spy }).start(
      startFor(server.baseUrl, { credential: "sk-local" }),
    );
    await readUntil(s, (e) => e.type === "turn.ended");
    expect(auth).toBe("Bearer sk-local");
    await s.kill();
  });
});

describe("tools stay inside the workspace", () => {
  const ctx = (cwd: string, home: string) => ({
    cwd,
    sandbox: { sandbox, home, writable: [], readonly: [], env: { PATH: "/usr/bin" } },
    signal: new AbortController().signal,
    commandTimeoutMs: 10_000,
  });

  it("refuses paths that climb out, absolute or through a symlink", () => {
    const w = workspace();
    writeFileSync(join(w.root, "secret"), "x");
    symlinkSync(w.root, join(w.work, "escape"));
    expect(() => inside(w.work, "../secret")).toThrow(/outside the workspace/);
    expect(() => inside(w.work, join(w.root, "secret"))).toThrow(/outside the workspace/);
    expect(() => inside(w.work, "escape/secret")).toThrow(/outside the workspace/);
    expect(() => inside(w.work, "escape/new-file")).toThrow(/outside the workspace/);
    expect(inside(w.work, "src/new.ts")).toBe(join(w.work, "src/new.ts"));
  });

  it("writes, edits, reads and lists files", async () => {
    const w = workspace();
    const c = ctx(w.work, w.home);
    await runTool(c, "write_file", { path: "a/b.txt", content: "hello world" });
    await runTool(c, "edit_file", { path: "a/b.txt", old_text: "world", new_text: "there" });
    expect(await runTool(c, "read_file", { path: "a/b.txt" })).toBe("hello there");
    expect(await runTool(c, "list_dir", { path: "." })).toBe("a/");
    await expect(
      runTool(c, "edit_file", { path: "a/b.txt", old_text: "nope", new_text: "" }),
    ).rejects.toThrow(/not found/);
  });

  it.runIf(isolated)(
    "runs commands in the sandbox, which cannot see outside the workspace",
    async () => {
      const w = workspace();
      writeFileSync(join(w.root, "secret"), "do not read");
      const c = ctx(w.work, w.home);
      expect(await runTool(c, "run_command", { command: "echo hi > out.txt && cat out.txt" })).toBe(
        "hi\n[exit 0]",
      );
      expect(readFileSync(join(w.work, "out.txt"), "utf8")).toBe("hi\n");
      const leak = await runTool(c, "run_command", { command: `cat ${join(w.root, "secret")}` });
      expect(leak).not.toContain("do not read");
      expect(leak).toMatch(/\[exit 1\]$/);
    },
  );

  it("searches file contents", async () => {
    const w = workspace();
    writeFileSync(join(w.work, "x.ts"), "const needle = 1;\n");
    expect(
      await runTool(ctx(w.work, w.home), "search", { pattern: "needle", path: "." }),
    ).toContain("x.ts:1:const needle = 1;");
  });
});
