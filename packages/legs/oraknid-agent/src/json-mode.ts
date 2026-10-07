// Tool calls for a model without native ones (ADR-052 §6): the request's
// tools become a JSON schema the server turns into a grammar (llama.cpp's
// `response_format: json_schema`, Ollama's `format`), so the model can
// only answer `{"tool": …, "arguments": …}` or `{"answer": …}`. The
// answer is turned back into an OpenAI tool call, so the loop above sees
// a model like any other. Streaming is given back as one burst.

interface WireTool {
  type: "function";
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
}

interface WireMessage {
  role: string;
  content?: unknown;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

/** The schema a step's answer must follow: one tool call, or the final answer. */
export function stepSchema(tools: WireTool[]): Record<string, unknown> {
  return {
    oneOf: [
      ...tools.map((t) => ({
        type: "object",
        properties: {
          tool: { const: t.function.name },
          arguments: t.function.parameters ?? { type: "object" },
        },
        required: ["tool", "arguments"],
      })),
      {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
      },
    ],
  };
}

const instructions = (tools: WireTool[]) =>
  [
    "You work by calling tools. Each reply is exactly one JSON object, nothing else:",
    '- to call a tool: {"tool": "<name>", "arguments": {…}}',
    '- when the work is done: {"answer": "<what you did, for the person>"}',
    "The tools:",
    ...tools.map(
      (t) =>
        `- ${t.function.name}: ${t.function.description ?? ""} Arguments: ${JSON.stringify(t.function.parameters ?? {})}`,
    ),
  ].join("\n");

const text = (content: unknown) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((p) => (p as { text?: string }).text ?? "").join("")
      : "";

/** The conversation as a model without tool calls can read it. */
export function toJsonMessages(messages: WireMessage[], tools: WireTool[]): WireMessage[] {
  const names = new Map<string, string>();
  const out: WireMessage[] = [];
  const sys = instructions(tools);
  let placed = false;
  for (const m of messages) {
    if (m.role === "system" && !placed) {
      out.push({ role: "system", content: `${text(m.content)}\n\n${sys}` });
      placed = true;
    } else if (m.role === "assistant" && m.tool_calls?.length) {
      for (const c of m.tool_calls) names.set(c.id, c.function.name);
      const [c] = m.tool_calls;
      out.push({
        role: "assistant",
        content: JSON.stringify({
          tool: c?.function.name,
          arguments: safeParse(c?.function.arguments ?? "{}"),
        }),
      });
    } else if (m.role === "assistant") {
      out.push({ role: "assistant", content: JSON.stringify({ answer: text(m.content) }) });
    } else if (m.role === "tool") {
      out.push({
        role: "user",
        content: `Result of ${names.get(m.tool_call_id ?? "") ?? "the tool"}:\n${text(m.content)}`,
      });
    } else out.push({ role: m.role, content: text(m.content) });
  }
  if (!placed) out.unshift({ role: "system", content: sys });
  return out;
}

const safeParse = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
};

/** A model's JSON step read back: a tool call, or the answer (plain text when it isn't JSON). */
export function readStep(
  content: string,
): { tool: string; arguments: Record<string, unknown> } | { answer: string } {
  const trimmed = content
    .trim()
    .replace(/^```(?:json)?\s*/, "")
    .replace(/```$/, "");
  const parsed = safeParse(trimmed) as {
    tool?: unknown;
    arguments?: unknown;
    answer?: unknown;
  } | null;
  if (parsed && typeof parsed.tool === "string")
    return {
      tool: parsed.tool,
      arguments:
        parsed.arguments && typeof parsed.arguments === "object"
          ? (parsed.arguments as Record<string, unknown>)
          : {},
    };
  if (parsed && typeof parsed.answer === "string") return { answer: parsed.answer };
  return { answer: content };
}

let callCount = 0;

/** A fetch that speaks grammar-constrained JSON to the server and native tool calls to its caller. */
export function jsonModeFetch(base: typeof fetch): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.endsWith("/chat/completions") || typeof init?.body !== "string")
      return base(input, init);
    const body = JSON.parse(init.body) as {
      messages: WireMessage[];
      tools?: WireTool[];
      tool_choice?: unknown;
      stream?: boolean;
      stream_options?: unknown;
      [k: string]: unknown;
    };
    if (!body.tools?.length) return base(input, init);
    const { tools, tool_choice: _c, stream, stream_options: _o, ...rest } = body;
    const schema = stepSchema(tools);
    const res = await base(input, {
      ...init,
      body: JSON.stringify({
        ...rest,
        messages: toJsonMessages(body.messages, tools),
        stream: false,
        response_format: {
          type: "json_schema",
          json_schema: { name: "step", schema, strict: true },
        },
      }),
    });
    if (!res.ok) return res;
    const answer = (await res.json()) as {
      id?: string;
      model?: string;
      created?: number;
      choices?: { message?: { content?: string | null } }[];
      usage?: unknown;
    };
    const step = readStep(answer.choices?.[0]?.message?.content ?? "");
    const message =
      "tool" in step
        ? {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: `json_${++callCount}`,
                type: "function",
                function: { name: step.tool, arguments: JSON.stringify(step.arguments) },
              },
            ],
          }
        : { role: "assistant", content: step.answer };
    const finish = "tool" in step ? "tool_calls" : "stop";
    const meta = {
      id: answer.id ?? `json-${callCount}`,
      model: answer.model ?? String(body.model ?? ""),
      created: answer.created ?? Math.floor(Date.now() / 1000),
    };
    if (!stream)
      return Response.json({
        ...meta,
        object: "chat.completion",
        choices: [{ index: 0, message, finish_reason: finish }],
        ...(answer.usage ? { usage: answer.usage } : {}),
      });
    const chunk = (delta: unknown, finish_reason: string | null, usage?: unknown) =>
      `data: ${JSON.stringify({
        ...meta,
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta, finish_reason }],
        ...(usage ? { usage } : {}),
      })}\n\n`;
    const delta =
      "tool" in step
        ? {
            role: "assistant",
            tool_calls: message.tool_calls?.map((c, index) => ({ index, ...c })),
          }
        : { role: "assistant", content: step.answer };
    const sse = `${chunk(delta, null)}${chunk({}, finish, answer.usage)}data: [DONE]\n\n`;
    return new Response(sse, { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
}
