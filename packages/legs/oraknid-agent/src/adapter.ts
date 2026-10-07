import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport as StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
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
import {
  APICallError,
  generateText,
  isStepCount,
  jsonSchema,
  type ModelMessage,
  streamText,
  type ToolSet,
  tool,
} from "ai";
import { jsonModeFetch } from "./json-mode.ts";
import { type ToolCalling, testToolCalling } from "./probe.ts";
import {
  clip,
  permissionFor,
  runInSandbox,
  runTool,
  TOOL_SPECS,
  type Todo,
  type ToolContext,
} from "./tools.ts";

// Oraknid's own agent (ADR-052 §6): a tool loop over any model behind an
// OpenAI-compatible chat-completions API, built on the Vercel AI SDK's
// loop (streamText with tools, a step limit and prepareStep). The tools
// are Oraknid's (tools.ts), run by the daemon: files inside the worktree,
// commands inside the job's sandbox, every change through the policy.

/** One model at its own address: the local models' servers, one per loaded model (ADR-054). */
export interface Endpoint {
  model: string;
  baseUrl: string;
  displayName?: string;
  contextWindow?: number;
  /** As the Models page tested it, so the probe doesn't ask again. */
  toolCalls?: ToolCalling;
}

export interface OraknidAgentConfig {
  /** One OpenAI-compatible server, e.g. https://openrouter.ai/api/v1. */
  baseUrl: string | null;
  /** The models to offer; empty: what the server lists. */
  models: string[];
  /** Models each at their own address (the Local Leg). */
  endpoints: Endpoint[];
  contextWindow: number | null;
  /** Model calls in one turn before it ends with max_turns. */
  maxSteps: number;
  commandTimeoutMs: number;
  /** Rounds of failing checks a turn keeps working through. */
  maxCheckRounds: number;
  /** Set by the Models page: this Leg is this computer's own models. */
  local: boolean;
}

export const readConfig = (leg: LegConfig): OraknidAgentConfig => {
  const c = leg.config;
  return {
    baseUrl: typeof c.baseUrl === "string" && c.baseUrl ? c.baseUrl.replace(/\/+$/, "") : null,
    models: Array.isArray(c.models) ? c.models.map(String) : [],
    endpoints: Array.isArray(c.endpoints)
      ? (c.endpoints as Endpoint[]).map((e) => ({ ...e, baseUrl: e.baseUrl.replace(/\/+$/, "") }))
      : [],
    contextWindow: typeof c.contextWindow === "number" ? c.contextWindow : null,
    maxSteps: Number(c.maxSteps ?? 200),
    commandTimeoutMs: Number(c.commandTimeoutMs ?? 120_000),
    maxCheckRounds: Number(c.maxCheckRounds ?? 3),
    local: c.local === true,
  };
};

/** What a session keeps between turns and across a resume. */
interface Stored {
  model: string;
  history: ModelMessage[];
  todos: Todo[];
}

export interface OraknidAgentDeps {
  fetch?: typeof fetch;
  /** Where sessions are kept for resume; in memory only without it. */
  sessionsDir?: string;
  /** How many of a server's models the probe tests (each test is one tiny request). */
  probeLimit?: number;
  /** The Leg's API key for the probe's test request (sessions get theirs at start). */
  credentialOf?: (leg: LegConfig) => Promise<string | null>;
}

const PREAMBLE = `You are Oraknid's agent. You work in a project's workspace (the current folder) through tools, until the task is done.
- Do the whole task yourself: find your way with glob, grep and read; change files with edit and write; build, test and run things with bash.
- For work of three steps or more, keep a todo list with todo_write and keep it current.
- Read before you edit; edit with exact text. Keep each tool call purposeful.
- Verify your work: build it, run the tests and the checks you were given, and fix what fails before you finish.
- If a check itself is broken (its syntax, a missing tool) rather than your work, say so with the evidence instead of working around it.
- When the work is done, end your turn with a short report: what you changed, how you verified it, anything left.`;

const TEXT_ONLY = `You have no tools in this session: answer in text only.`;

/** Roughly four characters a token, for servers that report no usage. */
const estimate = (x: unknown) => Math.ceil(JSON.stringify(x).length / 4);

