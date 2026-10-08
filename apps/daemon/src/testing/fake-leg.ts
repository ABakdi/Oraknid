import { type ChildProcess, spawn } from "node:child_process";
import {
  Channel,
  emptyUsage,
  type LegAdapter,
  type LegEvent,
  type ModelOffer,
  type QuotaReport,
  type SessionStart,
} from "@oraknid/leg-sdk";

/** A Leg whose probe and sessions tests control. Sessions run a real `sleep` so they have a pid. */
export function fakeLeg(o: { ok?: boolean; detail?: string; models?: ModelOffer[] } = {}) {
  const children: ChildProcess[] = [];
  const started: SessionStart[] = [];
  const state = {
    ok: o.ok ?? true,
    detail: o.detail ?? "fake ok",
    models: o.models ?? [
      { model: "opus", displayName: "Opus", effortLevels: ["low", "high"], contextWindow: null },
      { model: "haiku", displayName: "Haiku", effortLevels: [], contextWindow: null },
    ],
    /** What the next session's first turn does. */
    quota: null as QuotaReport | null,
    usage: { ...emptyUsage(), inputTokens: 200, outputTokens: 50, contextTokens: 250 },
  };
  const adapter: LegAdapter = {
    kind: "claude-code",
    async probe() {
      return {
        ok: state.ok,
        detail: state.detail,
        models: state.ok ? state.models : [],
        features: {
          resume: true,
          tools: true,
          usage: "reported",
          quotaWindows: true,
          inlineGate: true,
          preToolHook: false,
          stopHook: false,
          steer: false,
        },
      };
    },
    async start(s) {
      started.push(s);
      const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
      children.push(child);
      const events = new Channel<LegEvent>();
      events.push({ type: "turn.started" });
      events.push({ type: "text.delta", text: "work" });
      events.push({ type: "text.delta", text: "ing" });
      if (state.quota) events.push({ type: "rate_limit", quota: state.quota });
      events.push({ type: "usage", usage: state.usage });
      events.push({ type: "turn.ended", reason: "completed", text: "working", error: null });
      return {
        nativeSessionId: () => "native-1",
        pid: () => child.pid ?? null,
        send: async () => {},
        events: () => events,
        interrupt: async () => {},
        kill: async () => {
          child.kill("SIGKILL");
          events.push({ type: "session.ended", reason: "killed", error: null });
          events.end();
        },
        usage: () => state.usage,
      };
    },
  };
  return {
    adapter,
    state,
    started,
    cleanup: () => {
      for (const c of children) c.kill("SIGKILL");
    },
  };
}
