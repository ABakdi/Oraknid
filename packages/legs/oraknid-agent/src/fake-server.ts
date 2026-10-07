import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// A stand-in llama-server for tests: OpenAI chat completions (streamed or
// not) with tool calls, /v1/models, /props and /health. Each request is
// answered by a script; never a real model.

export interface ChatRequest {
  model: string;
  messages: { role: string; content?: unknown; tool_calls?: unknown[]; tool_call_id?: string }[];
  tools?: { function: { name: string } }[];
  stream?: boolean;
  response_format?: { type: string; json_schema?: unknown };
  [k: string]: unknown;
}

export interface Reply {
  text?: string;
  toolCalls?: { name: string; arguments: Record<string, unknown> }[];
  /** Streams "." until the client goes away. */
  slow?: boolean;
  status?: number;
  headers?: Record<string, string>;
  /** Report usage (default true). */
  usage?: boolean;
  promptTokens?: number;
}

export interface FakeModelServer {
  baseUrl: string;
  port: number;
  requests: ChatRequest[];
  close(): Promise<void>;
}

export interface FakeOptions {
  /** Answers each chat request; `n` counts them from 0. */
  respond: (req: ChatRequest, n: number) => Reply;
  /** Native tool calls (default true). Without: tools are ignored and JSON grammars honoured. */
  nativeTools?: boolean;
  models?: string[];
  contextWindow?: number;
}

/** The text of a message's content, whatever its shape. */
export const contentText = (c: unknown): string =>
  typeof c === "string"
    ? c
    : Array.isArray(c)
      ? c.map((p) => (p as { text?: string }).text ?? "").join("")
      : "";

/** Answers the probe's tool test like a model that can (or can't) call tools. */
export function probeReply(req: ChatRequest): Reply | null {
  const last = contentText(req.messages.at(-1)?.content);
  if (!/Use the add tool/.test(last)) return null;
  return { toolCalls: [{ name: "add", arguments: { a: 2, b: 3 } }] };
}

export async function fakeModelServer(o: FakeOptions): Promise<FakeModelServer> {
  const requests: ChatRequest[] = [];
  const native = o.nativeTools ?? true;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => {
      raw += d;
    });
    req.on("end", () => {
      const url = req.url ?? "";
      if (url === "/health") return json(res, { status: "ok" });
      if (url === "/props")
        return json(res, { default_generation_settings: { n_ctx: o.contextWindow ?? 8192 } });
      if (url === "/v1/models")
        return json(res, { data: (o.models ?? ["fake-model"]).map((id) => ({ id })) });
      if (url !== "/v1/chat/completions") return json(res, { error: "not found" }, 404);
      const body = JSON.parse(raw) as ChatRequest;
      const n = requests.length;
      requests.push(body);
      let r = o.respond(body, n);
      if (r.status && r.status !== 200) {
        res.writeHead(r.status, { "content-type": "application/json", ...r.headers });
        return res.end(JSON.stringify({ error: { message: `fake ${r.status}` } }));
      }
      const grammar = body.response_format?.type === "json_schema";
      if (!native && r.toolCalls?.length && !grammar)
        r = { ...r, toolCalls: [], text: r.text ?? "I would call a tool." };
      let content = r.text ?? "";
      let calls = native || !grammar ? (r.toolCalls ?? []) : [];
      if (!native && grammar) {
        const call = r.toolCalls?.[0];
        content = JSON.stringify(
          call ? { tool: call.name, arguments: call.arguments } : { answer: content },
        );
        calls = [];
      }
      if (!body.tools?.length && native) calls = [];
      const usage = {
        prompt_tokens: r.promptTokens ?? 100 + n,
        completion_tokens: 7,
        total_tokens: (r.promptTokens ?? 100 + n) + 7,
      };
      const wire = calls.map((c, i) => ({
        id: `call_${n}_${i}`,
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.arguments) },
      }));
      const finish = wire.length ? "tool_calls" : "stop";
      if (!body.stream) {
        return json(res, {
          id: `cmpl-${n}`,
          object: "chat.completion",
          created: 1,
          model: body.model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: wire.length ? null : content,
                ...(wire.length ? { tool_calls: wire } : {}),
              },
              finish_reason: finish,
            },
          ],
          ...(r.usage === false ? {} : { usage }),
        });
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: unknown, finish_reason: string | null = null, extra = {}) =>
        res.write(
          `data: ${JSON.stringify({ id: `cmpl-${n}`, object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }], ...extra })}\n\n`,
        );
      if (r.slow) {
        chunk({ role: "assistant", content: "" });
        const timer = setInterval(() => chunk({ content: "." }), 10);
        res.on("close", () => clearInterval(timer));
        return;
      }
      chunk({ role: "assistant", content: "" });
      if (!wire.length)
        for (const piece of content.match(/.{1,3}/gs) ?? []) chunk({ content: piece });
      wire.forEach((c, index) => {
        const args = c.function.arguments;
        const cut = Math.floor(args.length / 2);
        chunk({
          tool_calls: [
            {
              index,
              id: c.id,
              type: "function",
              function: { name: c.function.name, arguments: args.slice(0, cut) },
            },
          ],
        });
        chunk({ tool_calls: [{ index, function: { arguments: args.slice(cut) } }] });
      });
      chunk({}, finish);
      if (r.usage !== false)
        res.write(
          `data: ${JSON.stringify({ id: `cmpl-${n}`, object: "chat.completion.chunk", created: 1, model: body.model, choices: [], usage })}\n\n`,
        );
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    port,
    requests,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

function json(res: ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
