import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LegEvent, SessionStart } from "@oraknid/leg-sdk";
import { legContract, readUntil } from "@oraknid/leg-sdk/contract";
import { createBwrapSandbox } from "@oraknid/os";
import { afterAll, describe, expect, it } from "vitest";
import { createOraknidAgentAdapter } from "./adapter.ts";
import {
  type ChatRequest,
  contentText,
  type FakeModelServer,
  fakeModelServer,
  probeReply,
  type Reply,
} from "./fake-server.ts";

const servers: FakeModelServer[] = [];
afterAll(async () => {
  for (const s of servers) await s.close();
});

async function serve(
  respond: (req: ChatRequest, n: number) => Reply,
  o: { nativeTools?: boolean; contextWindow?: number } = {},
) {
  const s = await fakeModelServer({
    respond: (req, n) => probeReply(req) ?? respond(req, n),
    ...o,
  });
  servers.push(s);
  return s;
}

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "oraknid-agent-"));
  const work = join(root, "work");
  const home = join(root, "home");
  mkdirSync(work);
  mkdirSync(home);
  return { root, work, home };
}

const sandbox = createBwrapSandbox();
const PATH = "/usr/local/bin:/usr/bin:/bin";

function startFor(
  baseUrl: string,
  over: Partial<SessionStart> = {},
  config: Record<string, unknown> = {},
): SessionStart {
  const w = workspace();
  return {
    leg: { id: "l", name: "Agent", kind: "oraknid-agent", config: { baseUrl, ...config } },
    model: "fake-model",
    effort: null,
    cwd: w.work,
    systemPrompt: "context pack",
    prompt: "do it",
    resumeFrom: null,
    sandbox: { sandbox, home: w.home, writable: [], readonly: [], env: { PATH } },
    credential: null,
    onPermission: async () => ({ allow: true }),
    ...over,
  };
}

const users = (req: ChatRequest) => req.messages.filter((m) => m.role === "user").length;
const turnEnded = (e: LegEvent) => e.type === "turn.ended";

legContract("oraknid-agent (stand-in llama-server, real sandbox)", () => {
  const dir = mkdtempSync(join(tmpdir(), "oraknid-agent-sessions-"));
  const adapter = createOraknidAgentAdapter({ sessionsDir: dir });
  return {
    supportsResume: true,
    async start(script, over) {
      const server = await serve((req) => {
        const last = req.messages.at(-1);
        if (users(req) > 1) return { text: "ok" };
        switch (script) {
          case "rate-limit":
            return { status: 429, headers: { "retry-after": "60" } };
          case "slow":
            return { slow: true };
          case "tool":
            return last?.role === "tool"
              ? { text: "done" }
              : { toolCalls: [{ name: "bash", arguments: { command: "echo hi" } }] };
          default:
            return { text: "ok" };
        }
      });
      return adapter.start(startFor(server.baseUrl, over));
    },
  };
});

