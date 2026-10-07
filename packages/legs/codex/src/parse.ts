import type {
  ModelOffer,
  PermissionRequest,
  PlanUsageReport,
  PlanWindowReport,
} from "@oraknid/leg-sdk";

// What Codex says, read into Oraknid's terms (ADR-057). Pure functions,
// each tested against the shapes of codex-cli 0.161.0: its `exec --json`
// events (codex-rs/exec, exec_events.rs), its hooks' input, its model
// catalog (`codex debug models`) and its app server's rate limits.

/** A string as a TOML basic string (a `-c key=value` value is read as TOML). */
export const tomlString = (s: string) => JSON.stringify(s);

/** A word for the shell, quoted only when it has to be. */
export const shellWord = (s: string) =>
  /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`;

/** One `exec --json` item, as codex-cli 0.161.0 reports it. */
export interface CodexItem {
  id: string;
  type: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: string;
  changes?: { path: string; kind: string }[];
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: { content?: { type?: string; text?: string }[] } | null;
  error?: { message?: string } | null;
  query?: string;
  prompt?: string | null;
  message?: string;
}

/** One line of `codex exec --json`. */
export interface CodexEvent {
  type: string;
  thread_id?: string;
  item?: CodexItem;
  usage?: CodexUsage;
  error?: { message?: string };
  message?: string;
}

/** The thread's running totals, as `turn.completed` carries them. */
export interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

/** A tool item as the tool Oraknid shows, with its input; null for what isn't a tool. */
export function toolOf(item: CodexItem): { tool: string; input: Record<string, unknown> } | null {
  switch (item.type) {
    case "command_execution":
      return { tool: "Bash", input: { command: item.command ?? "" } };
    case "file_change":
      return { tool: "Edit", input: { changes: item.changes ?? [] } };
    case "mcp_tool_call":
      return {
        tool: `mcp__${item.server ?? "?"}__${item.tool ?? "?"}`,
        input: (item.arguments && typeof item.arguments === "object"
          ? item.arguments
          : {}) as Record<string, unknown>,
      };
    case "web_search":
      return { tool: "WebSearch", input: { query: item.query ?? "" } };
    case "collab_tool_call":
      return { tool: "Task", input: { tool: item.tool ?? "", prompt: item.prompt ?? "" } };
    default:
      return null;
  }
}

/** A finished tool item's result: whether it worked, and what it said. */
export function resultOf(item: CodexItem): { ok: boolean; output: string } {
  const ok = item.status === "completed";
  switch (item.type) {
    case "command_execution": {
      const out = item.aggregated_output ?? "";
      if (item.status === "declined") return { ok: false, output: out || "Codex declined it." };
      return {
        ok,
        output:
          ok || item.exit_code === null || item.exit_code === undefined
            ? out
            : `${out}${out.endsWith("\n") || !out ? "" : "\n"}(exit ${item.exit_code})`,
      };
    }
    case "file_change":
      return {
        ok,
        output: (item.changes ?? []).map((c) => `${c.kind} ${c.path}`).join("\n"),
      };
    case "mcp_tool_call":
      return {
        ok: ok && !item.error,
        output:
          item.error?.message ??
          (item.result?.content ?? [])
            .map((c) => (typeof c.text === "string" ? c.text : JSON.stringify(c)))
            .join("\n"),
      };
    case "web_search":
      return { ok: true, output: item.query ?? "" };
    default:
      return { ok: ok || item.status === undefined, output: "" };
  }
}

/** A shell command as one line: a string, or `bash -lc "…"` given as words. */
export function commandText(command: unknown): string | null {
  if (typeof command === "string") return command;
  if (!Array.isArray(command) || !command.every((w) => typeof w === "string")) return null;
  const words = command as string[];
  const c = words.findIndex((w) => w === "-c" || w === "-lc");
  if (c >= 0 && c === words.length - 2 && /(^|\/)(ba|z|da)?sh$/.test(words[0] ?? ""))
    return words[c + 1] as string;
  return words.map(shellWord).join(" ");
}

/** The files a patch (Codex's apply_patch format) adds, changes, moves or deletes. */
export function patchFiles(patch: string): { path: string; kind: "add" | "update" | "delete" }[] {
  const out: { path: string; kind: "add" | "update" | "delete" }[] = [];
  for (const m of patch.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm))
    out.push({ path: (m[2] as string).trim(), kind: (m[1] as string).toLowerCase() as "add" });
  for (const m of patch.matchAll(/^\*\*\* Move to: (.+)$/gm))
    out.push({ path: (m[1] as string).trim(), kind: "add" });
  return out;
}

const SHELL_TOOLS = new Set(["Bash", "shell", "exec_command", "local_shell", "unified_exec"]);
const PATCH_TOOLS = new Set(["apply_patch", "Edit", "Write"]);

/**
 * What a PreToolUse hook's call asks of Oraknid's policy (ADR-057): a
 * command, each file a patch touches, an MCP tool; nothing for Codex's own
 * bookkeeping tools (its plan, viewing an image), which change nothing.
 */
export function requestsOf(toolName: string, toolInput: unknown): PermissionRequest[] {
  const input = (toolInput && typeof toolInput === "object" ? toolInput : {}) as Record<
    string,
    unknown
  >;
  if (SHELL_TOOLS.has(toolName)) {
    const command = commandText(input.command ?? input.cmd) ?? JSON.stringify(input);
    return [{ tool: "Bash", input: { command }, command, path: null }];
  }
  if (PATCH_TOOLS.has(toolName)) {
    const patch = [input.command, input.patch, input.input].find((v) => typeof v === "string") as
      | string
      | undefined;
    const direct = [input.file_path, input.path].find((v) => typeof v === "string") as
      | string
      | undefined;
    const files = patch ? patchFiles(patch) : [];
    if (!files.length && direct) files.push({ path: direct, kind: "update" });
    if (!files.length)
      return [{ tool: "Edit", input: { patch: patch ?? "" }, command: null, path: null }];
    return files.map((f) => ({
      tool: f.kind === "add" ? "Write" : "Edit",
      input: { file_path: f.path, ...(f.kind === "delete" ? { delete: true } : {}) },
      command: null,
      path: f.path,
    }));
  }
  if (toolName.startsWith("mcp__")) return [{ tool: toolName, input, command: null, path: null }];
  return [];
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "3:45 PM" (today, or tomorrow once past) or "Oct 9th, 2026 3:45 PM", in local time. */
function clockTime(text: string, now: Date): number | null {
  const hm = (h: string, m: string, ampm: string) => {
    const hour = (Number(h) % 12) + (/p/i.test(ampm) ? 12 : 0);
    return [hour, Number(m)] as const;
  };
  const day = /^(\d{1,2}):(\d{2})\s*([AP]M)$/i.exec(text);
  if (day) {
    const [h, m] = hm(day[1] as string, day[2] as string, day[3] as string);
    const at = new Date(now);
    at.setHours(h, m, 0, 0);
    if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
    return at.getTime();
  }
  const full =
    /^([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4}),?\s+(\d{1,2}):(\d{2})\s*([AP]M)$/i.exec(
      text,
    );
  if (full) {
    const month = MONTHS.indexOf((full[1] as string).toLowerCase());
    if (month < 0) return null;
    const [h, m] = hm(full[4] as string, full[5] as string, full[6] as string);
    return new Date(Number(full[3]), month, Number(full[2]), h, m).getTime();
  }
  return null;
}

/** "2 days 3 hours 5 minutes", "51h49m", "30s" in milliseconds; 0 when none. */
function duration(text: string): number {
  let ms = 0;
  for (const m of text.matchAll(
    /(\d+)\s*(days?|hours?|minutes?|mins?|seconds?|secs?|d|h|m|s)(?![a-z])/gi,
  )) {
    const unit = (m[2] as string).toLowerCase();
    const n = Number(m[1]);
    ms +=
      n *
      (unit.startsWith("d")
        ? 86_400_000
        : unit.startsWith("h")
          ? 3_600_000
          : unit.startsWith("m")
            ? 60_000
            : 1000);
  }
  return ms;
}

/**
 * A usage limit in Codex's error (ADR-057), and when it lifts: "You've hit
 * your usage limit. … Try again at 3:45 PM." (its `retry_suffix`, local
 * time, a date when not today), "Quota exceeded. Check your plan and
 * billing details." (an API key out of credit), a 429. null for any other
 * error; resetsAt null when it doesn't say.
 */
export function usageLimit(message: string, now = new Date()): { resetsAt: number | null } | null {
  if (
    !/usage limit|rate.?limit|quota exceeded|too many requests|\b429\b|credits (are )?depleted/i.test(
      message,
    )
  )
    return null;
  const at = /try again at\s+(.+?)\s*(?:\.(?:\s|$)|$)/i.exec(message)?.[1];
  if (at) {
    const t = clockTime(at.trim(), now);
    if (t) return { resetsAt: t };
  }
  const inText = /(?:try again|resets?)\s+in\s+([^.]+)/i.exec(message)?.[1];
  const ms = inText ? duration(inText) : 0;
  return { resetsAt: ms ? now.getTime() + ms : null };
}

/** One model of `codex debug models` (codex-cli 0.161.0). */
interface CatalogModel {
  slug?: string;
  display_name?: string;
  visibility?: string;
  supported_in_api?: boolean;
  supported_reasoning_levels?: { effort?: string }[];
  context_window?: number;
  max_context_window?: number;
}

/**
 * The models Codex offers, from its catalog: the listed ones (not those it
 * hides), and with an API key only those the API serves.
 */
export function modelsFromCatalog(json: string, apiKey: boolean): ModelOffer[] {
  let parsed: { models?: CatalogModel[] };
  try {
    parsed = JSON.parse(json) as { models?: CatalogModel[] };
  } catch {
    return [];
  }
  return (parsed.models ?? [])
    .filter((m) => m.slug && (m.visibility ?? "list") === "list")
    .filter((m) => !apiKey || m.supported_in_api !== false)
    .map((m) => ({
      model: m.slug as string,
      displayName: m.display_name || (m.slug as string),
      effortLevels: (m.supported_reasoning_levels ?? [])
        .map((l) => l.effort)
        .filter((e): e is string => typeof e === "string"),
      contextWindow: m.context_window ?? m.max_context_window ?? null,
      toolCalls: "native" as const,
    }));
}

interface RateWindow {
  usedPercent?: number;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
}

/** A window's name by its length: Codex's five hours and week, as Claude's are named. */
export function windowName(mins: number | null | undefined): string {
  if (mins === 300) return "five_hour";
  if (mins === 10_080) return "seven_day";
  if (!mins) return "plan";
  return mins % 1440 === 0 ? `${mins / 1440}_day` : `${mins}_minutes`;
}

/**
 * The plan's windows from the app server's `account/rateLimits/read`
 * answer (ADR-057): its primary and secondary windows, percentages to
 * shares, reset times from seconds to milliseconds.
 */
export function planFromRateLimits(answer: unknown): PlanUsageReport {
  const limits = (answer as { rateLimits?: { primary?: RateWindow; secondary?: RateWindow } })
    ?.rateLimits;
  if (!limits) return { available: false, windows: [] };
  const windows: PlanWindowReport[] = [];
  for (const w of [limits.primary, limits.secondary]) {
    if (!w || typeof w.usedPercent !== "number") continue;
    const name = windowName(w.windowDurationMins);
    if (windows.some((x) => x.window === name)) continue;
    windows.push({
      window: name,
      scope: "account",
      label: null,
      utilization: Math.min(1, Math.max(0, w.usedPercent / 100)),
      resetsAt: typeof w.resetsAt === "number" ? w.resetsAt * 1000 : null,
    });
  }
  return { available: windows.length > 0, windows };
}
