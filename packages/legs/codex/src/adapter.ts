import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import {
  Channel,
  emptyUsage,
  type LegAdapter,
  type LegConfig,
  type LegEvent,
  type LegSession,
  type McpServer,
  type PermissionDecision,
  type PermissionRequest,
  type PlanUsageReport,
  type PreToolDecision,
  type ProbeResult,
  type SandboxPlan,
  type SessionStart,
  type TurnEnd,
  type UsageSnapshot,
} from "@oraknid/leg-sdk";
import { type HookReply, type HookServer, startHookServer } from "./hook.ts";
import {
  type CodexEvent,
  type CodexItem,
  type CodexUsage,
  modelsFromCatalog,
  planFromRateLimits,
  requestsOf,
  resultOf,
  tomlString,
  toolOf,
  usageLimit,
} from "./parse.ts";

// OpenAI's Codex CLI, headless (ADR-057): one `codex exec --json` run per
// turn, continued with `codex exec resume <thread>`, inside Oraknid's
// sandbox, with a CODEX_HOME of the Leg's own. Codex's own sandbox is off
// and it never asks (Oraknid's bwrap is the boundary); every command,
// patch and MCP call goes through Oraknid's policy first, by Codex's
// PreToolUse hook, and the task's checks hold a turn open by its Stop hook.

export interface CodexConfig {
  /** The unmodified `codex` binary. */
  binary: string;
  /** The Leg's own CODEX_HOME, where its login lives (never my ~/.codex). */
  codexHome: string | null;
  /** Models to offer when Codex's catalog can't be read. */
  models: string[];
  /** Signed in with an OpenAI API key from the keychain rather than a ChatGPT login. */
  apiKey: boolean;
}

export const readConfig = (leg: LegConfig): CodexConfig => ({
  binary: String(leg.config.binary ?? "codex"),
  codexHome: typeof leg.config.codexHome === "string" ? leg.config.codexHome : null,
  models: Array.isArray(leg.config.models) ? leg.config.models.map(String) : [],
  apiKey: leg.config.auth === "api-key",
});

/** How many times the Stop hook may keep a turn going while the checks fail (ADR-052 §2). */
export const STOP_HOLDS = 3;
/** Hooks wait for my answer as long as it takes: a day, Codex's limit for them here. */
const HOOK_TIMEOUT_S = 86_400;

/**
 * The binary's real file: its install (~/.local/bin/codex links into
 * ~/.codex/packages/standalone/…) is bound into the sandbox by its real
 * path, so it runs by that path, found again at each start (an update
 * moves it).
 */
export function resolveBinary(binary: string, path = process.env.PATH ?? ""): string {
  const candidates = binary.includes("/") ? [binary] : path.split(":").map((d) => join(d, binary));
  for (const c of candidates)
    try {
      if (c && existsSync(c)) return realpathSync(c);
    } catch {}
  return binary;
}

/**
 * The folder to bind for the binary: its package (the standalone install
 * keeps `rg` and its resources beside `bin/`), else its own folder.
 */
export function codexInstallDir(binary: string, path?: string): string | null {
  const real = resolveBinary(binary, path);
  if (!real.includes("/") || !existsSync(real)) return null;
  const dir = dirname(real);
  const root = dirname(dir);
  return basename(dir) === "bin" && existsSync(join(root, "codex-package.json")) ? root : dir;
}

/** The Leg's CODEX_HOME: a job's own when it has one, the Leg's, or one for tests. */
export function codexHomeOf(cfg: CodexConfig, plan: SandboxPlan | null, legId: string): string {
  const home = plan?.configDir ?? cfg.codexHome ?? join(tmpdir(), `oraknid-codex-${legId}`);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return home;
}

/**
 * The settings every run shares, in the Leg's CODEX_HOME (ADR-057): the
 * login in a file (no desktop keyring in the sandbox), no update check,
 * no analytics, no history file, and keys kept from commands' environment.
 * A run's own settings come as `-c` flags, so jobs sharing it never clash.
 */
export const BASE_CONFIG = `# Written by Oraknid for this Leg (ADR-057); each run adds its own settings as -c flags.
cli_auth_credentials_store = "file"
check_for_update_on_startup = false
approval_policy = "never"
sandbox_mode = "danger-full-access"

[analytics]
enabled = false

[feedback]
enabled = false

[history]
persistence = "none"

[shell_environment_policy]
exclude = ["CODEX_API_KEY", "OPENAI_API_KEY"]
`;