export function createOraknidAgentAdapter(deps: OraknidAgentDeps = {}): LegAdapter {
  const http = deps.fetch ?? fetch;
  const sessions = new Map<string, Stored>();
  /** Tool calling per model as tested: tested again after a day or on a new address. */
  const tested = new Map<string, { mode: ToolCalling; at: number }>();

  const headersFor = (credential: string | null): Record<string, string> =>
    credential ? { authorization: `Bearer ${credential}` } : {};

  async function toolCalling(
    baseUrl: string,
    model: string,
    credential: string | null,
    known?: ToolCalling,
  ): Promise<ToolCalling> {
    if (known) return known;
    const key = `${baseUrl}\n${model}`;
    const hit = tested.get(key);
    if (hit && Date.now() - hit.at < 86400_000) return hit.mode;
    const { mode } = await testToolCalling(http, baseUrl, model, headersFor(credential));
    tested.set(key, { mode, at: Date.now() });
    return mode;
  }

  function save(id: string, stored: Stored) {
    sessions.set(id, stored);
    if (!deps.sessionsDir) return;
    mkdirSync(deps.sessionsDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(deps.sessionsDir, `${id}.json`), JSON.stringify(stored), { mode: 0o600 });
  }

  function load(id: string): Stored | null {
    const hit = sessions.get(id);
    if (hit) return hit;
    if (!deps.sessionsDir || !/^[\w-]+$/.test(id)) return null;
    const file = join(deps.sessionsDir, `${id}.json`);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, "utf8")) as Stored;
    } catch {
      return null;
    }
  }

  return {
    kind: "oraknid-agent",

    async probe(leg): Promise<ProbeResult> {
      const cfg = readConfig(leg);
      const feats = { resume: true, tools: true, usage: "reported" as const, quotaWindows: false };
      const credential = (await deps.credentialOf?.(leg)) ?? null;
      if (cfg.local && !cfg.endpoints.length)
        return {
          ok: false,
          detail: "No local model is loaded: load one on the Models page.",
          models: [],
          features: { ...feats, tools: false },
        };
      let found: Endpoint[] = cfg.endpoints;
      if (!found.length) {
        if (!cfg.baseUrl)
          return {
            ok: false,
            detail: "Give it the address of an OpenAI-compatible server and a model.",
            models: [],
            features: { ...feats, tools: false },
          };
        try {
          found = await listModels(http, cfg.baseUrl, cfg.models);
        } catch (error) {
          return {
            ok: false,
            detail: `No OpenAI-compatible server answers at ${cfg.baseUrl}: ${(error as Error).message}`,
            models: [],
            features: { ...feats, tools: false },
          };
        }
      }
      const limit = deps.probeLimit ?? 8;
      const models: ModelOffer[] = [];
      for (const [i, e] of found.entries()) {
        const toolCalls =
          i < limit ? await toolCalling(e.baseUrl, e.model, credential, e.toolCalls) : undefined;
        models.push({
          model: e.model,
          displayName: e.displayName ?? e.model,
          effortLevels: [],
          contextWindow:
            e.contextWindow ??
            (await contextWindowOf(http, e.baseUrl, e.model)) ??
            cfg.contextWindow,
          ...(toolCalls ? { toolCalls } : {}),
        });
      }
      const none = models.filter((m) => m.toolCalls === "none").length;
      const where = cfg.local ? "on this computer" : `at ${cfg.baseUrl ?? found[0]?.baseUrl}`;
      return {
        ok: models.length > 0,
        detail: models.length
          ? `${models.length} model${models.length === 1 ? "" : "s"} ${where}${none ? `; ${none} without tool calls, kept to text work` : ""}.`
          : `The server ${where} answers but offers no models.`,
        models,
        features: { ...feats, tools: models.some((m) => m.toolCalls !== "none") },
      };
    },

    async start(s: SessionStart): Promise<LegSession> {
      const cfg = readConfig(s.leg);
      const endpoint = cfg.endpoints.find((e) => e.model === s.model);
      const baseUrl = endpoint?.baseUrl ?? cfg.baseUrl;
      if (!baseUrl) throw new Error(`No address for the model ${s.model} on ${s.leg.name}.`);
      const mode = await toolCalling(baseUrl, s.model, s.credential, endpoint?.toolCalls);
      const contextWindow = endpoint?.contextWindow ?? cfg.contextWindow;
      const provider = createOpenAICompatible({
        name: "oraknid",
        baseURL: baseUrl,
        ...(s.credential ? { apiKey: s.credential } : {}),
        includeUsage: true,
        fetch: mode === "json" ? jsonModeFetch(http) : http,
      });
      const model = provider.chatModel(s.model);

      const events = new Channel<LegEvent>();
      const resumed = s.resumeFrom ? load(s.resumeFrom) : null;
      const id = resumed && s.resumeFrom ? s.resumeFrom : `oa-${randomUUID()}`;
      let history: ModelMessage[] = resumed?.history ?? [];
      const todos: Todo[] = resumed?.todos ?? [];
      let usage: UsageSnapshot = { ...emptyUsage(), contextWindow };
      let turn: AbortController | null = null;
      let interrupted = false;
      let killed = false;
      let queue = Promise.resolve();
      const checks = (s.checks ?? []).filter((c) => c.trim());

      // The job's tools (ADR-021): Oraknid's bridges to its broker, which judges every call.
      const mcp: MCPClient[] = [];
      const mcpTools: ToolSet = {};
      const mcpProblems: string[] = [];
      if (mode !== "none")
        for (const [server, spec] of Object.entries(s.mcpServers ?? {})) {
          try {
            const client = await createMCPClient({
              transport: new StdioMCPTransport({ command: spec.command, args: spec.args }),
            });
            mcp.push(client);
            for (const [name, t] of Object.entries(await client.tools()))
              mcpTools[`mcp__${server}__${name}`.slice(0, 64)] = t as ToolSet[string];
          } catch (error) {
            mcpProblems.push(`${server}: ${(error as Error).message}`);
          }
        }

      const system = [
        PREAMBLE,
        mode === "none" ? TEXT_ONLY : "",
        mcpProblems.length
          ? `Some of this job's tools didn't start: ${mcpProblems.join("; ")}.`
          : "",
        checks.length
          ? `Before you finish, these checks must pass (run them yourself with bash):\n${checks.map((c) => `- \`${c}\``).join("\n")}`
          : "",
        s.systemPrompt,
      ]
        .filter(Boolean)
        .join("\n\n");

      /** Events a tool call makes while it runs, given out when its result reaches the stream. */
      const pending = new Map<string, LegEvent[]>();

      async function callTool(
        name: string,
        args: Record<string, unknown>,
        callId: string,
        signal: AbortSignal,
      ): Promise<string> {
        const out = pending.get(callId) ?? [];
        pending.set(callId, out);
        const request = permissionFor(s.cwd, name, args);
        if (request) {
          const decision = await s.onPermission(request);
          out.push({ type: "permission.requested", request, decision });
          if (!decision.allow) {
            const output = `Permission denied: ${decision.message} Don't repeat this call; do the work another way, or end your turn and say what you need.`;
            out.push({ type: "tool.result", id: callId, ok: false, output });
            return output;
          }
        }
        const ctx: ToolContext = {
          cwd: s.cwd,
          sandbox: s.sandbox,
          signal,
          commandTimeoutMs: cfg.commandTimeoutMs,
          todos,
          fetch: http,
        };
        const r = await runTool(ctx, name, args);
        out.push({ type: "tool.result", id: callId, ok: r.ok, output: r.output });
        return r.output;
      }

      const tools = (signal: AbortSignal): ToolSet => ({
        ...Object.fromEntries(
          TOOL_SPECS.map((spec) => [
            spec.name,
            tool({
              description: spec.description,
              inputSchema: jsonSchema<Record<string, unknown>>(spec.parameters),
              execute: (input: Record<string, unknown>, o: { toolCallId: string }) =>
                callTool(spec.name, input ?? {}, o.toolCallId, signal),
            }),
          ]),
        ),
        ...mcpTools,
      });

      /** The work so far in fewer tokens, near the model's window: the task, a summary, the latest steps. */
      async function compact(messages: ModelMessage[], signal: AbortSignal) {
        const window = contextWindow ?? 32_000;
        let start = messages.length;
        let kept = 0;
        while (start > 1) {
          const cost = estimate(messages[start - 1]);
          if (kept + cost > window * 0.25 && start < messages.length) break;
          kept += cost;
          start--;
        }
        // The kept tail starts on a turn of its own, never on a tool's result.
        while (start < messages.length && messages[start]?.role === "tool") start++;
        const firstUser = messages.findIndex((m) => m.role === "user");
        const task = messages[firstUser];
        const middle = messages.slice(firstUser + 1, start);
        if (!task || middle.length === 0) return messages;
        let summary: string;
        try {
          const r = await generateText({
            model,
            maxRetries: 0,
            abortSignal: signal,
            system:
              "You summarise an agent's work so it can continue without the full transcript. Keep: the goal, what was done and found, files changed, commands and their results, errors not yet fixed, decisions, what is left. Be concise and concrete; paths and names exact.",
            messages: [{ role: "user", content: transcript(middle, window * 2) }],
          });
          summary = r.text.trim() || mechanical(middle);
        } catch {
          if (signal.aborted) throw new Error("interrupted");
          summary = mechanical(middle);
        }
        const tail = messages.slice(start);
        const head: ModelMessage = {
          role: "user",
          content: `${textOf(task.content)}\n\n[Earlier in this session, summarised to fit the model's context]\n${summary}`,
        };
        return [
          head,
          ...(tail[0]?.role === "user"
            ? [{ role: "assistant", content: "Noted; continuing from there." } as ModelMessage]
            : []),
          ...tail,
        ];
      }

      /** One run of the loop: the model and its tools until it ends its turn. */
      async function loop(signal: AbortSignal): Promise<{
        text: string;
        end: "completed" | "max_turns" | "rate-limited" | "error" | "interrupted";
        error: string | null;
      }> {
        let text = "";
        let steps = 0;
        let lastFinish = "";
        let failure: unknown = null;
        let base: { messages: ModelMessage[]; offset: number } | null = null;
        const before = history;
        const result = streamText({
          model,
          system,
          messages: history,
          ...(mode === "none" ? {} : { tools: tools(signal) }),
          stopWhen: isStepCount(cfg.maxSteps),
          maxRetries: 0,
          abortSignal: signal,
          ...(s.effort ? { providerOptions: { oraknid: { reasoningEffort: s.effort } } } : {}),
          prepareStep: async ({ messages, steps: done, responseMessages }) => {
            if (!contextWindow) return {};
            const u = done.at(-1)?.usage;
            const used =
              u?.inputTokens != null ? u.inputTokens + (u.outputTokens ?? 0) : estimate(messages);
            if (used < contextWindow * 0.8) return {};
            const compacted = await compact(messages, signal);
            base = { messages: compacted, offset: responseMessages.length };
            return { messages: compacted };
          },
          onError: () => {},
        });
        for await (const part of result.fullStream) {
          switch (part.type) {
            case "start-step":
              text = "";
              break;
            case "text-delta":
              text += part.text;
              if (part.text) events.push({ type: "text.delta", text: part.text });
              break;
            case "reasoning-delta":
              if (part.text) events.push({ type: "thinking.delta", text: part.text });
              break;
            case "tool-call":
              events.push({
                type: "tool.called",
                id: part.toolCallId,
                tool: part.toolName,
                input: (part.input ?? {}) as Record<string, unknown>,
              });
              break;
            case "tool-result":
            case "tool-error": {
              const out = pending.get(part.toolCallId);
              pending.delete(part.toolCallId);
              if (out?.length) for (const e of out) events.push(e);
              else if (part.type === "tool-error")
                events.push({
                  type: "tool.result",
                  id: part.toolCallId,
                  ok: false,
                  output: `${part.toolName}: ${errorText(part.error)}`,
                });
              else {
                // A job's tool, answered through the broker: MCP's content as text.
                const r = part.output as
                  | { content?: { text?: string }[]; isError?: boolean }
                  | string;
                events.push({
                  type: "tool.result",
                  id: part.toolCallId,
                  ok: typeof r === "string" || !r?.isError,
                  output: clip(
                    typeof r === "string"
                      ? r
                      : (r?.content?.map((c) => c.text ?? "").join("\n") ?? JSON.stringify(r)),
                  ),
                });
              }
              break;
            }
            case "finish-step": {
              steps++;
              lastFinish = part.finishReason;
              const u = part.usage;
              const reported = u.inputTokens != null && u.outputTokens != null;
              const input = u.inputTokens ?? estimate(history);
              const output = u.outputTokens ?? Math.ceil(text.length / 4);
              usage = {
                ...usage,
                inputTokens: usage.inputTokens + input,
                outputTokens: usage.outputTokens + Math.max(1, output),
                cacheReadTokens:
                  usage.cacheReadTokens + (u.inputTokenDetails?.cacheReadTokens ?? 0),
                contextTokens: input + output,
                contextWindow,
                estimated: usage.estimated || !reported,
              };
              events.push({ type: "usage", usage });
              break;
            }
            case "error":
              failure = part.error;
              break;
            case "abort":
              failure = failure ?? new Error("interrupted");
              break;
          }
        }
        if (signal.aborted) {
          // What the model said before the interruption stays in the session.
          if (text) history = [...before, { role: "assistant", content: `${text} [interrupted]` }];
          return { text, end: "interrupted", error: null };
        }
        if (failure) {
          if (APICallError.isInstance(failure) && failure.statusCode === 429) {
            const retry = Number(failure.responseHeaders?.["retry-after"]);
            const quota: QuotaReport = {
              window: "requests",
              scope: "account",
              status: "rejected",
              utilization: 1,
              resetsAt: Number.isFinite(retry) && retry > 0 ? Date.now() + retry * 1000 : null,
            };
            events.push({ type: "rate_limit", quota });
            return { text, end: "rate-limited", error: "The server is rate-limiting requests." };
          }
          return { text, end: "error", error: errorText(failure) };
        }
        const response = await result.response;
        const done = base as { messages: ModelMessage[]; offset: number } | null;
        history = done
          ? [...done.messages, ...response.messages.slice(done.offset)]
          : [...before, ...response.messages];
        if (lastFinish === "tool-calls" && steps >= cfg.maxSteps)
          return {
            text,
            end: "max_turns",
            error: `Stopped after ${cfg.maxSteps} model calls in one turn.`,
          };
        return { text, end: "completed", error: null };
      }

      /** The checks, run in the sandbox: the first that fails, or null when all pass. */
      async function runChecks(signal: AbortSignal): Promise<string | null> {
        for (const [i, command] of checks.entries()) {
          const id = `check-${Date.now()}-${i}`;
          events.push({ type: "tool.called", id, tool: "check", input: { command } });
          const r = await runInSandbox(
            { cwd: s.cwd, sandbox: s.sandbox, signal },
            existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh",
            ["-c", command],
            cfg.commandTimeoutMs,
          );
          events.push({ type: "tool.result", id, ok: r.code === 0, output: r.output });
          if (r.code !== 0) return `$ ${command}\n${clip(r.output, 6000)}`;
        }
        return null;
      }

      async function runTurn(message: string) {
        interrupted = false;
        turn = new AbortController();
        const signal = turn.signal;
        events.push({ type: "turn.started" });
        history = [...history, { role: "user", content: message }];
        let text = "";
        try {
          for (let round = 0; ; round++) {
            const r = await loop(signal);
            text = r.text || text;
            if (killed) return;
            if (r.end !== "completed") {
              events.push({
                type: "turn.ended",
                reason: interrupted || r.end === "interrupted" ? "interrupted" : r.end,
                text,
                error: r.error,
              });
              return;
            }
            if (round >= cfg.maxCheckRounds) break;
            // Oraknid's own checks when it gives them (ADR-052 §2: the same as Claude Code's
            // Stop hook, broken checks told apart there); else the session's own.
            const held = s.onStop
              ? await s.onStop(text)
              : checks.length
                ? await runChecks(signal).then((failed) =>
                    failed
                      ? `A check failed, so the work isn't done yet:\n${failed}\nFix the work and run the checks again; end your turn once they pass. If the check itself is broken, say so with the evidence.`
                      : null,
                  )
                : null;
            if (!held) break;
            history = [...history, { role: "user", content: held }];
          }
          events.push({ type: "turn.ended", reason: "completed", text, error: null });
        } catch (error) {
          if (killed) return;
          events.push(
            interrupted || signal.aborted
              ? { type: "turn.ended", reason: "interrupted", text, error: null }
              : { type: "turn.ended", reason: "error", text, error: errorText(error) },
          );
        } finally {
          turn = null;
          if (!killed) save(id, { model: s.model, history, todos });
        }
      }

      const send = (message: string) => {
        queue = queue.then(() => runTurn(message));
        return Promise.resolve();
      };
      void send(s.prompt);

      return {
        nativeSessionId: () => id,
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
          save(id, { model: s.model, history, todos });
          await Promise.all(mcp.map((c) => c.close().catch(() => {})));
          events.push({ type: "session.ended", reason: "killed", error: null });
          events.end();
        },
        usage: () => usage,
      };
    },
  };
}

