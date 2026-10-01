import { spawn } from "node:child_process";
import {
  type CanUseTool,
  type EffortLevel,
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type SpawnedProcess,
  query as sdkQuery,
} from "@anthropic-ai/claude-agent-sdk";
import {
  Channel,
  emptyUsage,
  type LegAdapter,
  type LegConfig,
  type LegEvent,
  type LegSession,
  type PermissionRequest,
  type ProbeResult,
  type QuotaReport,
  type SandboxPlan,
  type SessionStart,
  type TurnEnd,
  type UsageSnapshot,
} from "@oraknid/leg-sdk";

/** The Leg's config (Leg-Adapters → Claude Code). */
export interface ClaudeCodeConfig {
  /** The unmodified Claude Code binary. */
  binary: string;
  /**
   * This account's config directory. I log into it with the official
   * binary; Oraknid only points the process at it (ADR-009, ADR-011).
   */
  configDir: string;
}

export const readConfig = (leg: LegConfig): ClaudeCodeConfig => ({
  binary: String(leg.config.binary ?? "claude"),
  configDir: String(leg.config.configDir ?? ""),
});

export type QueryFn = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => Query;

const userMessage = (text: string): SDKUserMessage =>
  ({
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    session_id: "",
  }) as SDKUserMessage;

/** Windows that belong to one model rather than the whole account. */
const MODEL_WINDOWS = new Set(["seven_day_opus", "seven_day_sonnet"]);

/** resetsAt arrives in epoch seconds; Oraknid keeps milliseconds. */
const toMs = (t: number | undefined) => (t === undefined ? null : t < 1e12 ? t * 1000 : t);

export function toRequest(tool: string, input: Record<string, unknown>): PermissionRequest {
  const command = typeof input.command === "string" ? input.command : null;
  const path =
    typeof input.file_path === "string"
      ? input.file_path
      : typeof input.notebook_path === "string"
        ? input.notebook_path
        : typeof input.path === "string"
          ? input.path
          : null;
  return { tool, input, command, path };
}

/**
 * Builds the options every session uses: my host setup stays out
 * (`settingSources: []`, explicit MCP servers), permissions go through
 * The Eye (`canUseTool`, mode `default`, never bypass), and the binary
 * runs inside the sandbox.
 */
function baseOptions(
  cfg: ClaudeCodeConfig,
  plan: SandboxPlan | null,
  cwd: string,
  onSpawn: (p: SpawnedProcess & { pid?: number }) => void,
): Options {
  const env: Record<string, string> = {
    ...(plan?.env ?? { PATH: process.env.PATH ?? "/usr/bin", HOME: process.env.HOME ?? "/" }),
    CLAUDE_CONFIG_DIR: cfg.configDir,
  };
  const options: Options = {
    cwd,
    env,
    pathToClaudeCodeExecutable: cfg.binary,
    settingSources: [],
    mcpServers: {},
    permissionMode: "default",
    includePartialMessages: true,
  };
  if (plan) {
    options.spawnClaudeCodeProcess = (o) => {
      const childEnv = Object.fromEntries(
        Object.entries({ ...o.env, ...env }).filter(
          (kv): kv is [string, string] => kv[1] !== undefined,
        ),
      );
      const wrapped = plan.sandbox.wrap({
        command: o.command,
        args: o.args,
        cwd: o.cwd ?? cwd,
        writable: [...new Set([cwd, plan.home, cfg.configDir, ...plan.writable])],
        readonly: plan.readonly,
        home: plan.home,
        env: childEnv,
      });
      const child = spawn(wrapped.command, wrapped.args, {
        stdio: ["pipe", "pipe", "pipe"],
        ...(o.signal ? { signal: o.signal } : {}),
      });
      child.stderr?.resume();
      onSpawn(child as unknown as SpawnedProcess & { pid?: number });
      return child as unknown as SpawnedProcess;
    };
  }
  return options;
}

