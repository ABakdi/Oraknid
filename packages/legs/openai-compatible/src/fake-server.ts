import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Script } from "@oraknid/leg-sdk/contract";

/** A stand-in OpenAI-compatible server (Ollama-flavoured) following a contract script on the first turn. */
export async function fakeServer(script: Script, opts: { usage?: boolean } = {}) {
  const requests: { messages: { role: string; content?: string }[]; [k: string]: unknown }[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => {
      raw += d;
    });
    req.on("end", () => {
      if (req.url === "/v1/models")
        return json(res, { data: [{ id: "qwen" }, { id: "tiny", max_model_len: 8192 }] });
      if (req.url === "/api/show")
        return json(res, { model_info: { "qwen2.context_length": 32768 } });
      if (req.url !== "/v1/chat/completions") return json(res, {}, 404);
      const body = JSON.parse(raw);
      requests.push(body);
      const users = body.messages.filter((m: { role: string }) => m.role === "user").length;
      const last = body.messages.at(-1);
      const kind: Script = users > 1 ? "reply" : script;

      if (kind === "rate-limit") {
        res.writeHead(429, { "retry-after": "60" });
        return res.end("slow down");
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta: unknown, usage?: unknown) =>
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta }], ...(usage ? { usage } : {}) })}\n\n`,
        );
      const finish = () => {
        if (opts.usage !== false) {
          res.write(
            `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 7 } })}\n\n`,
          );
        }
        res.end("data: [DONE]\n\n");
      };

      if (kind === "slow") {
        const timer = setInterval(() => send({ content: "." }), 10);
        res.on("close", () => clearInterval(timer));
        return;
      }
      if (kind === "tool" && last.role !== "tool") {
        send({
          tool_calls: [
            { index: 0, id: "c1", function: { name: "run_command", arguments: '{"command":' } },
          ],
        });
        send({ tool_calls: [{ index: 0, function: { arguments: '"echo hi"}' } }] });
        return finish();
      }
      send({ content: "o" });
      send({ content: "k" });
      finish();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, requests, close: () => server.close() };
}

function json(res: ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