function errorText(error: unknown): string {
  if (APICallError.isInstance(error))
    return `The model server answered ${error.statusCode ?? "an error"}: ${clip(error.responseBody ?? error.message, 1000)}`;
  return error instanceof Error ? error.message : String(error);
}

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((p) => {
            const part = p as {
              type: string;
              text?: string;
              toolName?: string;
              input?: unknown;
              output?: unknown;
            };
            if (part.type === "text") return part.text ?? "";
            if (part.type === "tool-call")
              return `→ ${part.toolName}(${clip(JSON.stringify(part.input ?? {}), 400)})`;
            if (part.type === "tool-result") {
              const o = part.output as { value?: unknown } | undefined;
              return `← ${part.toolName}: ${clip(typeof o?.value === "string" ? o.value : JSON.stringify(o?.value ?? o), 1500)}`;
            }
            return "";
          })
          .join("\n")
      : "";

/** The messages as a plain transcript, at most `chars` long (the end kept). */
function transcript(messages: ModelMessage[], chars: number): string {
  const text = messages.map((m) => `${m.role.toUpperCase()}:\n${textOf(m.content)}`).join("\n\n");
  return text.length > chars ? `… (the start cut)\n${text.slice(-chars)}` : text;
}

/** A summary with no model: the tool calls made, in order. */
function mechanical(messages: ModelMessage[]): string {
  const calls = messages.flatMap((m) =>
    m.role === "assistant" && Array.isArray(m.content)
      ? m.content
          .filter((p) => p.type === "tool-call")
          .map((p) => `- ${p.toolName} ${clip(JSON.stringify(p.input ?? {}), 200)}`)
      : [],
  );
  return `Tool calls made so far (the model could not summarise them):\n${calls.slice(-60).join("\n")}`;
}

