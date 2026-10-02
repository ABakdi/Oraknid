import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  Channel,
  emptyUsage,
  type LegAdapter,
  type LegConfig,
  type LegEvent,
  type LegSession,
  type PermissionRequest,
  type ProbeResult,
  type SandboxPlan,
  type SessionStart,
  type TurnEnd,
  type UsageSnapshot,
} from "@oraknid/leg-sdk";

// Antigravity through its official headless CLI, one `agy` run per turn
// in stream-json, inside the sandbox (ADR-020).

export interface AntigravityConfig {
  /** The unmodified `agy` binary. */
  binary: string;
  /** Models to offer when `agy models` can't be read. */
  models: string[];
  /** Where `agy` keeps its state when there is no sandbox plan (tests, unsandboxed jobs). */
  home: string | null;
}

export const readConfig = (leg: LegConfig): AntigravityConfig => ({
  binary: String(leg.config.binary ?? "agy"),
  models: Array.isArray(leg.config.models) ? leg.config.models.map(String) : [],
  home: typeof leg.config.home === "string" ? leg.config.home : null,
});

/** The most allow-and-replay rounds in one Oraknid turn. */
const MAX_ROUNDS = 20;

/** The Leg's own world: home, temp, XDG dirs, and no desktop keyring (ADR-020). */
export function legEnv(home: string, plan: SandboxPlan | null): Record<string, string> {
  const dirs = {
    HOME: home,
    TMPDIR: join(home, "tmp"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local", "state"),
  };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true, mode: 0o700 });
  return {
    PATH: plan?.env.PATH ?? process.env.PATH ?? "/usr/bin",
    LANG: plan?.env.LANG ?? process.env.LANG ?? "C.UTF-8",
    ...dirs,
  };
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `agy`'s settings: exactly the commands Oraknid allowed in this session. */
export function writeSettings(home: string, allowed: Iterable<string>) {
  const dir = join(home, ".gemini", "antigravity-cli");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(dir, "settings.json"),
    `${JSON.stringify(
      { permissions: { allow: [...allowed].map((c) => `command(regex:^${escapeRegex(c)}$)`) } },
      null,
      2,
    )}\n`,
  );
}

/**
 * A soft-denied action in a stderr notice. The exact wording isn't
 * documented (ADR-020): the command is read from `command(…)`, or
 * from backticks or quotes.
 */
