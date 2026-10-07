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

export type PermissionDecision = { allow: true } | { allow: false; message: string };

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
  /** A Claude config folder of the job's own, in place of the Leg's (S2-08). */
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
