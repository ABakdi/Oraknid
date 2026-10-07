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
  type McpServer,
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
export function writeSettings(
  home: string,
  allowed: Iterable<string>,
  workspace?: string,
  writes: Iterable<string> = [],
) {
  const dir = join(home, ".gemini", "antigravity-cli");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(dir, "settings.json"),
    `${JSON.stringify(
      {
        permissions: {
          allow: [
            ...[...allowed].map((c) => `command(regex:^${escapeRegex(c)}$)`),
            // The worktree is agy's to edit. Outside a git repo it sees, agy asks for its own
            // file writes, and headless it can't (agy 1.2.14): they are allowed here.
            ...(workspace ? [`write_file(${workspace.replace(/\/*$/, "/")})`] : []),
            ...[...writes].map((p) => `write_file(${p})`),
          ],
        },
      },
      null,
      2,
    )}\n`,
  );
}

/**
 * The session's MCP servers, where `agy` reads them in the Leg's home
 * (ADR-021; the location is from Antigravity's guides, unverified):
 * only Oraknid's bridges, rewritten at each run.
 */
export function writeMcpConfig(home: string, servers: Record<string, McpServer>) {
  const dir = join(home, ".gemini", "config");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(dir, "mcp_config.json"),
    `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`,
  );
}

/** One tool step as agy reports it (seen with agy 1.2.14). */
export interface ToolStep {
  index: number;
  tool: string;
  input: Record<string, unknown>;
  state: string;
  output: string | null;
  error: string | null;
}

export function toolStep(u: NonNullable<AgyEvent["step_update"]>): ToolStep | null {
  const info = u.tool_info;
  if (!info) return null;
  const err = info.error as { message?: string } | undefined;
  return {
    index: u.step_index ?? 0,
    tool: String(u.tool_name ?? info.name ?? "tool"),
    input: (info.parameters ?? {}) as Record<string, unknown>,
    state: String(u.state ?? ""),
    output: typeof info.output === "string" ? info.output : null,
    error: err?.message ?? null,
  };
}

const commandOf = (step: ToolStep) =>
  typeof step.input.CommandLine === "string" ? step.input.CommandLine : null;

/**
 * What headless agy refused in one run (ADR-020): it can't ask, so a
 * command not on the allow list is denied, reported either as an
 * ERROR step saying so, or as a step DONE with no output while the
 * result lists denied actions. Its stderr note is generic and not read.
 */
export function refusals(
  steps: ToolStep[],
  deniedActions: { action?: string; display_name?: string }[],
  allowed: ReadonlySet<string>,
): { command: string | null; path: string | null; raw: string; index: number | null }[] {
  type Refusal = { command: string | null; path: string | null; raw: string; index: number | null };
  const out: Refusal[] = [];
  const used = new Set<number>();
  const of = (step: ToolStep): Refusal => {
    const command = commandOf(step);
    const path = typeof step.input.TargetFile === "string" ? step.input.TargetFile : null;
    return {
      command,
      path,
      raw: command
        ? `${step.tool}: ${command}`
        : `${step.tool} ${path ?? JSON.stringify(step.input)}`,
      index: step.index,
    };
  };
  // An error step that says it was refused.
  for (const step of steps)
    if (step.state === "ERROR" && /permission|denied/i.test(step.error ?? "")) {
      used.add(step.index);
      out.push(of(step));
    }
  // Each denied action the errors didn't account for: its latest step of that tool
  // (RunCommand is run_command), done without output, as agy reports it in a sandbox.
  const counted = new Map<string, number>();
  for (const step of steps)
    if (used.has(step.index)) counted.set(step.tool, (counted.get(step.tool) ?? 0) + 1);
  for (const d of deniedActions) {
    const tool = (d.display_name ?? "").replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
    if ((counted.get(tool) ?? 0) > 0) {
      counted.set(tool, (counted.get(tool) ?? 0) - 1);
      continue;
    }
    const step = [...steps]
      .reverse()
      .find(
        (x) =>
          x.tool === tool &&
          !used.has(x.index) &&
          x.state === "DONE" &&
          !x.output &&
          !(commandOf(x) && allowed.has(commandOf(x) as string)),
      );
    if (step) {
      used.add(step.index);
      out.push(of(step));
    } else
      out.push({
        command: null,
        path: null,
        raw: `${d.display_name ?? d.action ?? "an action"} was denied`,
        index: null,
      });
  }
  return out;
}

/** A quota error in a failed result (ADR-020): when it says so, and when it resets. */
export function quotaError(error: string): { resetsAt: number | null } | null {
  if (!/quota|rate.?limit|resource.?exhausted|\b429\b/i.test(error)) return null;
  // "Resets in 51h49m11s", "resets in 30s", "resets in 2 hours" (ADR-052 §4: kept until it clears).
  const when =
    /reset\w*\s+in\s+((?:\d+\s*(?:d|h|m|s|days?|hours?|minutes?|mins?|seconds?|secs?)(?![a-z])\s*)+)/i.exec(
      error,
    )?.[1];
  let ms = 0;
  for (const m of (when ?? "").matchAll(/(\d+)\s*([a-z]+)/gi)) {
    const unit = (m[2] as string).toLowerCase()[0];
    ms +=
      Number(m[1]) *
      (unit === "d" ? 86_400_000 : unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : 1000);
  }
  return { resetsAt: ms ? Date.now() + ms : null };
}

interface AgyEvent {
  event: string;
  init?: Record<string, unknown>;
  conversation_id?: string;
  step_update?: {
    step_index?: number;
    state?: string;
    step_type?: string;
    tool_name?: string;
    text_delta?: string;
    usage?: { input_tokens?: number };
    tool_info?: Record<string, unknown>;
  };
  result?: {
    conversation_id?: string;
    status?: string;
    response?: string;
    error?: string;
    denied_actions?: { action?: string; display_name?: string }[];
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
  /** What agy refused, with the tool call it belongs to (its result was held back). */
  denials: { command: string | null; path: string | null; raw: string; id: string | null }[];
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
      // In the Leg's sandbox: outside it agy finds my desktop keyring and looks signed in (ADR-020).
      const run = (args: string[]) => {
        const w = plan
          ? plan.sandbox.wrap({
              command: cfg.binary,
              args,
              cwd: home,
              writable: [home, ...plan.writable],
              readonly: plan.readonly,
              home,
              env,
            })
          : { command: cfg.binary, args };
        return spawnSync(w.command, w.args, { cwd: home, env, encoding: "utf8", timeout: 30_000 });
      };
      const version = run(["--version"]);
      if (version.status !== 0)
        return {
          ok: false,
          detail: version.error
            ? `Antigravity's CLI (${cfg.binary}) is not installed here.`
            : `${cfg.binary} --version failed: ${(version.stderr || version.stdout).trim()}`,
          models: offers(cfg.models),
          features,
        };
      const listed = run(["models"]);
      const said = `${listed.stdout}\n${listed.stderr}`;
      if (
        listed.status !== 0 ||
        /authentication required|not (signed|logged) in|please sign in/i.test(said)
      )
        return {
          ok: false,
          detail: /authentication|signed|logged|sign in/i.test(said)
            ? "Not signed in: press Log in on its card."
            : `agy models failed: ${said.trim().slice(0, 200)}`,
          models: offers(cfg.models),
          features,
        };
      // One per line: its id, a tab, its name (agy 1.2.14).
      const listedModels = listed.stdout
        .split("\n")
        .map((l) => {
          const [id = "", name] = l.split("\t");
          const m = /^\s*[*-]?\s*([a-z0-9][a-z0-9.-]+)\s*$/i.exec(id)?.[1] ?? "";
          return { model: m, displayName: name?.trim() || m };
        })
        .filter((m) => /\d/.test(m.model) && m.model.includes("-"));
      const models = listedModels.length
        ? listedModels.map((m) => ({ ...m, effortLevels: [], contextWindow: null }))
        : offers(cfg.models);
      if (!models.length)
        return { ok: false, detail: "agy listed no models.", models: [], features };
      return {
        ok: true,
        detail: `Antigravity ${version.stdout.trim()}, ${models.length} models.`,
        models,
        features,
      };
    },

    async start(s: SessionStart): Promise<LegSession> {
      const cfg = readConfig(s.leg);
      const home = s.sandbox?.home ?? cfg.home ?? join(tmpdir(), `oraknid-agy-${s.leg.id}`);
      const env = legEnv(home, s.sandbox);
      const events = new Channel<LegEvent>();
      const allowed = new Set<string>();
      const allowedWrites = new Set<string>();
      let conversation = s.resumeFrom;
      let usage: UsageSnapshot = emptyUsage();
      /** The conversation's size as last read: what a new run re-reads is not new. */
      let seenContext = 0;
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
        writeSettings(home, allowed, s.cwd, allowedWrites);
        writeMcpConfig(home, s.mcpServers ?? {});
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
        let denials: RunEnd["denials"] = [];
        /** The largest context one step of this run read: the conversation as it stands. */
        let runContext = 0;
        const held = new Map<number, string>();
        const steps = new Map<number, ToolStep>();
        let result: AgyEvent["result"] | null = null;
        // Its stderr is a log, and its note about denials is generic: the events say what happened.
        child.stderr?.resume();
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
            runContext = Math.max(runContext, u.usage?.input_tokens ?? 0);
            const step = toolStep(u);
            if (step) {
              const id = `${conversation ?? "agy"}:${step.index}`;
              steps.set(step.index, step);
              if (step.state === "ACTIVE")
                events.push({ type: "tool.called", id, tool: step.tool, input: step.input });
              else if (
                (step.tool === "run_command" &&
                  (step.state === "ERROR" || (step.state === "DONE" && step.output === null))) ||
                (step.state === "ERROR" && /permission|denied/i.test(step.error ?? ""))
              ) {
                // Maybe agy's own refusal: Oraknid decides first, and the Leg hears that (ADR-020).
                held.set(step.index, id);
              } else if (step.state === "DONE" || step.state === "ERROR")
                events.push({
                  type: "tool.result",
                  id,
                  ok: step.state === "DONE",
                  output: step.output ?? step.error ?? "",
                });
            }
          } else if (e.event === "init" && e.conversation_id) {
            conversation ??= e.conversation_id;
          } else if (e.event === "result" && e.result) {
            result = e.result;
            const refused = refusals([...steps.values()], e.result.denied_actions ?? [], allowed);
            denials = refused.map((r) => ({
              command: r.command,
              path: r.path,
              raw: r.raw,
              id: r.index !== null ? (held.get(r.index) ?? null) : null,
            }));
            // A held step that wasn't refused: its result after all.
            const refusedSteps = new Set(refused.map((r) => r.index));
            for (const [index, id] of held)
              if (!refusedSteps.has(index)) {
                const step = steps.get(index);
                events.push({
                  type: "tool.result",
                  id,
                  ok: step?.state === "DONE",
                  output: step?.output ?? step?.error ?? "",
                });
              }
            conversation = e.result.conversation_id || conversation;
            const r = e.result.usage ?? {};
            // agy reports each step's whole re-read of the conversation as input, with no cache:
            // only its growth is new, the rest counts as cache reads, as for other Legs.
            const total = r.input_tokens ?? 0;
            const context = runContext || total;
            const fresh = Math.min(total, Math.max(0, context - seenContext));
            seenContext = Math.max(seenContext, context);
            usage = {
              ...usage,
              inputTokens: usage.inputTokens + fresh,
              outputTokens: usage.outputTokens + (r.output_tokens ?? 0) + (r.thinking_tokens ?? 0),
              cacheReadTokens: usage.cacheReadTokens + (r.cache_read_tokens ?? 0) + (total - fresh),
              contextTokens: context,
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
            const id = d.id ?? `denied-${round}-${i}`;
            const fail = (why: string) => {
              if (!d.id)
                events.push({ type: "tool.called", id, tool: "unknown", input: { notice: d.raw } });
              events.push({ type: "tool.result", id, ok: false, output: why });
            };
            // Nothing to judge: the Leg is asked, never me (an "unknown" approval helps nobody).
            if (!d.command && !d.path) {
              const why =
                "agy refused an action Oraknid can't identify. Do it with a plain shell command or your file tools, and say exactly what you need if that fails.";
              fail(why);
              replies.push(`Refused: ${d.raw}. ${why}`);
              continue;
            }
            const request: PermissionRequest = d.command
              ? { tool: "Bash", input: { command: d.command }, command: d.command, path: null }
              : { tool: "Write", input: { file_path: d.path }, command: null, path: d.path };
            const decision = await s.onPermission(request);
            events.push({ type: "permission.requested", request, decision });
            if (decision.allow) {
              if (d.command) {
                allowed.add(d.command);
                replies.push(`Approved: run \`${d.command}\` again now.`);
              } else {
                allowedWrites.add(d.path as string);
                replies.push(`Approved: write ${d.path} again now.`);
              }
            } else {
              fail(decision.message);
              replies.push(
                `Denied: ${d.command ? `\`${d.command}\`` : d.path}. ${decision.message}`,
              );
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