describe("oraknid-agent: the loop", () => {
  it("does a task end to end: writes, runs in the sandbox, edits, reads, and reports", async () => {
    const script: Reply[] = [
      {
        toolCalls: [
          {
            name: "todo_write",
            arguments: { todos: [{ content: "write it", status: "in_progress" }] },
          },
        ],
      },
      {
        toolCalls: [
          { name: "write", arguments: { path: "src/app.txt", content: "hello world\n" } },
        ],
      },
      {
        toolCalls: [
          {
            name: "bash",
            arguments: { command: "cat src/app.txt | tr a-z A-Z > upper.txt && echo made" },
          },
        ],
      },
      {
        toolCalls: [
          {
            name: "edit",
            arguments: { path: "src/app.txt", old_string: "world", new_string: "there" },
          },
        ],
      },
      { toolCalls: [{ name: "read", arguments: { path: "src/app.txt" } }] },
      { text: "Done: app.txt says hello there." },
    ];
    let i = 0;
    const server = await serve(() => script[i++] ?? { text: "?" });
    const asked: string[] = [];
    const start = startFor(server.baseUrl, {
      onPermission: async (r) => {
        asked.push(r.tool);
        return { allow: true };
      },
    });
    const s = await createOraknidAgentAdapter().start(start);
    const events = await readUntil(s, turnEnded, 15_000);
    expect(events.at(-1)).toMatchObject({
      type: "turn.ended",
      reason: "completed",
      text: "Done: app.txt says hello there.",
    });
    expect(readFileSync(join(start.cwd, "src/app.txt"), "utf8")).toBe("hello there\n");
    expect(readFileSync(join(start.cwd, "upper.txt"), "utf8")).toBe("HELLO WORLD\n");
    expect(asked).toEqual(["Write", "Bash", "Edit"]);
    // Each call: called, then (for a change) the permission, then its result.
    const kinds = events
      .filter((e) => e.type.startsWith("tool") || e.type === "permission.requested")
      .map((e) => e.type);
    expect(kinds.slice(0, 5)).toEqual([
      "tool.called",
      "tool.result",
      "tool.called",
      "permission.requested",
      "tool.result",
    ]);
    const read = events.filter((e) => e.type === "tool.result").at(-1);
    expect(read).toMatchObject({ ok: true, output: "1\thello there" });
    // The model saw the tools, the preamble and the context pack.
    const first = server.requests.find((r) => !probeReply(r));
    expect(first?.tools?.map((t) => t.function.name)).toEqual([
      "read",
      "edit",
      "write",
      "glob",
      "grep",
      "bash",
      "todo_write",
      "web_fetch",
    ]);
    expect(contentText(first?.messages[0]?.content)).toContain("context pack");
    expect(s.usage().outputTokens).toBeGreaterThan(0);
    await s.kill();
  });

  it("calls tools through a JSON grammar for a model without native tool calls", async () => {
    const script: Reply[] = [
      { toolCalls: [{ name: "write", arguments: { path: "a.txt", content: "from json\n" } }] },
      { text: "Wrote a.txt." },
    ];
    let i = 0;
    const server = await serve(() => script[i++] ?? { text: "?" }, { nativeTools: false });
    const start = startFor(server.baseUrl);
    const s = await createOraknidAgentAdapter().start(start);
    const events = await readUntil(s, turnEnded, 15_000);
    expect(events.at(-1)).toMatchObject({ reason: "completed", text: "Wrote a.txt." });
    expect(readFileSync(join(start.cwd, "a.txt"), "utf8")).toBe("from json\n");
    const sent = server.requests.filter((r) => !probeReply(r));
    expect(sent.every((r) => r.response_format?.type === "json_schema" && !r.tools)).toBe(true);
    // The second request carries the call and its result as plain turns.
    expect(sent[1]?.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(contentText(sent[1]?.messages[3]?.content)).toContain("Result of write");
    await s.kill();
  });

  it("keeps working while its checks fail, and ends once they pass", async () => {
    const server = await serve((req) => {
      const last = contentText(req.messages.at(-1)?.content);
      if (/A check failed/.test(last))
        return { toolCalls: [{ name: "write", arguments: { path: "done.txt", content: "yes" } }] };
      return { text: "All done." };
    });
    const start = startFor(server.baseUrl, { checks: ["test -f done.txt"] });
    const s = await createOraknidAgentAdapter().start(start);
    const events = await readUntil(s, turnEnded, 15_000);
    expect(events.at(-1)).toMatchObject({ reason: "completed" });
    const checks = events.filter((e) => e.type === "tool.called" && e.tool === "check");
    expect(checks).toHaveLength(2);
    const results = events.filter(
      (e): e is Extract<LegEvent, { type: "tool.result" }> =>
        e.type === "tool.result" && e.id.startsWith("check-"),
    );
    expect(results.map((r) => r.ok)).toEqual([false, true]);
    expect(existsSync(join(start.cwd, "done.txt"))).toBe(true);
    expect(
      contentText(server.requests.find((r) => !probeReply(r))?.messages[0]?.content),
    ).toContain("test -f done.txt");
    await s.kill();
  });

  it("resumes a session from its stored history", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oraknid-agent-sessions-"));
    const server = await serve((req) => ({ text: `turn ${users(req)}` }));
    const start = startFor(server.baseUrl, { prompt: "remember the word heron" });
    const first = await createOraknidAgentAdapter({ sessionsDir: dir }).start(start);
    await readUntil(first, turnEnded);
    const id = first.nativeSessionId();
    await first.kill();
    expect(existsSync(join(dir, `${id}.json`))).toBe(true);
    // A new adapter (a restarted daemon) reads it back.
    const again = await createOraknidAgentAdapter({ sessionsDir: dir }).start({
      ...start,
      prompt: "what was the word?",
      resumeFrom: id,
    });
    const end = await readUntil(again, turnEnded);
    expect(end.at(-1)).toMatchObject({ text: "turn 2" });
    const last = server.requests.at(-1);
    expect(last?.messages.map((m) => contentText(m.content)).join("|")).toContain(
      "remember the word heron",
    );
    expect(again.nativeSessionId()).toBe(id);
    await again.kill();
  });

  it("compacts the history near the model's window", async () => {
    let calls = 0;
    const server = await serve((req) => {
      const system = contentText(req.messages[0]?.content);
      if (/You summarise an agent's work/.test(system)) return { text: "SUMMARY: wrote f1..f3" };
      calls++;
      if (calls <= 4)
        return {
          toolCalls: [
            { name: "write", arguments: { path: `f${calls}.txt`, content: "x".repeat(400) } },
          ],
          promptTokens: 300 * calls,
        };
      return { text: "finished" };
    });
    const start = startFor(server.baseUrl, {}, { contextWindow: 1000 });
    const s = await createOraknidAgentAdapter().start(start);
    const events = await readUntil(s, turnEnded, 15_000);
    expect(events.at(-1)).toMatchObject({ reason: "completed", text: "finished" });
    const summarised = server.requests.filter((r) =>
      r.messages.some((m) =>
        contentText(m.content).includes("[Earlier in this session, summarised"),
      ),
    );
    expect(summarised.length).toBeGreaterThan(0);
    expect(contentText(summarised[0]?.messages[1]?.content)).toContain("SUMMARY: wrote f1..f3");
    // The task itself is kept, word for word.
    expect(contentText(summarised[0]?.messages[1]?.content)).toContain("do it");
    await s.kill();
  });

  it("gives a model that can't call tools no tools: text work only", async () => {
    const server = await serve((req) => (probeReply(req) ? { text: "5" } : { text: "a summary" }), {
      nativeTools: false,
    });
    // The probe's add test is answered in words, in both forms.
    const plain = await fakeModelServer({ respond: () => ({ text: "5" }), nativeTools: false });
    servers.push(plain);
    const adapter = createOraknidAgentAdapter();
    const p = await adapter.probe(
      { id: "l", name: "x", kind: "oraknid-agent", config: { baseUrl: plain.baseUrl } },
      null,
    );
    expect(p.models[0]).toMatchObject({
      model: "fake-model",
      toolCalls: "none",
      contextWindow: 8192,
    });
    expect(p.features.tools).toBe(false);
    const s = await adapter.start(startFor(plain.baseUrl));
    const events = await readUntil(s, turnEnded);
    expect(events.at(-1)).toMatchObject({ reason: "completed", text: "5" });
    const sent = plain.requests.at(-1);
    expect(sent?.tools).toBeUndefined();
    expect(contentText(sent?.messages[0]?.content)).toContain("no tools in this session");
    await s.kill();
    void server;
  });

  it("probes: native tool calls, a JSON grammar, the context window, and says plainly when nothing answers", async () => {
    const native = await serve(() => ({ text: "x" }), { contextWindow: 16384 });
    const json = await serve(() => ({ text: "x" }), { nativeTools: false });
    const adapter = createOraknidAgentAdapter();
    const a = await adapter.probe(
      { id: "l", name: "x", kind: "oraknid-agent", config: { baseUrl: native.baseUrl } },
      null,
    );
    expect(a).toMatchObject({ ok: true, features: { tools: true, resume: true } });
    expect(a.models).toEqual([
      {
        model: "fake-model",
        displayName: "fake-model",
        effortLevels: [],
        contextWindow: 16384,
        toolCalls: "native",
      },
    ]);
    const b = await adapter.probe(
      { id: "l", name: "x", kind: "oraknid-agent", config: { baseUrl: json.baseUrl } },
      null,
    );
    expect(b.models[0]?.toolCalls).toBe("json");
    // Tested once a day, not on every health check.
    const before = native.requests.length;
    await adapter.probe(
      { id: "l", name: "x", kind: "oraknid-agent", config: { baseUrl: native.baseUrl } },
      null,
    );
    expect(native.requests.length).toBe(before);
    const dead = await adapter.probe(
      { id: "l", name: "x", kind: "oraknid-agent", config: { baseUrl: "http://127.0.0.1:9/v1" } },
      null,
    );
    expect(dead.ok).toBe(false);
    expect(dead.detail).toMatch(/No OpenAI-compatible server answers at http:\/\/127.0.0.1:9\/v1/);
    const local = await adapter.probe(
      { id: "l", name: "Local", kind: "oraknid-agent", config: { local: true, endpoints: [] } },
      null,
    );
    expect(local).toMatchObject({
      ok: false,
      detail: "No local model is loaded: load one on the Models page.",
    });
  });

  it("uses each model's own address and the key as a bearer token", async () => {
    let auth: string | undefined;
    const server = await serve(() => ({ text: "hi" }));
    const spy: typeof fetch = async (url, init) => {
      auth = new Headers(init?.headers).get("authorization") ?? undefined;
      return fetch(url, init);
    };
    const s = await createOraknidAgentAdapter({ fetch: spy }).start(
      startFor(
        "http://127.0.0.1:9/v1",
        { credential: "sk-1", model: "local-a" },
        {
          baseUrl: null,
          endpoints: [{ model: "local-a", baseUrl: server.baseUrl, toolCalls: "native" }],
        },
      ),
    );
    const events = await readUntil(s, turnEnded);
    expect(events.at(-1)).toMatchObject({ reason: "completed", text: "hi" });
    expect(auth).toBe("Bearer sk-1");
    await s.kill();
  });

  it("writes the file contents it was given even when they hold a dollar sign", async () => {
    const server = await serve((req) =>
      req.messages.at(-1)?.role === "tool"
        ? { text: "ok" }
        : {
            toolCalls: [
              { name: "write", arguments: { path: "p.sh", content: "echo $HOME $$ $&\n" } },
            ],
          },
    );
    const start = startFor(server.baseUrl);
    writeFileSync(join(start.cwd, "keep"), "");
    const s = await createOraknidAgentAdapter().start(start);
    await readUntil(s, turnEnded);
    expect(readFileSync(join(start.cwd, "p.sh"), "utf8")).toBe("echo $HOME $$ $&\n");
    await s.kill();
  });

  it("calls the job's tools through their MCP servers (Oraknid's bridges)", async () => {
    // A tiny stdio MCP server standing in for a bridge to the broker.
    const dir = mkdtempSync(join(tmpdir(), "oraknid-agent-mcp-"));
    const file = join(dir, "echo.mjs");
    writeFileSync(
      file,
      `import { createInterface } from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (m.method === "initialize")
    return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "echo", version: "1" } } });
  if (m.method === "tools/list")
    return send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "echo", description: "Echoes.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] } });
  if (m.method === "tools/call")
    return send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "echo: " + m.params.arguments.text }] } });
  send({ jsonrpc: "2.0", id: m.id, result: {} });
});
`,
    );
    const server = await serve((req) =>
      req.messages.at(-1)?.role === "tool"
        ? { text: "used the tool" }
        : { toolCalls: [{ name: "mcp__oraknid-echo__echo", arguments: { text: "hi" } }] },
    );
    const s = await createOraknidAgentAdapter().start(
      startFor(server.baseUrl, {
        mcpServers: { "oraknid-echo": { command: process.execPath, args: [file] } },
      }),
    );
    const events = await readUntil(s, turnEnded, 15_000);
    expect(events.at(-1)).toMatchObject({ reason: "completed", text: "used the tool" });
    expect(events.find((e) => e.type === "tool.called")).toMatchObject({
      tool: "mcp__oraknid-echo__echo",
      input: { text: "hi" },
    });
    expect(events.find((e) => e.type === "tool.result")).toMatchObject({
      ok: true,
      output: "echo: hi",
    });
    const sent = server.requests.find((r) => !probeReply(r));
    expect(sent?.tools?.map((t) => t.function.name)).toContain("mcp__oraknid-echo__echo");
    await s.kill();
  });
});