export function createClaudeCodeAdapter(deps: { query?: QueryFn } = {}): LegAdapter {
  const query: QueryFn = deps.query ?? (sdkQuery as QueryFn);

  return {
    kind: "claude-code",

    async probe(leg, plan): Promise<ProbeResult> {
      const cfg = readConfig(leg);
      const features = {
        resume: true,
        tools: true,
        usage: "reported" as const,
        quotaWindows: true,
      };
      if (!cfg.configDir) {
        return {
          ok: false,
          detail: "No config directory: log in with the official binary first.",
          models: [],
          features,
        };
      }
      // No message is sent: asking for the models costs no tokens.
      const input = new Channel<SDKUserMessage>();
      const q = query({
        prompt: input,
        options: baseOptions(cfg, plan, plan?.home ?? process.cwd(), () => {}),
      });
      try {
        const [models, account] = await Promise.all([q.supportedModels(), q.accountInfo()]);
        return {
          ok: true,
          detail: `Signed in${account.email ? ` as ${account.email}` : ""}${
            account.subscriptionType ? ` (${account.subscriptionType})` : ""
          }.`,
          models: models.map((m) => ({
            model: m.value,
            displayName: m.displayName,
            effortLevels: m.supportedEffortLevels ?? [],
            contextWindow: null,
          })),
          features,
        };
      } catch (error) {
        return {
          ok: false,
          detail: `Claude Code did not answer: ${(error as Error).message}`,
          models: [],
          features,
        };
      } finally {
        input.end();
        q.close();
      }
    },

    async start(s: SessionStart): Promise<LegSession> {
      const cfg = readConfig(s.leg);
      const events = new Channel<LegEvent>();
      const input = new Channel<SDKUserMessage>();
      let nativeId: string | null = s.resumeFrom;
      let pid: number | null = null;
      let usage: UsageSnapshot = emptyUsage();
      let interrupted = false;
      let killed = false;
      let rateLimited = false;
      let turnText = "";

      const canUseTool: CanUseTool = async (tool, toolInput) => {
        const request = toRequest(tool, toolInput);
        const decision = await s.onPermission(request);
        events.push({ type: "permission.requested", request, decision });
        return decision.allow
          ? { behavior: "allow", updatedInput: toolInput }
          : { behavior: "deny", message: decision.message };
      };

      const options: Options = {
        ...baseOptions(cfg, s.sandbox, s.cwd, (p) => {
          pid = p.pid ?? null;
        }),
        model: s.model,
        canUseTool,
        systemPrompt: { type: "preset", preset: "claude_code", append: s.systemPrompt },
      };
      if (s.effort) options.effort = s.effort as EffortLevel;
      if (s.resumeFrom) options.resume = s.resumeFrom;

      const q = query({ prompt: input, options });
      const begin = (text: string) => {
        interrupted = false;
        rateLimited = false;
        turnText = "";
        events.push({ type: "turn.started" });
        input.push(userMessage(text));
      };

      const translate = (m: SDKMessage) => {
        switch (m.type) {
          case "system":
            if (m.subtype === "init") nativeId = m.session_id;
            return;
          case "stream_event": {
            const e = m.event as { type: string; delta?: { type: string; text?: string } };
            if (
              e.type === "content_block_delta" &&
              e.delta?.type === "text_delta" &&
              e.delta.text
            ) {
              turnText += e.delta.text;
              events.push({ type: "text.delta", text: e.delta.text });
            }
            return;
          }
          case "assistant": {
            if (m.error === "rate_limit") rateLimited = true;
            for (const block of m.message.content as {
              type: string;
              id?: string;
              name?: string;
              input?: unknown;
            }[]) {
              if (block.type !== "tool_use") continue;
              const toolInput = (block.input ?? {}) as Record<string, unknown>;
              if (block.name === "AskUserQuestion") {
                events.push({ type: "question", text: JSON.stringify(toolInput) });
              }
              events.push({
                type: "tool.called",
                id: block.id ?? "",
                tool: block.name ?? "",
                input: toolInput,
              });
            }
            return;
          }
          case "user": {
            const content = m.message.content;
            if (!Array.isArray(content)) return;
            for (const block of content as {
              type: string;
              tool_use_id?: string;
              is_error?: boolean;
              content?: unknown;
            }[]) {
              if (block.type !== "tool_result") continue;
              events.push({
                type: "tool.result",
                id: block.tool_use_id ?? "",
                ok: !block.is_error,
                output:
                  typeof block.content === "string"
                    ? block.content
                    : JSON.stringify(block.content ?? ""),
              });
            }
            return;
          }
          case "rate_limit_event": {
            const info = m.rate_limit_info;
            const quota: QuotaReport = {
              window: info.rateLimitType ?? "unknown",
              scope: MODEL_WINDOWS.has(info.rateLimitType ?? "") ? "model" : "account",
              status: info.status === "allowed_warning" ? "warning" : info.status,
              utilization: info.utilization ?? null,
              resetsAt: toMs(info.resetsAt),
            };
            if (quota.status === "rejected") rateLimited = true;
            events.push({ type: "rate_limit", quota });
            return;
          }
          case "result": {
            const window = Object.values(m.modelUsage ?? {})[0];
            const u = m.usage as unknown as Record<string, number | undefined>;
            usage = {
              inputTokens: u.input_tokens ?? 0,
              outputTokens: u.output_tokens ?? 0,
              cacheReadTokens: u.cache_read_input_tokens ?? 0,
              cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
              contextTokens:
                (u.input_tokens ?? 0) +
                  (u.cache_read_input_tokens ?? 0) +
                  (u.cache_creation_input_tokens ?? 0) || null,
              contextWindow: window?.contextWindow ?? null,
              estimated: false,
            };
            events.push({ type: "usage", usage });
            let reason: TurnEnd = "completed";
            let error: string | null = null;
            if (interrupted) reason = "interrupted";
            else if (rateLimited) {
              reason = "rate-limited";
              error = "The account hit a usage limit.";
            } else if (m.subtype === "error_max_turns") reason = "max_turns";
            else if (m.subtype !== "success" || m.is_error) {
              reason = "error";
              error = "errors" in m && Array.isArray(m.errors) ? m.errors.join("; ") : m.subtype;
            }
            const text = m.subtype === "success" ? m.result || turnText : turnText;
            events.push({ type: "turn.ended", reason, text, error });
            return;
          }
        }
      };

      void (async () => {
        try {
          for await (const m of q) translate(m);
          events.push({
            type: "session.ended",
            reason: killed ? "killed" : "completed",
            error: null,
          });
        } catch (error) {
          events.push({
            type: "session.ended",
            reason: killed ? "killed" : rateLimited ? "rate-limited" : "crashed",
            error: killed ? null : (error as Error).message,
          });
        } finally {
          events.end();
        }
      })();

      begin(s.prompt);

      return {
        nativeSessionId: () => nativeId,
        pid: () => pid,
        send: async (message) => begin(message),
        events: () => events,
        interrupt: async () => {
          interrupted = true;
          await q.interrupt();
        },
        kill: async () => {
          if (killed) return;
          killed = true;
          input.end();
          q.close();
        },
        usage: () => usage,
      };
    },
  };
}