/** A server's models: from /models, or the ones configured when it doesn't list them. */
async function listModels(
  http: typeof fetch,
  baseUrl: string,
  wanted: string[],
): Promise<Endpoint[]> {
  let listed: { id: string; max_model_len?: number }[] = [];
  try {
    const res = await http(`${baseUrl}/models`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    listed = ((await res.json()) as { data?: { id: string; max_model_len?: number }[] }).data ?? [];
  } catch (error) {
    if (!wanted.length) throw error;
  }
  if (!wanted.length)
    return listed.map((m) => ({
      model: m.id,
      baseUrl,
      ...(m.max_model_len ? { contextWindow: m.max_model_len } : {}),
    }));
  return wanted.map((model) => {
    const m = listed.find((x) => x.id === model);
    return { model, baseUrl, ...(m?.max_model_len ? { contextWindow: m.max_model_len } : {}) };
  });
}

/**
 * The context window a server runs a model with: llama.cpp's /props,
 * Ollama's /api/show, LM Studio's /api/v1/models (the loaded instance's
 * context length, else the model's most; /api/v0/models before LM Studio
 * 0.4). Null when none answers.
 */
export async function contextWindowOf(
  http: typeof fetch,
  baseUrl: string,
  model: string,
): Promise<number | null> {
  const root = baseUrl.replace(/\/v1$/, "");
  try {
    const res = await http(`${root}/props`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const props = (await res.json()) as {
        default_generation_settings?: { n_ctx?: number };
        n_ctx?: number;
      };
      const n = props.default_generation_settings?.n_ctx ?? props.n_ctx;
      if (n) return n;
    }
  } catch {}
  try {
    const res = await http(`${root}/api/show`, {
      method: "POST",
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const info =
        ((await res.json()) as { model_info?: Record<string, unknown> }).model_info ?? {};
      const key = Object.keys(info).find((k) => k.endsWith(".context_length"));
      if (key) return Number(info[key]);
    }
  } catch {}
  return lmStudioWindow(http, root, model);
}

/** LM Studio's own REST API: what the model is loaded with, else the most it takes. */
export async function lmStudioWindow(
  http: typeof fetch,
  root: string,
  model: string,
): Promise<number | null> {
  try {
    const res = await http(`${root}/api/v1/models`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const body = (await res.json()) as {
        models?: {
          key?: string;
          max_context_length?: number;
          loaded_instances?: { id?: string; config?: { context_length?: number } }[];
        }[];
      };
      const m = body.models?.find(
        (x) => x.key === model || x.loaded_instances?.some((i) => i.id === model),
      );
      if (m) {
        const loaded =
          m.loaded_instances?.find((i) => i.id === model)?.config?.context_length ??
          m.loaded_instances?.[0]?.config?.context_length;
        const n = loaded ?? m.max_context_length;
        if (n) return n;
      }
    }
  } catch {}
  try {
    const res = await http(`${root}/api/v0/models`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const body = (await res.json()) as {
        data?: { id: string; loaded_context_length?: number; max_context_length?: number }[];
      };
      const m = body.data?.find((x) => x.id === model);
      const n = m?.loaded_context_length ?? m?.max_context_length;
      if (n) return n;
    }
  } catch {}
  return null;
}
