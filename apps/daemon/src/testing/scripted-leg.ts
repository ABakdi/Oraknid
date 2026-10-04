import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LegKind } from "@oraknid/contracts";
import {
  Channel,
  emptyUsage,
  type LegAdapter,
  type LegEvent,
  type QuotaReport,
  type SessionStart,
} from "@oraknid/leg-sdk";

export type Action =
  | { write: string; content: string }
  | { run: string }
  | { say: string }
  | { rateLimit: QuotaReport }
  /** Keep the turn open until interrupted or killed. */
  | { hang: true }
  /** Calls a job's tool through the bridge it was given (ADR-021), like a real Leg's MCP client. */
  | { mcp: { server: string; tool: string; args?: Record<string, unknown> } }
  /** Asks permission as the Leg would (an OpenCode ask for its own tmp), doing nothing else. */
  | { ask: { tool: string; path?: string; command?: string } }
  /** The turn ends on an error, as a provider's 500 ends it. */
  | { fail: string };

export interface TurnContext {
  leg: string;
  model: string;
  cwd: string;
  /** The message that started this turn. */
  message: string;
  system: string;
  /** Turn number within this session, from 1. */
  turn: number;
  /** Sessions started on this Leg so far, from 1. */
  session: number;
  /** The session's HOME (a job's own home on the Leg), when sandboxed. */
  home: string | null;
}

/**
 * A coding Leg whose behaviour a test scripts turn by turn. It really
 * writes into the worktree, and asks permission before running commands
 * (which it really runs), like an agent would.
 */
