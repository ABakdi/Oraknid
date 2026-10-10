import { contextWindowOf, testToolCalling } from "@oraknid/leg-oraknid-agent";
import {
  apiBase,
  Channel,
  emptyUsage,
  type LegAdapter,
  type LegConfig,
  type LegEvent,
  type LegSession,
  type ModelOffer,
  type ProbeResult,
  type QuotaReport,
  type SessionStart,
  type UsageSnapshot,
} from "@oraknid/leg-sdk";
import { MUTATING, runTool, TOOLS, ToolError, toRequest } from "./tools.ts";

/** The Leg's config: one OpenAI-compatible server (Ollama, LM Studio, llama.cpp, vLLM). */
export interface OpenAICompatibleConfig {
  /** e.g. http://localhost:11434/v1 */
  baseUrl: string;
  /** Tool calls per turn before the turn ends with max_turns. */
  maxToolCalls: number;
  commandTimeoutMs: number;
}

export const readConfig = (leg: LegConfig): OpenAICompatibleConfig => ({
  baseUrl: apiBase(String(leg.config.baseUrl ?? "http://localhost:11434/v1")),
  maxToolCalls: Number(leg.config.maxToolCalls ?? 50),
  commandTimeoutMs: Number(leg.config.commandTimeoutMs ?? 120_000),
});

type Message =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** Roughly four characters a token, for servers that report no usage. */
const estimateTokens = (s: string) => Math.ceil(s.length / 4);

