import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
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

// OpenCode v2 through a private `opencode serve --stdio` per session,
// inside the sandbox, over its HTTP API and SSE events (ADR-015).

/** The version this adapter was written and tested against; another one is said in the probe. */
export const TESTED_VERSION = "2.0.20";

/** The Leg's config (Leg-Adapters → OpenCode). Never a secret: the key is the Leg's credential. */
export interface OpenCodeConfig {
  /** The unmodified OpenCode binary. */
  binary: string;
  /** The provider's id inside OpenCode. */
  providerID: string;
  /** The AI SDK package of the provider; OpenAI-compatible by default. */
  package: string;
  /** The provider's endpoint, when it isn't the package's default. */
  baseURL: string | null;
  /** The models this Leg offers, by their id at the provider. */
  models: string[];
  /** Context window of the models, when known. */
  contextWindow: number | null;
  /** Where OpenCode keeps its state when there is no sandbox plan (tests, unsandboxed jobs). */
  home: string | null;
}

export const readConfig = (leg: LegConfig): OpenCodeConfig => ({
  binary: String(leg.config.binary ?? "opencode"),
  providerID: String(leg.config.providerID ?? "provider"),
  package: String(leg.config.package ?? "@opencode/ai/providers/openai-compatible"),
  baseURL: typeof leg.config.baseURL === "string" ? leg.config.baseURL : null,
  models: Array.isArray(leg.config.models) ? leg.config.models.map(String) : [],
  contextWindow: typeof leg.config.contextWindow === "number" ? leg.config.contextWindow : null,
  home: typeof leg.config.home === "string" ? leg.config.home : null,
});

/** Every action asks, so Oraknid's policy decides; reading the worktree doesn't (ADR-015). */
const ASK_EVERYTHING = [
  { action: "*", resource: "*", effect: "ask" },
  { action: "read", resource: "*", effect: "allow" },
  { action: "glob", resource: "*", effect: "allow" },
  { action: "grep", resource: "*", effect: "allow" },
];

/** OpenCode's actions, in the names Oraknid's policy knows. */
const TOOL_NAMES: Record<string, string> = {
  shell: "Bash",
  edit: "Edit",
  write: "Write",
  webfetch: "WebFetch",
  websearch: "WebSearch",
  read: "Read",
  glob: "Glob",
  grep: "Grep",
  external_directory: "Write",
};

/** The config OpenCode gets, whole, from the environment: no file of mine or the repo's counts. */
export function configContent(cfg: OpenCodeConfig): string {
  return JSON.stringify({
    model: cfg.models[0] ? `${cfg.providerID}/${cfg.models[0]}` : undefined,
    update: "disable",
    providers: {
      [cfg.providerID]: {
        env: ["ORAKNID_PROVIDER_KEY"],
        package: cfg.package,
        ...(cfg.baseURL ? { settings: { baseURL: cfg.baseURL } } : {}),
        models: Object.fromEntries(
          cfg.models.map((m) => [
            m,
            cfg.contextWindow ? { limit: { context: cfg.contextWindow, output: 8192 } } : {},
          ]),
        ),
      },
    },
    // Only this Leg's provider: the free built-in one, and any other, are off.
    experimental: {
      policies: [
        { action: "provider.use", resource: "*", effect: "deny" },
        { action: "provider.use", resource: cfg.providerID, effect: "allow" },
      ],
    },
  });
}

interface Server {
  url: string;
  auth: string;
  process: ChildProcess;
}

/** Starts a private server for one session, inside the sandbox when there is a plan. */
async function startServer(
  cfg: OpenCodeConfig,
  leg: LegConfig,
  plan: SandboxPlan | null,
  cwd: string,
  key: string | null,
): Promise<Server> {
  const home = plan?.home ?? cfg.home ?? join(tmpdir(), `oraknid-opencode-${leg.id}`);
  // Its own world: home, temp and every XDG dir (ADR-015: XDG alone still reads ~/.claude).
  const dirs = {
    HOME: home,
    TMPDIR: join(home, "tmp"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local", "state"),
  };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true, mode: 0o700 });
  const password = randomBytes(24).toString("base64url");
  const env: Record<string, string> = {
    PATH: plan?.env.PATH ?? process.env.PATH ?? "/usr/bin",
    LANG: plan?.env.LANG ?? process.env.LANG ?? "C.UTF-8",
    ...dirs,
    OPENCODE_PASSWORD: password,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_CONFIG_CONTENT: configContent(cfg),
    ...(key ? { ORAKNID_PROVIDER_KEY: key } : {}),
  };
  const args = ["serve", "--stdio", "--port", "0"];
  const wrapped = plan
    ? plan.sandbox.wrap({
        command: cfg.binary,
        args,
        cwd,
        writable: [...new Set([cwd, home, ...plan.writable])],
        readonly: plan.readonly,
        home,
        env,
      })
    : { command: cfg.binary, args };
  const child = spawn(wrapped.command, wrapped.args, {
    cwd,
    // Inside bwrap the environment is set again by the sandbox; outside it, this is all OpenCode sees.
    env,
    // stdin stays open: OpenCode exits when it closes.
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr?.resume();
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("OpenCode did not start within 30 s."));
    }, 30_000);
    child.once("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`OpenCode could not start: ${e.message}`));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`OpenCode exited at start (code ${code}).`));
    });
    const lines = createInterface({ input: child.stdout as NodeJS.ReadableStream });
    lines.on("line", (line) => {
      try {
        const u = (JSON.parse(line) as { url?: string }).url;
        if (u) {
          clearTimeout(timer);
          resolve(u);
        }
      } catch {}
    });
  });
  child.removeAllListeners("exit");
  return {
    url,
    auth: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
    process: child,
  };
}

