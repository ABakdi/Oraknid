#!/usr/bin/env node
// A stand-in for llama.cpp's llama-server in tests (never a real model):
// takes its command line, serves /health, /props, /v1/models, chat
// completions (streamed or not, with tool calls) and embeddings.
import { existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const port = Number(opt("--port"));
const alias = opt("--alias") ?? "model";
const model = opt("--model");
const ctx = Number(opt("--ctx-size") ?? 4096);
if (!model || !existsSync(model)) {
  process.stderr.write(`error: failed to load model '${model}'\n`);
  process.exit(1);
}
// Where a test can read the command line it was given.
if (process.env.FAKE_LLAMA_ARGS) writeFileSync(process.env.FAKE_LLAMA_ARGS, JSON.stringify(args));

const text = (c) =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => p.text ?? "").join("") : "";

function answer(body) {
  const msgs = body.messages ?? [];
  const last = msgs.at(-1) ?? {};
  const all = msgs.map((m) => text(m.content)).join("\n");
  const hasImage = msgs.some(
    (m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image_url"),
  );
  if (/Use the add tool/.test(text(last.content)) && body.tools?.length)
    return { calls: [{ name: "add", arguments: { a: 2, b: 3 } }] };
  if (/Count from 1 to 40/.test(all))
    return { content: "1 2 3 4 5", timings: { predicted_per_second: 42.5 } };
  if (hasImage) return { content: "TEXT FROM IMAGE" };
  if (/Translate the user's text/.test(all)) return { content: `[fr] ${text(last.content)}` };
  if (/Summarise the user's text/.test(all)) return { content: "short summary" };
  if (last.role === "tool") return { content: "done" };
  if (body.tools?.length && /write hello\.txt/.test(all))
    return {
      calls: [{ name: "write", arguments: { path: "hello.txt", content: "hi from local\n" } }],
    };
  return { content: "ok" };
}

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => {
    raw += d;
  });
  req.on("end", () => {
    const json = (b, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(b));
    };
    if (req.url === "/health") return json({ status: "ok" });
    if (req.url === "/props") return json({ default_generation_settings: { n_ctx: ctx } });
    if (req.url === "/v1/models") return json({ data: [{ id: alias }] });
    if (req.url === "/v1/embeddings") {
      const input = JSON.parse(raw).input;
      const list = Array.isArray(input) ? input : [input];
      return json({ data: list.map((t, index) => ({ index, embedding: [t.length, 1, 0] })) });
    }
    if (req.url !== "/v1/chat/completions") return json({ error: "not found" }, 404);
    const body = JSON.parse(raw);
    const a = answer(body);
    const calls = (a.calls ?? []).map((c, i) => ({
      id: `call_${Date.now()}_${i}`,
      type: "function",
      function: { name: c.name, arguments: JSON.stringify(c.arguments) },
    }));
    const usage = { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 };
    const finish = calls.length ? "tool_calls" : "stop";
    if (!body.stream)
      return json({
        id: "x",
        object: "chat.completion",
        created: 1,
        model: alias,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: calls.length ? null : a.content,
              ...(calls.length ? { tool_calls: calls } : {}),
            },
            finish_reason: finish,
          },
        ],
        usage,
        ...(a.timings ? { timings: a.timings } : {}),
      });
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta, finish_reason = null, extra = {}) =>
      res.write(
        `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: alias, choices: [{ index: 0, delta, finish_reason }], ...extra })}\n\n`,
      );
    chunk({ role: "assistant", content: "" });
    if (calls.length)
      for (const [index, c] of calls.entries()) chunk({ tool_calls: [{ index, ...c }] });
    else chunk({ content: a.content });
    chunk({}, finish);
    res.write(
      `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: alias, choices: [], usage })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
  });
});
server.listen(port, "127.0.0.1");
for (const s of ["SIGTERM", "SIGINT"]) process.on(s, () => server.close(() => process.exit(0)));