export function createOpenAICompatibleAdapter(
  deps: {
    fetch?: typeof fetch;
    probeLimit?: number;
    /** The Leg's API key for its probe (a hosted API lists models only with it). */
    credentialOf?: (leg: LegConfig) => Promise<string | null>;
  } = {},
): LegAdapter {
  const http = deps.fetch ?? fetch;
  /** Tool calling per model as tested, once a day: this loop takes native calls only. */
  const tested = new Map<string, { native: boolean; at: number }>();
  const nativeTools = async (baseUrl: string, model: string, auth: Record<string, string>) => {
    const key = `${baseUrl}\n${model}`;
    const hit = tested.get(key);
    if (hit && Date.now() - hit.at < 86400_000) return hit.native;
    const { mode } = await testToolCalling(http, baseUrl, model, auth);
    tested.set(key, { native: mode === "native", at: Date.now() });
    return mode === "native";
  };

  return {
    kind: "openai-compatible",

    async probe(leg): Promise<ProbeResult> {
      const cfg = readConfig(leg);
      const features = {
        resume: false,
        tools: false,
        usage: "reported" as const,
        quotaWindows: false,
        // What changes something is asked before it runs.
        inlineGate: true,
        preToolHook: false,
        stopHook: false,
        steer: false,
      };
      let auth: Record<string, string> = {};
      try {
        const key = (await deps.credentialOf?.(leg)) ?? null;
        auth = key ? { authorization: `Bearer ${key}` } : {};
        const res = await http(`${cfg.baseUrl}/models`, {
          signal: AbortSignal.timeout(10_000),
          headers: auth,
        });
        if (res.status === 401 || res.status === 403)
          throw new Error(`${res.status}: the server refused the API key (or it needs one)`);
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const body = (await res.json()) as { data?: { id: string; max_model_len?: number }[] };
        const limit = deps.probeLimit ?? 8;
        const models: ModelOffer[] = await Promise.all(
          (body.data ?? []).map(async (m, i) => ({
            model: m.id,
            displayName: m.id,
            effortLevels: [],
            contextWindow: m.max_model_len ?? (await contextWindowOf(http, cfg.baseUrl, m.id)),
            // Tested with one tiny request (ADR-052 §6); untested beyond the first few.
            ...(i < limit
              ? { toolCalls: (await nativeTools(cfg.baseUrl, m.id, auth)) ? "native" : "none" }
              : {}),
          })),
        );
        const none = models.filter((m) => m.toolCalls === "none").length;
        return {
          ok: true,
          detail: models.length
            ? `${models.length} model${models.length === 1 ? "" : "s"} at ${cfg.baseUrl}${none ? `; ${none} without tool calls, kept to text work` : ""}.`
            : `The server at ${cfg.baseUrl} answers but has no models loaded or installed.`,
          models,
          features: { ...features, tools: models.some((m) => m.toolCalls !== "none") },
        };
      } catch (error) {
        return {
          ok: false,
          detail: `No OpenAI-compatible server answers at ${cfg.baseUrl}: ${(error as Error).message}`,
          models: [],
          features,
        };
      }
    },

    async start(s: SessionStart): Promise<LegSession> {
      const cfg = readConfig(s.leg);
      const events = new Channel<LegEvent>();
      // The history lives only as long as the session: continuity is Silk's job (BR-2).
      const history: Message[] = [{ role: "system", content: s.systemPrompt }];
      let usage: UsageSnapshot = emptyUsage();
      let turn: AbortController | null = null;
      let interrupted = false;
      let killed = false;
      let queue = Promise.resolve();

      const headers: Record<string, string> = { "content-type": "application/json" };
      if (s.credential) headers.authorization = `Bearer ${s.credential}`;

      async function runTurn(text: string) {
        interrupted = false;
        turn = new AbortController();
        const signal = turn.signal;
        events.push({ type: "turn.started" });
        history.push({ role: "user", content: text });
        let answer = "";
        try {
          for (let calls = 0; ; ) {
            const reply = await complete(signal);
            answer = reply.content;
            history.push({
              role: "assistant",
              content: reply.content || null,
              ...(reply.toolCalls.length ? { tool_calls: reply.toolCalls } : {}),
            });
            if (reply.toolCalls.length === 0) break;
            for (const call of reply.toolCalls) {
              if (++calls > cfg.maxToolCalls) {
                events.push({
                  type: "turn.ended",
                  reason: "max_turns",
                  text: answer,
                  error: `Stopped after ${cfg.maxToolCalls} tool calls in one turn.`,
                });
                return;
              }
              history.push({
                role: "tool",
                tool_call_id: call.id,
                content: await callTool(call, signal),
              });
            }
          }
          events.push({ type: "turn.ended", reason: "completed", text: answer, error: null });
        } catch (error) {
          if (killed) return;
          if (interrupted || signal.aborted) {
            events.push({ type: "turn.ended", reason: "interrupted", text: answer, error: null });
          } else if (error instanceof RateLimited) {
            events.push({ type: "rate_limit", quota: error.quota });
            events.push({
              type: "turn.ended",
              reason: "rate-limited",
              text: answer,
              error: error.message,
            });
          } else {
            events.push({
              type: "turn.ended",
              reason: "error",
              text: answer,
              error: (error as Error).message,
            });
          }
        } finally {
          turn = null;
        }
      }

      async function callTool(call: ToolCall, signal: AbortSignal): Promise<string> {
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          const output = "The tool arguments were not valid JSON.";
          events.push({ type: "tool.called", id: call.id, tool: call.function.name, input: {} });
          events.push({ type: "tool.result", id: call.id, ok: false, output });
          return output;
        }
        const tool = call.function.name;
        events.push({ type: "tool.called", id: call.id, tool, input: args });
        if (MUTATING.has(tool)) {
          const request = toRequest(s.cwd, tool, args);
          const decision = await s.onPermission(request);
          events.push({ type: "permission.requested", request, decision });
          if (!decision.allow) {
            const output = `Permission denied: ${decision.message}`;
            events.push({ type: "tool.result", id: call.id, ok: false, output });
            return output;
          }
        }
        try {
          const output = await runTool(
            { cwd: s.cwd, sandbox: s.sandbox, signal, commandTimeoutMs: cfg.commandTimeoutMs },
            tool,
            args,
          );
          const ok = tool !== "run_command" || /\[exit 0\]$/.test(output);
          events.push({ type: "tool.result", id: call.id, ok, output });
          return output;
        } catch (error) {
          if (signal.aborted) throw error;
          const output =
            error instanceof ToolError ? error.message : `Tool failed: ${(error as Error).message}`;
          events.push({ type: "tool.result", id: call.id, ok: false, output });
          return output;
        }
      }

      /** One streamed completion: text deltas out, tool calls and usage collected. */
      async function complete(signal: AbortSignal) {
        const body: Record<string, unknown> = {
          model: s.model,
          messages: history,
          tools: TOOLS,
          stream: true,
          stream_options: { include_usage: true },
        };
        if (s.effort) body.reasoning_effort = s.effort;
        const res = await http(`${cfg.baseUrl}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal,
        });
        if (res.status === 429) {
          const retry = Number(res.headers.get("retry-after"));
          throw new RateLimited({
            window: "requests",
            scope: "account",
            status: "rejected",
            utilization: 1,
            resetsAt: Number.isFinite(retry) && retry > 0 ? Date.now() + retry * 1000 : null,
          });
        }
        if (!res.ok || !res.body)
          throw new Error(`The model server answered ${res.status}: ${await res.text()}`);

        let content = "";
        const calls = new Map<number, ToolCall>();
        let reported: { prompt_tokens?: number; completion_tokens?: number } | null = null;
        for await (const data of sse(res.body)) {
          if (data === "[DONE]") break;
          const chunk = JSON.parse(data) as {
            choices?: {
              delta?: {
                content?: string | null;
                tool_calls?: {
                  index: number;
                  id?: string;
                  function?: { name?: string; arguments?: string };
                }[];
              };
            }[];
            usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
          };
          if (chunk.usage) reported = chunk.usage;
          const delta = chunk.choices?.[0]?.delta;
          if (delta?.content) {
            content += delta.content;
            events.push({ type: "text.delta", text: delta.content });
          }
          for (const tc of delta?.tool_calls ?? []) {
            const call = calls.get(tc.index) ?? {
              id: tc.id ?? `call_${tc.index}`,
              type: "function" as const,
              function: { name: "", arguments: "" },
            };
            if (tc.id) call.id = tc.id;
            if (tc.function?.name) call.function.name += tc.function.name;
            if (tc.function?.arguments) call.function.arguments += tc.function.arguments;
            calls.set(tc.index, call);
          }
        }

        const promptTokens = reported?.prompt_tokens ?? estimateTokens(JSON.stringify(history));
        const outputTokens =
          reported?.completion_tokens ??
          estimateTokens(content + [...calls.values()].map((c) => c.function.arguments).join(""));
        usage = {
          ...usage,
          inputTokens: usage.inputTokens + promptTokens,
          outputTokens: usage.outputTokens + outputTokens,
          contextTokens: promptTokens + outputTokens,
          contextWindow: (s.leg.config.contextWindow as number | undefined) ?? usage.contextWindow,
          estimated: usage.estimated || !reported,
        };
        events.push({ type: "usage", usage });
        return { content, toolCalls: [...calls.values()] };
      }

      const send = (text: string) => {
        queue = queue.then(() => runTurn(text));
        return Promise.resolve();
      };
      void send(s.prompt);

      return {
        nativeSessionId: () => null,
        pid: () => null,
        send,
        events: () => events,
        interrupt: async () => {
          interrupted = true;
          turn?.abort();
        },
        kill: async () => {
          if (killed) return;
          killed = true;
          turn?.abort();
          events.push({ type: "session.ended", reason: "killed", error: null });
          events.end();
        },
        usage: () => usage,
      };
    },
  };
}

class RateLimited extends Error {
  constructor(readonly quota: QuotaReport) {
    super("The server is rate-limiting requests.");
  }
}

/** Server-sent events: yields each `data:` payload. */
async function* sse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let cut = buffer.indexOf("\n"); cut >= 0; cut = buffer.indexOf("\n")) {
      const line = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
}