async function call<T>(s: Server, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${s.url}${path}`, {
    method,
    headers: {
      authorization: s.auth,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`OpenCode ${method} ${path}: ${res.status} ${await res.text()}`);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

interface OcEvent {
  type: string;
  data: Record<string, unknown> & { sessionID?: string };
}

/** The server's one event stream, as parsed events. */
async function* stream(s: Server, signal: AbortSignal): AsyncGenerator<OcEvent> {
  const res = await fetch(`${s.url}/api/event`, {
    headers: { authorization: s.auth, accept: "text/event-stream" },
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`OpenCode events: ${res.status}`);
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let i = buf.indexOf("\n\n");
    while (i >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = frame
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (data) {
        try {
          yield JSON.parse(data) as OcEvent;
        } catch {}
      }
      i = buf.indexOf("\n\n");
    }
  }
}

function stop(child: ChildProcess) {
  try {
    child.stdin?.end();
  } catch {}
  setTimeout(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  }, 2000).unref();
}

export function createOpenCodeAdapter(): LegAdapter {
  return {
    kind: "opencode",

    async probe(leg, plan): Promise<ProbeResult> {
      const cfg = readConfig(leg);
      const features = {
        resume: true,
        tools: true,
        usage: "reported" as const,
        quotaWindows: false,
      };
      const models = cfg.models.map((m) => ({
        model: m,
        displayName: m,
        effortLevels: [],
        contextWindow: cfg.contextWindow,
      }));
      if (!cfg.models.length)
        return { ok: false, detail: "Name at least one model of the provider.", models, features };
      let server: Server | null = null;
      try {
        server = await startServer(cfg, leg, plan, plan?.home ?? cfg.home ?? tmpdir(), null);
        const info = await call<{ version?: string }>(server, "GET", "/api/info");
        const version = String(info.version ?? "?").replace(/^v/, "");
        return {
          ok: true,
          detail: `OpenCode ${version}${version === TESTED_VERSION ? "" : ` (tested with ${TESTED_VERSION}; its API may differ)`}, provider ${cfg.providerID}.`,
          models,
          features,
        };
      } catch (error) {
        return { ok: false, detail: (error as Error).message, models, features };
      } finally {
        if (server) stop(server.process);
      }
    },

    async start(s: SessionStart): Promise<LegSession> {
      const cfg = readConfig(s.leg);
      const server = await startServer(cfg, s.leg, s.sandbox, s.cwd, s.credential);
      const events = new Channel<LegEvent>();
      const abort = new AbortController();
      let usage: UsageSnapshot = { ...emptyUsage(), contextWindow: cfg.contextWindow };
      let turnText = "";
      let rateLimited = false;
      let ended = false;
      let killed = false;
      const toolNames = new Map<string, string>();

      const finishSession = (reason: "completed" | "killed" | "crashed", error: string | null) => {
        if (ended) return;
        ended = true;
        events.push({ type: "session.ended", reason, error });
        events.end();
        abort.abort();
        stop(server.process);
      };
      server.process.once("exit", (code) =>
        finishSession(
          killed ? "killed" : "crashed",
          killed ? null : `OpenCode exited (code ${code}).`,
        ),
      );

      let sessionId = s.resumeFrom;
      try {
        if (!sessionId) {
          const created = await call<{ data: { id: string } }>(server, "POST", "/api/session", {
            location: { directory: s.cwd },
            model: { providerID: cfg.providerID, id: s.model },
            permissions: ASK_EVERYTHING,
          });
          sessionId = created.data.id;
        } else {
          await call(server, "POST", `/api/session/${sessionId}/model`, {
            model: { providerID: cfg.providerID, id: s.model },
          });
        }
      } catch (error) {
        stop(server.process);
        throw error;
      }
      const id = sessionId as string;

      const answer = async (perm: Record<string, unknown>) => {
        const action = String(perm.action ?? "");
        const resources = Array.isArray(perm.resources) ? perm.resources.map(String) : [];
        const tool = TOOL_NAMES[action] ?? action;
        const request: PermissionRequest = {
          tool,
          input: { action, resources, metadata: perm.metadata ?? null },
          command: action === "shell" ? (resources[0] ?? null) : null,
          path: action === "shell" ? null : (resources[0] ?? null),
        };
        const decision = await s.onPermission(request);
        events.push({ type: "permission.requested", request, decision });
        await call(server, "POST", `/api/session/${id}/permission/${String(perm.id)}/reply`, {
          decision: decision.allow ? "once" : "reject",
          ...(decision.allow ? {} : { message: decision.message }),
        }).catch(() => {});
      };

      const endTurn = (reason: TurnEnd, error: string | null) => {
        events.push({
          type: "turn.ended",
          reason: rateLimited ? "rate-limited" : reason,
          text: turnText,
          error,
        });
        turnText = "";
        rateLimited = false;
      };

      const translate = (e: OcEvent) => {
        const d = e.data ?? {};
        if (d.sessionID && d.sessionID !== id) return;
        switch (e.type) {
          case "session.text.delta": {
            const delta = String(d.delta ?? "");
            if (!delta) return;
            turnText += delta;
            events.push({ type: "text.delta", text: delta });
            return;
          }
          case "session.tool.input.started":
            toolNames.set(String(d.id), String(d.name ?? ""));
            return;
          case "session.tool.called": {
            const name = toolNames.get(String(d.id)) ?? "tool";
            events.push({
              type: "tool.called",
              id: String(d.id),
              tool: TOOL_NAMES[name] ?? name,
              input: (d.input ?? {}) as Record<string, unknown>,
            });
            return;
          }
          case "session.tool.success": {
            const content = Array.isArray(d.content) ? d.content : [];
            events.push({
              type: "tool.result",
              id: String(d.id),
              ok: true,
              output: content
                .map((c) => (typeof c === "object" && c && "text" in c ? String(c.text) : ""))
                .join("\n"),
            });
            return;
          }
          case "session.tool.failed": {
            const err = (d.error ?? {}) as { message?: string; type?: string };
            events.push({
              type: "tool.result",
              id: String(d.id),
              ok: false,
              output: err.message ?? err.type ?? "failed",
            });
            return;
          }
          case "permission.asked":
            void answer(d).catch(() => {});
            return;
          case "session.step.ended": {
            const t = (d.tokens ?? {}) as {
              input?: number;
              output?: number;
              reasoning?: number;
              cache?: { read?: number; write?: number };
            };
            usage = {
              ...usage,
              inputTokens: usage.inputTokens + (t.input ?? 0),
              outputTokens: usage.outputTokens + (t.output ?? 0) + (t.reasoning ?? 0),
              cacheReadTokens: usage.cacheReadTokens + (t.cache?.read ?? 0),
              cacheWriteTokens: usage.cacheWriteTokens + (t.cache?.write ?? 0),
              contextTokens: (t.input ?? 0) + (t.cache?.read ?? 0) + (t.output ?? 0),
            };
            events.push({ type: "usage", usage });
            return;
          }
          case "session.retry.scheduled": {
            const err = (d.error ?? {}) as { type?: string; message?: string };
            if (err.type !== "provider.rate-limit" || rateLimited) return;
            // A usage limit: said once, and the turn ends instead of waiting out ten retries.
            rateLimited = true;
            events.push({
              type: "rate_limit",
              quota: {
                window: "provider",
                scope: "account",
                status: "rejected",
                utilization: null,
                resetsAt: typeof d.at === "number" ? d.at : null,
              },
            });
            void call(server, "POST", `/api/session/${id}/interrupt`).catch(() => {});
            return;
          }
          case "session.execution.succeeded":
            endTurn("completed", null);
            return;
          case "session.execution.interrupted":
            endTurn("interrupted", null);
            return;
          case "session.execution.failed": {
            const err = (d.error ?? {}) as { type?: string; message?: string };
            if (err.type === "provider.rate-limit") rateLimited = true;
            endTurn("error", err.message ?? err.type ?? "OpenCode failed");
            return;
          }
        }
      };

      // The stream is opened before the first prompt, so nothing of the turn is missed.
      const reading = (async () => {
        try {
          for await (const e of stream(server, abort.signal)) translate(e);
        } catch {}
      })();
      void reading;
      await new Promise((r) => setTimeout(r, 50));

      const prompt = async (text: string) => {
        events.push({ type: "turn.started" });
        await call(server, "POST", `/api/session/${id}/prompt`, { text });
      };
      await prompt(s.resumeFrom ? s.prompt : `${s.systemPrompt}\n\n---\n\n${s.prompt}`);

      return {
        nativeSessionId: () => id,
        pid: () => server.process.pid ?? null,
        send: (text) => prompt(text),
        events: () => events,
        interrupt: async () => {
          await call(server, "POST", `/api/session/${id}/interrupt`).catch(() => {});
        },
        kill: async () => {
          killed = true;
          finishSession("killed", null);
        },
        usage: () => usage,
      };
    },
  };
}
