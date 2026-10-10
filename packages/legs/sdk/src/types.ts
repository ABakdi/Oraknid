import type { LegKind } from "@oraknid/contracts";
import type { Sandbox } from "@oraknid/os";

// The uniform interface over every backend (docs/02-Architecture/Leg-Adapters.md).

export interface LegConfig {
  id: string;
  name: string;
  kind: LegKind;
  /** Kind-specific settings; never secrets (BR-13). */
  config: Record<string, unknown>;
}

/** One model a Leg offers (ADR-013). */
export interface ModelOffer {
  model: string;
  displayName: string;
  effortLevels: string[];
  contextWindow: number | null;
  /**
   * How the model calls tools, where the probe tested it (ADR-052 §6):
   * natively, through a JSON grammar, or not at all (text work only).
   */
  toolCalls?: "native" | "json" | "none";
}

export interface ProbeResult {
  ok: boolean;
  /** What was found, or exactly what failed (BR-17). */
  detail: string;
  models: ModelOffer[];
  features: {
    resume: boolean;
    /** Edits files and runs commands itself (an agent) or not (a bare model). */
    tools: boolean;
    usage: "reported" | "estimated";
    quotaWindows: boolean;
  } & Partial<Capabilities>;
}

/**
 * What a session of the Leg can do for the harness (ADR-056 §2), from its
 * probe. Each one it lacks has a declared fallback in the harness, never
 * an `else`: no inline gate → its actions are audited after the fact; no
 * pre-tool hook → every prompt is Oraknid's (no auto mode of its own); no
 * stop hook → the checks run after the turn ends; no resume → a fresh
 * session with a handoff; no steer → my messages wait for the turn's end.
 */
export interface Capabilities {
  /** Every action that changes something is asked of Oraknid before it runs. */
  inlineGate: boolean;
  /** Oraknid's hook runs before each tool in the agent's own auto mode (ADR-053). */
  preToolHook: boolean;
  /** The turn's end waits for Oraknid's checks (a Stop hook). */
  stopHook: boolean;
  /** A session can be continued by its native id (ADR-052 §1). */
  resume: boolean;
  /** A message reaches the agent while a turn runs. */
  steer: boolean;
}

/** A Leg never probed, or probed before capabilities were reported, can do none of them. */
export const NO_CAPABILITIES: Capabilities = {
  inlineGate: false,
  preToolHook: false,
  stopHook: false,
  resume: false,
  steer: false,
};

/** The capabilities a probe reported, the missing ones off. */
export function capabilitiesOf(features: Partial<Capabilities> | null | undefined): Capabilities {
  return {
    inlineGate: features?.inlineGate ?? false,
    preToolHook: features?.preToolHook ?? false,
    stopHook: features?.stopHook ?? false,
    resume: features?.resume ?? false,
    steer: features?.steer ?? false,
  };
}

export interface PermissionRequest {
  tool: string;
  input: Record<string, unknown>;
  /** The shell command, when the tool runs one. */
  command: string | null;
  /** The file path, when the tool touches one. */
  path: string | null;
}

/** A permission answer; `why` is its layer and reason, for the session's log (ADR-053). */
export type PermissionDecision =
  | { allow: true; why?: string }
  | { allow: false; message: string; why?: string };

/**
 * Oraknid's word before a tool runs, in a Leg's own auto mode (ADR-053):
 * deny it with a message, ask (through `onPermission`), allow it (what
 * the owner let run once), or no opinion (null), leaving the Leg's own
 * auto mode to decide.
 */
export type PreToolDecision =
  | { decision: "deny"; message: string }
  | { decision: "ask" }
  | { decision: "allow"; reason: string }
  | null;

export interface UsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Tokens in the context right now, when known. */
  contextTokens: number | null;
  contextWindow: number | null;
  /** True when counted by Oraknid rather than reported by the backend. */
  estimated: boolean;
}

export interface QuotaReport {
  /** As the provider names it: "five_hour", "seven_day_opus"… */
  window: string;
  /** Account-wide or for one model (ADR-013). */
  scope: "account" | "model";
  status: "allowed" | "warning" | "rejected";
  utilization: number | null;
  resetsAt: number | null;
}

export type TurnEnd = "completed" | "interrupted" | "error" | "max_turns" | "rate-limited";
export type SessionEnd = "completed" | "killed" | "crashed" | "rate-limited";

export type LegEvent =
  | { type: "turn.started" }
  | { type: "text.delta"; text: string }
  /** The model's reasoning as it streams, where the Leg shows it (M13.25); never part of the answer. */
  | { type: "thinking.delta"; text: string }
  | { type: "tool.called"; id: string; tool: string; input: Record<string, unknown> }
  | { type: "tool.result"; id: string; ok: boolean; output: string }
  | { type: "question"; text: string }
  | { type: "permission.requested"; request: PermissionRequest; decision: PermissionDecision }
  /** A tool call refused before it ran by the Leg's own auto mode, or by Oraknid's hook in it (ADR-053). */
  | { type: "permission.denied"; request: PermissionRequest; by: "leg" | "oraknid"; reason: string }
  | { type: "usage"; usage: UsageSnapshot }
  | { type: "rate_limit"; quota: QuotaReport }
  | { type: "turn.ended"; reason: TurnEnd; text: string; error: string | null }
  | { type: "session.ended"; reason: SessionEnd; error: string | null };