export function writeBaseConfig(codexHome: string) {
  const file = join(codexHome, "config.toml");
  try {
    if (readFileSync(file, "utf8") === BASE_CONFIG) return;
  } catch {}
  writeFileSync(file, BASE_CONFIG, { mode: 0o600 });
}

/** The process's whole environment: nothing else of the daemon's leaks in. */
export function codexEnv(
  home: string,
  codexHome: string,
  plan: SandboxPlan | null,
  credential: string | null,
): Record<string, string> {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return {
    PATH: plan?.env.PATH ?? process.env.PATH ?? "/usr/bin",
    LANG: plan?.env.LANG ?? process.env.LANG ?? "C.UTF-8",
    TERM: "dumb",
    NO_COLOR: "1",
    HOME: home,
    CODEX_HOME: codexHome,
    ...(credential ? { CODEX_API_KEY: credential } : {}),
  };
}

/** A server name as a TOML key Codex reads: Oraknid's bridges are `oraknid-<tool>`. */
const keyOf = (name: string) => name.replace(/[^A-Za-z0-9_-]/g, "_");

/** The `-c` flags giving a run Oraknid's MCP bridges (ADR-021), and only those. */
export function mcpFlags(servers: Record<string, McpServer>): string[] {
  return Object.entries(servers).flatMap(([name, m]) => [
    "-c",
    `mcp_servers.${keyOf(name)}={command=${tomlString(m.command)},args=[${m.args
      .map(tomlString)
      .join(",")}],startup_timeout_sec=30,tool_timeout_sec=3600}`,
  ]);
}

/** The `-c` flags that send Codex's PreToolUse (and, with checks, Stop) hooks to Oraknid. */
export function hookFlags(command: string, stop: boolean): string[] {
  const hook = (timeout: number) =>
    `[{hooks=[{type="command",command=${tomlString(command)},timeout=${timeout}}]}]`;
  return [
    "-c",
    `hooks.PreToolUse=${hook(HOOK_TIMEOUT_S)}`,
    ...(stop ? ["-c", `hooks.Stop=${hook(3600)}`] : []),
  ];
}

/** One run's arguments: a new thread, or the thread `resume` continues; the prompt on stdin. */
export function runArgs(o: {
  model: string | null;
  effort: string | null;
  resume: string | null;
  mcp: Record<string, McpServer>;
  hookCommand: string | null;
  stopHook: boolean;
}): string[] {
  const shared = [
    "--json",
    "--skip-git-repo-check",
    // My own and the repository's execpolicy rules stay out: Oraknid's policy decides.
    "--ignore-rules",
    // The hooks are Oraknid's own, written for this run; a repository's aren't loaded
    // (an untrusted project's .codex/ layers never are).
    ...(o.hookCommand ? ["--dangerously-bypass-hook-trust"] : []),
    "-c",
    'approval_policy="never"',
    "-c",
    'sandbox_mode="danger-full-access"',
    "-c",
    "features.daemon_auto_start=false",
    ...(o.model ? ["-m", o.model] : []),
    ...(o.effort ? ["-c", `model_reasoning_effort=${tomlString(o.effort)}`] : []),
    ...mcpFlags(o.mcp),
    ...(o.hookCommand ? hookFlags(o.hookCommand, o.stopHook) : []),
  ];
  return o.resume ? ["exec", "resume", ...shared, o.resume, "-"] : ["exec", ...shared, "-"];
}