export function softDenial(line: string): { command: string | null; raw: string } | null {
  if (!/denied|not allowed|requires approval|permission/i.test(line)) return null;
  const inCommand = /command\((.*)\)/.exec(line)?.[1];
  const quoted = /`([^`]+)`|"([^"]+)"/.exec(line);
  return { command: inCommand ?? quoted?.[1] ?? quoted?.[2] ?? null, raw: line.trim() };
}

/** A quota error in a failed result (ADR-020): when it says so, and when it resets. */
export function quotaError(error: string): { resetsAt: number | null } | null {
  if (!/quota|rate.?limit|resource.?exhausted|\b429\b/i.test(error)) return null;
  const secs = /reset\w*\s+in\s+(\d+)\s*s/i.exec(error)?.[1];
  return { resetsAt: secs ? Date.now() + Number(secs) * 1000 : null };
}

interface AgyEvent {
  event: string;
  init?: Record<string, unknown>;
  step_update?: {
    step_index?: number;
    state?: string;
    step_type?: string;
    text_delta?: string;
    tool_info?: Record<string, unknown>;
  };
  result?: {
    conversation_id?: string;
    status?: string;
    response?: string;
    error?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      thinking_tokens?: number;
      cache_read_tokens?: number;
    };
  };
}

interface RunEnd {
  status: string;
  error: string | null;
  denials: { command: string | null; raw: string }[];
}

function stopTree(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.exitCode !== null || !child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

export function createAntigravityAdapter(): LegAdapter {
  return {
    kind: "antigravity",

    async probe(leg, plan): Promise<ProbeResult> {
      const cfg = readConfig(leg);
      const features = {
        resume: true,
        tools: true,
        usage: "reported" as const,
        quotaWindows: false,
      };
      const home = plan?.home ?? cfg.home ?? join(tmpdir(), `oraknid-agy-${leg.id}`);
      const env = legEnv(home, plan);
      const offers = (ids: string[]) =>
        ids.map((m) => ({ model: m, displayName: m, effortLevels: [], contextWindow: null }));
      const version = spawnSync(cfg.binary, ["--version"], { env, encoding: "utf8" });
      if (version.status !== 0)
        return {
          ok: false,
          detail: version.error
            ? `Antigravity's CLI (${cfg.binary}) is not installed here.`
            : `${cfg.binary} --version failed: ${(version.stderr || version.stdout).trim()}`,
          models: offers(cfg.models),
          features,
        };
      const listed = spawnSync(cfg.binary, ["models"], { env, encoding: "utf8", timeout: 30_000 });
      const said = `${listed.stdout}\n${listed.stderr}`;
      if (listed.status !== 0 || /authentication required|not (signed|logged) in/i.test(said))
        return {
          ok: false,
          detail: /authentication|signed|logged/i.test(said)
            ? "Not signed in: press Log in on its card."
            : `agy models failed: ${said.trim().slice(0, 200)}`,
          models: offers(cfg.models),
          features,
        };
      const ids = listed.stdout
        .split("\n")
        .map((l) => /^\s*[*-]?\s*([a-z0-9][a-z0-9.-]+)\b/i.exec(l)?.[1] ?? "")
        .filter((m) => /\d/.test(m) && m.includes("-"));
      const models = ids.length ? ids : cfg.models;
      if (!models.length)
        return { ok: false, detail: "agy listed no models.", models: [], features };
      return {
        ok: true,
        detail: `Antigravity ${version.stdout.trim()}, ${models.length} models.`,
        models: offers(models),
        features,
      };
    },

    async start(s: SessionStart): Promise<LegSession> {
      const cfg = readConfig(s.leg);
      const home = s.sandbox?.home ?? cfg.home ?? join(tmpdir(), `oraknid-agy-${s.leg.id}`);
      const env = legEnv(home, s.sandbox);
      const events = new Channel<LegEvent>();
      const allowed = new Set<string>();
      let conversation = s.resumeFrom;
      let usage: UsageSnapshot = emptyUsage();
      let current: ChildProcess | null = null;
      let interrupted = false;
      let killed = false;
      let ended = false;
      let busy: Promise<void> = Promise.resolve();

      const endSession = (reason: "completed" | "killed" | "crashed", error: string | null) => {
        if (ended) return;
        ended = true;
        events.push({ type: "session.ended", reason, error });
        events.end();
      };

      /** One `agy` run: one message in, its events out, until its result. */
      const run = (message: string, onText: (t: string) => void): Promise<RunEnd> => {
        writeSettings(home, allowed);
        const args = [
          "--input-format",
          "stream-json",
          "--output-format",
          "stream-json",
          ...(conversation ? ["--conversation", conversation] : []),
          ...(s.model ? ["--model", s.model] : []),
          ...(s.effort ? ["--effort", s.effort] : []),
        ];
        const wrapped = s.sandbox
          ? s.sandbox.sandbox.wrap({
              command: cfg.binary,
              args,
              cwd: s.cwd,
              writable: [...new Set([s.cwd, home, ...s.sandbox.writable])],
              readonly: s.sandbox.readonly,
              home,
              env,
            })
          : { command: cfg.binary, args };
        const child = spawn(wrapped.command, wrapped.args, {
          cwd: s.cwd,
          env,
          stdio: ["pipe", "pipe", "pipe"],
          // Its own process group, so a kill reaches everything it started.
          detached: true,
        });
        current = child;
        const denials: RunEnd["denials"] = [];
        let result: AgyEvent["result"] | null = null;
        createInterface({ input: child.stderr as NodeJS.ReadableStream }).on("line", (line) => {
          const d = softDenial(line);
          if (d) denials.push(d);
        });
        createInterface({ input: child.stdout as NodeJS.ReadableStream }).on("line", (line) => {
          let e: AgyEvent;
          try {
            e = JSON.parse(line) as AgyEvent;
          } catch {
            return;
          }
          if (e.event === "step_update" && e.step_update) {
            const u = e.step_update;
            if (u.text_delta) onText(u.text_delta);
            const tool = u.tool_info;
            if (tool) {
              const id = String(tool.id ?? `${u.step_index ?? 0}`);
              const name = String(tool.name ?? u.step_type ?? "tool");
              const input = (tool.input ?? tool.args ?? {}) as Record<string, unknown>;
              if (u.state === "ACTIVE") events.push({ type: "tool.called", id, tool: name, input });
              else if (u.state === "DONE")
                events.push({
                  type: "tool.result",
                  id,
                  ok: !tool.error && tool.status !== "ERROR",
                  output: String(tool.output ?? tool.error ?? ""),
                });
            }
          } else if (e.event === "result" && e.result) {
            result = e.result;
            conversation = e.result.conversation_id || conversation;
            const r = e.result.usage ?? {};
            usage = {
              ...usage,
              inputTokens: usage.inputTokens + (r.input_tokens ?? 0),
              outputTokens: usage.outputTokens + (r.output_tokens ?? 0) + (r.thinking_tokens ?? 0),
              cacheReadTokens: usage.cacheReadTokens + (r.cache_read_tokens ?? 0),
              contextTokens: (r.input_tokens ?? 0) + (r.cache_read_tokens ?? 0),
            };
            events.push({ type: "usage", usage });
            child.stdin?.end();
          }
        });
        child.stdin?.write(`${JSON.stringify({ event: "user", message: { content: message } })}\n`);
        return new Promise((resolve) => {
          const done = (status: string, error: string | null) => {
            current = null;
            resolve({ status, error, denials });
          };
          child.once("error", (e) => done("ERROR", `agy could not start: ${e.message}`));
          child.once("close", (code, signal) => {
            const r = result as AgyEvent["result"] | null;
            if (r) return done(String(r.status ?? "ERROR"), r.error || null);
            if (signal === "SIGINT" || interrupted) return done("INTERRUPTED", null);
            done("ERROR", `agy exited (${signal ?? `code ${code}`}) without a result.`);
          });
        });
      };

      /** One Oraknid turn: runs, replays approved actions, ends once. */
      const turn = async (first: string) => {
        events.push({ type: "turn.started" });
        interrupted = false;
        let text = "";
        let message = first;
        let end: { reason: TurnEnd; error: string | null } = { reason: "completed", error: null };
        for (let round = 0; ; round++) {
          const r = await run(message, (t) => {
            text += t;
            events.push({ type: "text.delta", text: t });
          });
          if (killed) return;
          if (r.status === "INTERRUPTED" || r.status === "CANCELED" || interrupted) {
            end = { reason: "interrupted", error: null };
            break;
          }
          if (r.status !== "SUCCESS") {
            const quota = r.error ? quotaError(r.error) : null;
            if (quota) {
              events.push({
                type: "rate_limit",
                quota: {
                  window: "plan",
                  scope: "account",
                  status: "rejected",
                  utilization: null,
                  resetsAt: quota.resetsAt,
                },
              });
              end = { reason: "rate-limited", error: r.error };
            } else end = { reason: "error", error: r.error ?? `agy ended ${r.status}.` };
            break;
          }
          if (!r.denials.length) break;
          if (round + 1 >= MAX_ROUNDS) {
            end = { reason: "max_turns", error: "Too many approval rounds in one turn." };
            break;
          }
          // Soft-denied by agy: Oraknid's policy decides, and the Leg is told (ADR-020).
          const replies: string[] = [];
          for (const [i, d] of r.denials.entries()) {
            const request: PermissionRequest = {
              tool: d.command ? "Bash" : "unknown",
              input: d.command ? { command: d.command } : { notice: d.raw },
              command: d.command,
              path: null,
            };
            const decision = await s.onPermission(request);
            events.push({ type: "permission.requested", request, decision });
            if (decision.allow && d.command) {
              allowed.add(d.command);
              replies.push(`Approved: run \`${d.command}\` again now.`);
            } else {
              const why = decision.allow
                ? "It can't be allowed by its command text."
                : decision.message;
              const id = `denied-${round}-${i}`;
              events.push({ type: "tool.called", id, tool: request.tool, input: request.input });
              events.push({ type: "tool.result", id, ok: false, output: why });
              replies.push(`Denied: ${d.command ? `\`${d.command}\`` : d.raw}. ${why}`);
            }
          }
          message = `${replies.join("\n")}\nContinue the task.`;
        }
        events.push({ type: "turn.ended", reason: end.reason, text, error: end.error });
      };

      const queue = (message: string) => {
        busy = busy.then(() => turn(message)).catch((e) => endSession("crashed", String(e)));
        return busy;
      };
      void queue(s.resumeFrom ? s.prompt : `${s.systemPrompt}\n\n---\n\n${s.prompt}`);

      return {
        nativeSessionId: () => conversation,
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
