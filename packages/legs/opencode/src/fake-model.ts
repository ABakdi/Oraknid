import { createServer, type Server } from "node:http";

export type FakeMode = "reply" | "slow" | "tool" | "rate-limit";

/**
 * A stand-in OpenAI-compatible model for tests: OpenCode really runs,
 * only the model is fake (ADR-015). The mode says how it answers.
 */
export async function startFakeModel(): Promise<{
  url: string;
  setMode(m: FakeMode): void;
  /** The command a "tool" turn runs. */
  setCommand(c: string): void;
  requests: { lastRole: string | undefined; tools: string[]; text: string }[];
  close(): Promise<void>;
}> {
  let mode: FakeMode = "reply";
  let command = "echo hello > out.txt";
  const requests: { lastRole: string | undefined; tools: string[]; text: string }[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      if (req.url?.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: "fake-model", object: "model" }] }));
        return;
      }
      let j: {
        model?: string;
        messages?: { role: string; content?: unknown }[];
        tools?: { function?: { name?: string } }[];
      } = {};
      try {
        j = JSON.parse(body);
      } catch {}
      const last = j.messages?.at(-1)?.role;
      requests.push({
        lastRole: last,
        tools: (j.tools ?? []).map((t) => t.function?.name ?? ""),
        text: (j.messages ?? []).map((m) => JSON.stringify(m.content ?? "")).join("\n"),
      });
      if (mode === "rate-limit") {
        res.writeHead(429, { "content-type": "application/json", "retry-after": "30" });
        res.end(
          JSON.stringify({
            error: { message: "Rate limit exceeded (fake)", type: "rate_limit_error" },
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const id = `chatcmpl-${requests.length}`;
      const send = (o: object) =>
        res.write(
          `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: j.model, ...o })}\n\n`,
        );
      const finish = () => {
        send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
        send({
          choices: [],
          usage: {
            prompt_tokens: 120,
            completion_tokens: 40,
            total_tokens: 160,
            prompt_tokens_details: { cached_tokens: 20 },
          },
        });
        res.write("data: [DONE]\n\n");
        res.end();
      };
      if (mode === "tool" && last === "user") {
        send({
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    type: "function",
                    function: { name: "shell", arguments: "" },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        });
        send({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { arguments: JSON.stringify({ command }) },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        });
        send({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
        send({
          choices: [],
          usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
        });
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      const words =
        mode === "slow"
          ? Array.from({ length: 200 }, (_, i) => ` w${i}`)
          : ["Hello", " from", " the", " fake", " model."];
      let i = 0;
      const step = () => {
        if (res.destroyed) return;
        if (i < words.length) {
          send({
            choices: [
              {
                index: 0,
                delta: i === 0 ? { role: "assistant", content: words[i] } : { content: words[i] },
                finish_reason: null,
              },
            ],
          });
          i++;
          setTimeout(step, mode === "slow" ? 200 : 5);
          return;
        }
        finish();
      };
      step();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    setMode: (m) => {
      mode = m;
    },
    setCommand: (c) => {
      command = c;
    },
    requests,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