function stopTree(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.exitCode !== null || !child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

/** Runs a short `codex` command (probe, catalog), in the sandbox when there is one. */
function runOnce(
  binary: string,
  args: string[],
  home: string,
  codexHome: string,
  plan: SandboxPlan | null,
  timeout = 30_000,
) {
  const env = codexEnv(home, codexHome, plan, null);
  const w = plan
    ? plan.sandbox.wrap({
        command: binary,
        args,
        cwd: home,
        writable: [...new Set([home, codexHome, ...plan.writable])],
        readonly: plan.readonly,
        home,
        env,
      })
    : { command: binary, args };
  return spawnSync(w.command, w.args, { cwd: home, env, encoding: "utf8", timeout });
}

/** The thread's totals since the last reading: Codex reports running totals per thread. */
function since(now: CodexUsage, before: CodexUsage | null): Required<CodexUsage> {
  const n = (u: CodexUsage | null, k: keyof CodexUsage) => u?.[k] ?? 0;
  // A total smaller than the last is a new count (a resumed thread in a new process).
  const fresh = !before || n(now, "input_tokens") < n(before, "input_tokens");
  const d = (k: keyof CodexUsage) => Math.max(0, n(now, k) - (fresh ? 0 : n(before, k)));
  return {
    input_tokens: d("input_tokens"),
    cached_input_tokens: d("cached_input_tokens"),
    cache_write_input_tokens: d("cache_write_input_tokens"),
    output_tokens: d("output_tokens"),
    reasoning_output_tokens: d("reasoning_output_tokens"),
  };
}

interface RunEnd {
  reason: TurnEnd;
  error: string | null;
}

export function createCodexAdapter(): LegAdapter {
  return {
    kind: "codex",

    async probe(leg, plan): Promise<ProbeResult> {
      const cfg = readConfig(leg);
      const features = {
        resume: true,
        tools: true,
        usage: "reported" as const,
        quotaWindows: !cfg.apiKey,
        // Its PreToolUse hook asks for every call; its Stop hook holds the turn (ADR-057).
        inlineGate: true,
        preToolHook: true,
        stopHook: true,
        steer: false,
      };
      const binary = resolveBinary(cfg.binary, plan?.env.PATH);
      const home = plan?.home ?? join(tmpdir(), `oraknid-codex-home-${leg.id}`);
      const codexHome = codexHomeOf(cfg, plan, leg.id);
      writeBaseConfig(codexHome);
      const offers = (ids: string[]) =>
        ids.map((m) => ({ model: m, displayName: m, effortLevels: [], contextWindow: null }));
      const version = runOnce(binary, ["--version"], home, codexHome, plan);
      if (version.status !== 0)
        return {
          ok: false,
          detail: version.error
            ? `OpenAI's Codex CLI (${cfg.binary}) is not installed here.`
            : `${cfg.binary} --version failed: ${(version.stderr || version.stdout).trim().slice(0, 200)}`,
          models: offers(cfg.models),
          features,
        };
      const named = /\d+\.\d+(\.\d+)?/.exec(version.stdout)?.[0] ?? version.stdout.trim();
      let account = "an OpenAI API key";
      if (!cfg.apiKey) {
        // The login in the Leg's CODEX_HOME, as Codex itself reads it.
        const status = runOnce(binary, ["login", "status"], home, codexHome, plan);
        const said = `${status.stdout}\n${status.stderr}`;
        if (status.status !== 0 || !/logged in/i.test(said) || /not logged in/i.test(said))
          return {
            ok: false,
            detail: "Not signed in: press Log in on its card.",
            models: offers(cfg.models),
            features,
          };
        account = /api key/i.test(said) ? "an API key" : "a ChatGPT account";
      }
      // The catalog Codex itself offers, with each model's reasoning levels and context window.
      const catalog = runOnce(binary, ["debug", "models"], home, codexHome, plan, 60_000);
      const listed = catalog.status === 0 ? modelsFromCatalog(catalog.stdout, cfg.apiKey) : [];
      const models = listed.length ? listed : offers(cfg.models);
      if (!models.length)
        return {
          ok: false,
          detail: `Codex listed no models: ${(catalog.stderr || "").trim().slice(0, 200)}`,
          models: [],
          features,
        };
      return {
        ok: true,
        detail: `Codex ${named}, signed in with ${account}, ${models.length} models.`,
        models,
        features,
      };
    },

    /**
     * The plan's windows from Codex's app server (`account/rateLimits/read`),
     * as its /status shows them (ADR-057): no prompt, no tokens, inside the
     * sandbox. null when it can't say; nothing for an API key.
     */
    async planUsage(leg, plan): Promise<PlanUsageReport | null> {
      const cfg = readConfig(leg);
      if (cfg.apiKey) return { available: false, windows: [] };
      const binary = resolveBinary(cfg.binary, plan?.env.PATH);
      const home = plan?.home ?? join(tmpdir(), `oraknid-codex-home-${leg.id}`);
      const codexHome = codexHomeOf(cfg, plan, leg.id);
      writeBaseConfig(codexHome);
      const env = codexEnv(home, codexHome, plan, null);
      const args = ["app-server", "-c", "features.daemon_auto_start=false"];
      const w = plan
        ? plan.sandbox.wrap({
            command: binary,
            args,
            cwd: home,
            writable: [...new Set([home, codexHome, ...plan.writable])],
            readonly: plan.readonly,
            home,
            env,
          })
        : { command: binary, args };
      const child = spawn(w.command, w.args, {
        cwd: home,
        env,
        stdio: ["pipe", "pipe", "ignore"],
        detached: true,
      });
      child.stdin?.on("error", () => {});
      const send = (o: unknown) => child.stdin?.write(`${JSON.stringify(o)}\n`);
      try {
        return await new Promise<PlanUsageReport | null>((resolve) => {
          const timer = setTimeout(() => resolve(null), 30_000);
          const done = (r: PlanUsageReport | null) => {
            clearTimeout(timer);
            resolve(r);
          };
          child.once("error", () => done(null));
          child.once("close", () => done(null));
          createInterface({ input: child.stdout as NodeJS.ReadableStream }).on("line", (line) => {
            let m: { id?: number; result?: unknown; error?: unknown };
            try {
              m = JSON.parse(line);
            } catch {
              return;
            }
            if (m.id === 1) {
              if (m.error) return done(null);
              send({ method: "initialized", params: {} });
              send({ id: 2, method: "account/rateLimits/read" });
            } else if (m.id === 2) done(m.error ? null : planFromRateLimits(m.result));
          });
          send({
            id: 1,
            method: "initialize",
            params: { clientInfo: { name: "oraknid", title: "Oraknid", version: "1" } },
          });
        });
      } finally {
        child.stdin?.end();
        stopTree(child, "SIGKILL");
      }
    },

    async start(s: SessionStart): Promise<LegSession> {
      const cfg = readConfig(s.leg);
      const binary = resolveBinary(cfg.binary, s.sandbox?.env.PATH);
      const home = s.sandbox?.home ?? join(tmpdir(), `oraknid-codex-home-${s.leg.id}`);
      const codexHome = codexHomeOf(cfg, s.sandbox, s.leg.id);
      writeBaseConfig(codexHome);
      const env = codexEnv(home, codexHome, s.sandbox, s.credential);
      const events = new Channel<LegEvent>();
      const auto = s.permissionMode === "auto";
      let thread = s.resumeFrom;
      let usage: UsageSnapshot = emptyUsage();
      let totals: CodexUsage | null = null;
      let current: ChildProcess | null = null;
      let interrupted = false;
      let killed = false;
      let ended = false;
      let busy: Promise<void> = Promise.resolve();
      let runs = 0;
      let turnText = "";
      /** Times the Stop hook kept this turn going (ADR-052 §2). */
      let held = 0;
      /** Actions Oraknid refused and already reported: Codex's own report of them is not repeated. */
      const refused = new Set<string>();
      let refusals = 0;
      /**
       * Tool calls Codex put through Oraknid's PreToolUse hook. The hook is how every action
       * is judged (ADR-057): a command or a patch Codex runs before any hook call means its
       * hooks aren't active (a release that changed them), and the session is stopped at
       * once rather than run unchecked.
       */
      let hookCalls = 0;

      const endSession = (reason: "completed" | "killed" | "crashed", error: string | null) => {
        if (ended) return;
        ended = true;
        hooks.close();
        events.push({ type: "session.ended", reason, error });
        events.end();
      };

      /** Oraknid's word on one request: its layer 1 in auto mode, then its policy (ADR-053). */
      const decide = async (request: PermissionRequest): Promise<PermissionDecision> => {
        if (auto && s.onPreToolUse) {
          let d: PreToolDecision;
          try {
            d = await s.onPreToolUse(request);
          } catch {
            d = { decision: "ask" };
          }
          if (d?.decision === "deny") {
            events.push({ type: "permission.denied", request, by: "oraknid", reason: d.message });
            return { allow: false, message: d.message };
          }
          if (d?.decision === "allow") return { allow: true, why: d.reason };
          // Codex has no classifier of its own here: what layer 1 leaves goes to the policy.
        }
        const decision = await s.onPermission(request);
        events.push({ type: "permission.requested", request, decision });
        return decision;
      };

      const keyOfRequest = (r: PermissionRequest) => r.command ?? r.path ?? r.tool;

      /** Codex's hooks: every tool through the policy, the checks before a turn ends. */
      const onHook = async (input: Record<string, unknown>): Promise<HookReply> => {
        if (input.hook_event_name === "Stop") {
          if (!s.onStop || held >= STOP_HOLDS) return { exit: 0 };
          const last =
            typeof input.last_assistant_message === "string"
              ? input.last_assistant_message
              : turnText;
          const reason = await s.onStop(last).catch(() => null);
          if (!reason) return { exit: 0 };
          held++;
          return { exit: 0, stdout: JSON.stringify({ decision: "block", reason }) };
        }
        if (input.hook_event_name !== "PreToolUse") return { exit: 0 };
        hookCalls++;
        const requests = requestsOf(String(input.tool_name ?? ""), input.tool_input);
        for (const request of requests) {
          const decision = await decide(request);
          if (decision.allow) continue;
          // Reported here, at once: Codex may not report a tool its hook blocked.
          const id = `codex-refused-${++refusals}`;
          refused.add(keyOfRequest(request));
          events.push({ type: "tool.called", id, tool: request.tool, input: request.input });
          events.push({ type: "tool.result", id, ok: false, output: decision.message });
          return {
            exit: 0,
            stdout: JSON.stringify({
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: decision.message,
              },
            }),
          };
        }
        return { exit: 0 };
      };
      const hooks: HookServer = await startHookServer(onHook);

      /** One `codex exec` run: one message in, its events out, until it exits. */
      const run = (message: string): Promise<RunEnd> => {
        const n = ++runs;
        const args = runArgs({
          model: s.model || null,
          effort: s.effort,
          resume: thread,
          mcp: s.mcpServers ?? {},
          hookCommand: hooks.command,
          stopHook: !!s.onStop,
        });
        const wrapped = s.sandbox
          ? s.sandbox.sandbox.wrap({
              command: binary,
              args,
              cwd: s.cwd,
              writable: [...new Set([s.cwd, home, codexHome, hooks.dir, ...s.sandbox.writable])],
              // The hook's Node, read-only.
              readonly: [...new Set([...s.sandbox.readonly, dirname(process.execPath)])],
              home,
              env,
            })
          : { command: binary, args };
        const child = spawn(wrapped.command, wrapped.args, {
          cwd: s.cwd,
          env,
          stdio: ["pipe", "pipe", "pipe"],
          // Its own process group, so a kill reaches everything it started.
          detached: true,
        });
        current = child;
        let completed = false;
        let failed: string | null = null;
        let lastError: string | null = null;
        let stderr = "";
        const started = new Set<string>();
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (d: string) => {
          stderr = (stderr + d).slice(-4000);
        });

        const item = (phase: string, it: CodexItem) => {
          const id = `${n}:${it.id}`;
          if (it.type === "agent_message") {
            if (phase !== "item.completed" || !it.text) return;
            const t = turnText ? `\n\n${it.text}` : it.text;
            turnText += t;
            events.push({ type: "text.delta", text: t });
            return;
          }
          if (it.type === "reasoning") {
            if (phase === "item.completed" && it.text)
              events.push({ type: "thinking.delta", text: it.text });
            return;
          }
          if (it.type === "error") {
            if (it.message) lastError = it.message;
            return;
          }
          const tool = toolOf(it);
          if (!tool) return;
          if (
            hookCalls === 0 &&
            (it.type === "command_execution" ||
              it.type === "file_change" ||
              it.type === "mcp_tool_call") &&
            !ended
          ) {
            const what = it.type === "command_execution" ? `\`${it.command ?? ""}\`` : tool.tool;
            const why = `Codex ran ${what} without asking Oraknid: its PreToolUse hook isn't active in this Codex version. The session was stopped so nothing runs unchecked.`;
            events.push({
              type: "permission.denied",
              request: {
                tool: tool.tool,
                input: tool.input,
                command: it.type === "command_execution" ? (it.command ?? null) : null,
                path: null,
              },
              by: "oraknid",
              reason: why,
            });
            current?.kill("SIGKILL");
            endSession("crashed", why);
            return;
          }
          // What Oraknid refused was reported when it refused it.
          if (it.type === "command_execution" && refused.has(it.command ?? "")) {
            if (phase === "item.completed") refused.delete(it.command ?? "");
            return;
          }
          if (!started.has(id)) {
            started.add(id);
            events.push({ type: "tool.called", id, tool: tool.tool, input: tool.input });
          }
          if (phase === "item.completed") events.push({ type: "tool.result", id, ...resultOf(it) });
        };

        createInterface({ input: child.stdout as NodeJS.ReadableStream }).on("line", (line) => {
          let e: CodexEvent;
          try {
            e = JSON.parse(line) as CodexEvent;
          } catch {
            return;
          }
          switch (e.type) {
            case "thread.started":
              if (e.thread_id) thread = e.thread_id;
              return;
            case "item.started":
            case "item.updated":
            case "item.completed":
              if (e.item) item(e.type, e.item);
              return;
            case "turn.completed": {
              completed = true;
              if (!e.usage) return;
              const d = since(e.usage, totals);
              totals = e.usage;
              usage = {
                ...usage,
                // OpenAI's input counts its cached part; Oraknid keeps them apart.
                inputTokens:
                  usage.inputTokens + Math.max(0, d.input_tokens - d.cached_input_tokens),
                cacheReadTokens: usage.cacheReadTokens + d.cached_input_tokens,
                cacheWriteTokens: usage.cacheWriteTokens + d.cache_write_input_tokens,
                // Reasoning is part of the output already.
                outputTokens: usage.outputTokens + d.output_tokens,
              };
              events.push({ type: "usage", usage });
              return;
            }
            case "turn.failed":
              failed = e.error?.message ?? "The turn failed.";
              return;
            case "error":
              if (e.message) lastError = e.message;
              return;
          }
        });
        // A process that never started, or left early, doesn't take the message: its end says so.
        child.stdin?.on("error", () => {});
        child.stdin?.end(message);
        return new Promise((resolve) => {
          let settled = false;
          const done = (end: RunEnd) => {
            if (settled) return;
            settled = true;
            current = null;
            resolve(end);
          };
          child.once("error", (e) =>
            done({ reason: "error", error: `codex could not start: ${e.message}` }),
          );
          child.once("close", (code, signal) => {
            if (interrupted) return done({ reason: "interrupted", error: null });
            if (completed && !failed) return done({ reason: "completed", error: null });
            const error =
              failed ??
              lastError ??
              `codex exited (${signal ?? `code ${code}`}) without finishing the turn${
                stderr.trim() ? `: ${stderr.trim().split("\n").slice(-3).join(" ")}` : "."
              }`;
            done({ reason: "error", error });
          });
        });
      };

      /** One Oraknid turn: one run; the Stop hook may keep it going inside. */
      const turn = async (message: string) => {
        events.push({ type: "turn.started" });
        interrupted = false;
        turnText = "";
        held = 0;
        refused.clear();
        const r = await run(message);
        if (killed) return;
        let end = r;
        const limit = r.error && r.reason === "error" ? usageLimit(r.error) : null;
        if (limit) {
          events.push({
            type: "rate_limit",
            quota: {
              window: "plan",
              scope: "account",
              status: "rejected",
              utilization: null,
              resetsAt: limit.resetsAt,
            },
          });
          end = { reason: "rate-limited", error: r.error };
        }
        events.push({ type: "turn.ended", reason: end.reason, text: turnText, error: end.error });
      };

      const queue = (message: string) => {
        busy = busy.then(() => turn(message)).catch((e) => endSession("crashed", String(e)));
        return busy;
      };
      // The context pack leads the thread's first message: it stays in the thread on resume.
      void queue(s.resumeFrom ? s.prompt : `${s.systemPrompt}\n\n---\n\n${s.prompt}`);

      return {
        nativeSessionId: () => thread,
        pid: () => current?.pid ?? null,
        send: async (message) => {
          void queue(message);
        },
        events: () => events,
        interrupt: async () => {
          interrupted = true;
          if (current) stopTree(current, "SIGINT");
        },
        kill: async () => {
          killed = true;
          if (current) stopTree(current, "SIGKILL");
          endSession("killed", null);
        },
        usage: () => usage,
      };
    },
  };
}
