import { readStep, stepSchema } from "./json-mode.ts";

/** How a model calls tools: natively, through a JSON grammar, or not at all (text work only). */
export type ToolCalling = "native" | "json" | "none";

const ADD = {
  type: "function" as const,
  function: {
    name: "add",
    description: "Adds two numbers.",
    parameters: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    },
  },
};

const asked = (a: unknown, b: unknown) => Number(a) === 2 && Number(b) === 3;

/**
 * Tests tool calling with one tiny request (ADR-052 §6): first native
 * tool calls, then a JSON grammar. A model that does neither is "none".
 */
export async function testToolCalling(
  http: typeof fetch,
  baseUrl: string,
  model: string,
  headers: Record<string, string>,
): Promise<{ mode: ToolCalling; detail: string }> {
  const messages = [
    {
      role: "user",
      content: "Use the add tool to add 2 and 3. Call the tool; don't answer in words.",
    },
  ];
  const post = (body: Record<string, unknown>) =>
    http(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ model, messages, temperature: 0, max_tokens: 512, ...body }),
      signal: AbortSignal.timeout(60_000),
    });
  try {
    const res = await post({ tools: [ADD] });
    if (res.ok) {
      const body = (await res.json()) as {
        choices?: {
          message?: { tool_calls?: { function?: { name?: string; arguments?: string } }[] };
        }[];
      };
      const call = body.choices?.[0]?.message?.tool_calls?.[0]?.function;
      if (call?.name === "add") {
        const args = JSON.parse(call.arguments || "{}") as { a?: unknown; b?: unknown };
        if (asked(args.a, args.b)) return { mode: "native", detail: "calls tools natively" };
      }
    }
  } catch {}
  try {
    const res = await post({
      response_format: {
        type: "json_schema",
        json_schema: { name: "step", schema: stepSchema([ADD]), strict: true },
      },
      messages: [
        {
          role: "system",
          content:
            'Answer with one JSON object: {"tool": "add", "arguments": {"a": …, "b": …}} to call the add tool, or {"answer": "…"}.',
        },
        ...messages,
      ],
    });
    if (res.ok) {
      const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const step = readStep(body.choices?.[0]?.message?.content ?? "");
      if ("tool" in step && step.tool === "add" && asked(step.arguments.a, step.arguments.b))
        return { mode: "json", detail: "calls tools through a JSON grammar" };
    }
  } catch {}
  return { mode: "none", detail: "doesn't call tools: text work only" };
}