export function scriptedLeg(
  script: (t: TurnContext) => Action[],
  /** Another kind of Leg, with other models (M13.22: a stand-in OpenCode with free models). */
  o: { kind?: LegKind; models?: string[] } = {},
) {
  const log: TurnContext[] = [];
  /** What each `ask` was answered. */
  const asks: { tool: string; path: string | null; allow: boolean }[] = [];
  /** What each tool call returned, in order: the text, and whether it was an error. */
  const mcpResults: { tool: string; text: string; isError: boolean }[] = [];
  const sessionsPerLeg = new Map<string, number>();
  const adapter: LegAdapter = {
    kind: o.kind ?? "claude-code",
    async probe() {
      return {
        ok: true,
        detail: "scripted",
        models: o.models
          ? o.models.map((m) => ({
              model: m,
              displayName: m,
              effortLevels: [],
              contextWindow: null,
            }))
          : [
              {
                model: "opus",
                displayName: "Opus",
                effortLevels: ["low", "medium", "high"],
                contextWindow: null,
              },
              {
                model: "sonnet",
                displayName: "Sonnet",
                effortLevels: ["low", "medium", "high"],
                contextWindow: null,
              },
              { model: "haiku", displayName: "Haiku", effortLevels: [], contextWindow: null },
            ],
        features: { resume: false, tools: true, usage: "reported", quotaWindows: true },
      };
    },
    async start(s: SessionStart) {
      const events = new Channel<LegEvent>();
      const session = (sessionsPerLeg.get(s.leg.name) ?? 0) + 1;
      sessionsPerLeg.set(s.leg.name, session);
      let turn = 0;
      let stop: (() => void) | null = null;
      let killed = false;
      let interrupted = false;
      let tokens = 0;

      async function runTurn(message: string) {
        turn++;
        interrupted = false;
        events.push({ type: "turn.started" });
        const ctx: TurnContext = {
          leg: s.leg.name,
          model: s.model,
          cwd: s.cwd,
          message,
          system: s.systemPrompt,
          turn,
          session,
          home: s.sandbox?.home ?? null,
        };
        log.push(ctx);
        let text = "";
        for (const a of script(ctx)) {
          if (killed) return;
          if ("write" in a) {
            const p = join(s.cwd, a.write);
            const decision = await s.onPermission({
              tool: "Write",
              input: { file_path: p },
              command: null,
              path: p,
            });
            if (decision.allow) {
              mkdirSync(dirname(p), { recursive: true });
              writeFileSync(p, a.content);
            }
          } else if ("run" in a) {
            const id = `c${Math.random()}`;
            events.push({ type: "tool.called", id, tool: "Bash", input: { command: a.run } });
            const decision = await s.onPermission({
              tool: "Bash",
              input: { command: a.run },
              command: a.run,
              path: null,
            });
            if (!decision.allow) {
              events.push({ type: "tool.result", id, ok: false, output: decision.message });
              continue;
            }
            // Asynchronous like a real Leg's tool: other sessions go on meanwhile.
            const r = await runShell(a.run, s.cwd);
            events.push({
              type: "tool.result",
              id,
              ok: r.status === 0,
              output: `${r.stdout}${r.stderr}`,
            });
          } else if ("say" in a) {
            text += a.say;
            events.push({ type: "text.delta", text: a.say });
          } else if ("rateLimit" in a) {
            events.push({ type: "rate_limit", quota: a.rateLimit });
            events.push({ type: "turn.ended", reason: "rate-limited", text, error: "usage limit" });
            return;
          } else if ("mcp" in a) {
            const name = `mcp__${a.mcp.server}__${a.mcp.tool}`;
            const id = `m${Math.random()}`;
            events.push({ type: "tool.called", id, tool: name, input: a.mcp.args ?? {} });
            const leg = await s.onPermission({
              tool: name,
              input: a.mcp.args ?? {},
              command: null,
              path: null,
            });
            const server = s.mcpServers?.[a.mcp.server];
            const r =
              leg.allow && server
                ? await callMcp(server, a.mcp.tool, a.mcp.args ?? {})
                : { text: leg.allow ? "no such server" : leg.message, isError: true };
            mcpResults.push({ tool: a.mcp.tool, ...r });
            events.push({ type: "tool.result", id, ok: !r.isError, output: r.text });
          } else if ("ask" in a) {
            const d = await s.onPermission({
              tool: a.ask.tool,
              input: {},
              command: a.ask.command ?? null,
              path: a.ask.path ?? null,
            });
            asks.push({ tool: a.ask.tool, path: a.ask.path ?? null, allow: d.allow });
          } else if ("fail" in a) {
            events.push({ type: "turn.ended", reason: "error", text, error: a.fail });
            return;
          } else if ("hang" in a) {
            events.push({ type: "text.delta", text: "working…" });
            await new Promise<void>((r) => {
              stop = r;
            });
            stop = null;
            if (killed) return;
            if (interrupted) {
              events.push({ type: "turn.ended", reason: "interrupted", text, error: null });
              return;
            }
          }
        }
        tokens += 1000;
        events.push({
          type: "usage",
          usage: {
            ...emptyUsage(),
            inputTokens: tokens,
            outputTokens: 200,
            contextTokens: tokens,
            contextWindow: 200_000,
          },
        });
        events.push({ type: "turn.ended", reason: "completed", text, error: null });
      }

      let queue = Promise.resolve();
      const send = (m: string) => {
        queue = queue.then(() => runTurn(m));
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
          stop?.();
        },
        kill: async () => {
          if (killed) return;
          killed = true;
          stop?.();
          events.push({ type: "session.ended", reason: "killed", error: null });
          events.end();
        },
        usage: () => ({ ...emptyUsage(), outputTokens: 200 }),
      };
    },
  };
  return { adapter, log, mcpResults, asks };
}

/** One MCP call over stdio: initialize, then tools/call, as a Leg's client does. */
function callMcp(
  server: { command: string; args: string[] },
  tool: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(server.command, server.args, { stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      for (const line of buf.split("\n").slice(0, -1)) {
        const m = JSON.parse(line) as {
          id: number;
          result?: { content?: { text?: string }[]; isError?: boolean };
          error?: { message: string };
        };
        if (m.id !== 2) continue;
        child.kill();
        resolve({
          text: m.error?.message ?? (m.result?.content ?? []).map((c) => c.text ?? "").join("\n"),
          isError: Boolean(m.error || m.result?.isError),
        });
      }
      buf = buf.slice(buf.lastIndexOf("\n") + 1);
    });
    const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } });
  });
}

function runShell(
  command: string,
  cwd: string,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", (e) => resolve({ status: null, stdout, stderr: String(e) }));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}