export interface SandboxPlan {
  sandbox: Sandbox;
  /**
   * HOME for the session: the Leg's own, or for a job's session the job's
   * home on that Leg, where the Leg's login is linked (Audit 2, S2-08).
   */
  home: string;
  /**
   * The agent's config folder of the job's own, in place of the Leg's (S2-08):
   * Claude Code's CLAUDE_CONFIG_DIR, Codex's CODEX_HOME (ADR-057).
   */
  configDir?: string;
  writable: string[];
  readonly: string[];
  env: Record<string, string>;
}

export interface SessionStart {
  leg: LegConfig;
  model: string;
  effort: string | null;
  /** The worktree. */
  cwd: string;
  /** The context pack (Silk): the session's standing instructions. */
  systemPrompt: string;
  /** The first message. */
  prompt: string;
  /** A native session to continue (only when the adapter supports resume). */
  resumeFrom: string | null;
  /** null runs unsandboxed: only when I chose that for the job, or in tests. */
  sandbox: SandboxPlan | null;
  /** The Leg's secret (e.g. an API key), resolved from the store at start (BR-13). */
  credential: string | null;
  onPermission: (request: PermissionRequest) => Promise<PermissionDecision>;
  /**
   * The Leg's own auto mode, where it has one (ADR-053): Claude Code runs
   * with `--permission-mode auto`, and `onPreToolUse` is called before
   * every tool so Oraknid's block rules and scope still hold. "ask" (the
   * default) sends every permission prompt to `onPermission`.
   */
  permissionMode?: "ask" | "auto";
  /** Oraknid's layer 1 before every tool, in the Leg's own auto mode. */
  onPreToolUse?: (request: PermissionRequest) => Promise<PreToolDecision>;
  /**
   * The task's checks in the loop (ADR-052 §2): asked when the agent is about
   * to end its turn. A reason keeps it working (the checks' failure, said to
   * it); null lets it stop. Adapters that can hold a turn open (Claude Code's
   * Stop hook) call it; the others ignore it, and their prompt asks the agent
   * to run the checks itself.
   */
  onStop?: (lastMessage: string) => Promise<string | null>;
  /**
   * MCP servers this session gets, by name (ADR-021): each is Oraknid's
   * bridge to a tool the daemon runs. Their calls are judged by the
   * broker, so the Leg-level permission for them is allowed.
   */
  mcpServers?: Record<string, McpServer>;
  /**
   * Check commands the session runs itself before it ends a turn as done
   * (ADR-052 §2), where the adapter can: Oraknid's own agent runs them in
   * the sandbox and keeps working while they fail.
   */
  checks?: string[];
}

/** A stdio MCP server a Leg starts: here always Oraknid's bridge. */
export interface McpServer {
  command: string;
  args: string[];
}

export interface LegSession {
  /** The backend's own session id, once known (for resume). */
  nativeSessionId(): string | null;
  /** The process to measure and to kill on recovery, when there is one. */
  pid(): number | null;
  /** A follow-up turn. */
  send(message: string): Promise<void>;
  /** Every event of the session, in order; ends when the session ends. */
  events(): AsyncIterable<LegEvent>;
  /** Ends the current turn at a safe point (BR-7). */
  interrupt(): Promise<void>;
  /** Terminates the process tree or aborts the stream (ladder step 4). */
  kill(): Promise<void>;
  usage(): UsageSnapshot;
}

/** One window of a plan's usage, as the backend's own tooling reads it (ADR-039). */
export interface PlanWindowReport {
  /** As the provider names it: "five_hour", "seven_day_opus"… */
  window: string;
  scope: "account" | "model";
  /** The provider's own name for a model's window ("Fable"), when it gives one. */
  label: string | null;
  /** Share used, 0–1. */
  utilization: number | null;
  resetsAt: number | null;
}

/** A plan's usage windows, read without sending a prompt (ADR-039). */
export interface PlanUsageReport {
  /** False when no plan limits apply (an API key, a provider's cloud): no windows. */
  available: boolean;
  windows: PlanWindowReport[];
}

export interface LegAdapter {
  kind: LegKind;
  probe(leg: LegConfig, sandbox: SandboxPlan | null): Promise<ProbeResult>;
  start(start: SessionStart): Promise<LegSession>;
  /**
   * The plan's usage windows, read through the backend's own tooling,
   * inside the sandbox, costing no tokens (ADR-039). null when the
   * tooling can't say; an adapter without it has no such reading.
   */
  planUsage?(leg: LegConfig, sandbox: SandboxPlan | null): Promise<PlanUsageReport | null>;
}

export const emptyUsage = (estimated = false): UsageSnapshot => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  contextTokens: null,
  contextWindow: null,
  estimated,
});

/**
 * An OpenAI-compatible server's base address from what was pasted: an
 * endpoint (`…/v1/responses`, `…/v1/chat/completions`, `…/v1/models`)
 * becomes its base (`…/v1`), trailing slashes gone (2026-10-10: xAI's
 * `https://api.x.ai/v1/responses` given as the address).
 */
export function apiBase(url: string): string {
  return url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/(?:chat\/completions|completions|responses|models|embeddings)$/i, "")
    .replace(/\/+$/, "");
}
