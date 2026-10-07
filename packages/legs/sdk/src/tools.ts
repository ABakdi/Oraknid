import type { LegKind } from "@oraknid/contracts";
import type { PermissionRequest } from "./types.ts";

// What each agent's tools do, by their names (ADR-056 §2): the harness
// reads an action by its class — a shell command, a read, a write — never
// by an agent's own tool names. Each adapter's names are declared here,
// beside the names the adapters translate their permission asks into
// (Claude Code's, which OpenCode, Codex, Antigravity and Oraknid's own
// agent use for their asks).

/**
 * What a tool call does, as the Gate and the audit read it: a shell command,
 * a read of the project's files (no audit line when allowed), a write;
 * anything else (the web, a sub-agent, a job's tool) is "other".
 */
export type ToolClass = "shell" | "read" | "write" | "other";

/** An agent's tools by what they do, and where their input names a command or a file. */
export interface ToolVocabulary {
  shell: readonly string[];
  read: readonly string[];
  write: readonly string[];
  /** Input fields holding the command line, in order. */
  commandFields: readonly string[];
  /** Input fields holding the file's path, in order. */
  pathFields: readonly string[];
}

/** The names permission asks are translated into: Claude Code's own. */
export const ASK_NAMES: ToolVocabulary = {
  shell: ["Bash"],
  read: ["Read", "Glob", "Grep", "LS", "TodoWrite"],
  write: ["Write", "Edit", "MultiEdit", "NotebookEdit"],
  commandFields: ["command"],
  pathFields: ["file_path", "notebook_path", "path"],
};

/** Each adapter's own tool names, as its events report the calls (one entry per Leg kind). */
export const TOOL_VOCABULARY: Record<LegKind, ToolVocabulary> = {
  "claude-code": ASK_NAMES,
  codex: {
    shell: ["Bash", "shell", "exec_command", "local_shell"],
    read: ["Read"],
    write: ["Write", "Edit", "apply_patch"],
    commandFields: ["command", "cmd"],
    pathFields: ["file_path", "path"],
  },
  opencode: {
    shell: ["bash", "shell", "Bash"],
    read: ["read", "glob", "grep", "list", "todowrite", "todoread"],
    write: ["write", "edit", "patch", "multiedit", "Write", "Edit"],
    commandFields: ["command"],
    pathFields: ["filePath", "file_path", "path"],
  },
  antigravity: {
    shell: ["run_command", "Bash"],
    read: ["view_file", "list_dir", "grep_search", "find_by_name"],
    write: ["write_to_file", "replace_file_content", "multi_replace_file_content", "Write"],
    commandFields: ["CommandLine", "command"],
    pathFields: ["TargetFile", "AbsolutePath", "file_path", "path"],
  },
  "oraknid-agent": {
    shell: ["bash", "Bash"],
    read: ["read", "glob", "grep", "todo_write"],
    write: ["write", "edit", "Write", "Edit"],
    commandFields: ["command"],
    pathFields: ["path", "file_path"],
  },
  "openai-compatible": {
    shell: ["run_command"],
    read: ["read_file", "list_dir", "search"],
    write: ["write_file", "edit_file"],
    commandFields: ["command"],
    pathFields: ["path"],
  },
};

const ALL: ToolVocabulary[] = [ASK_NAMES, ...Object.values(TOOL_VOCABULARY)];

/** What a tool does, by its name in any adapter's vocabulary ("other" when none names it). */
export function toolClass(tool: string, vocabulary?: ToolVocabulary): ToolClass {
  for (const v of vocabulary ? [vocabulary] : ALL) {
    if (v.shell.includes(tool)) return "shell";
    if (v.write.includes(tool)) return "write";
    if (v.read.includes(tool)) return "read";
  }
  return "other";
}

/** The name a shell command is asked under: what a check's or a server's command is read as. */
export const SHELL_TOOL = "Bash";

/**
 * A tool call the agent made, read as the permission ask it would have
 * been (ADR-056 §2): for a Leg whose actions aren't each asked before they
 * run, so the Gate can audit them after the fact.
 */
export function asRequest(
  tool: string,
  input: Record<string, unknown>,
  vocabulary?: ToolVocabulary,
): PermissionRequest {
  const cls = toolClass(tool, vocabulary);
  const fields = (names: readonly string[]) =>
    names.map((n) => input[n]).find((v): v is string => typeof v === "string") ?? null;
  const all = vocabulary ? [vocabulary] : ALL;
  const command =
    cls === "shell" ? (all.map((v) => fields(v.commandFields)).find(Boolean) ?? null) : null;
  const path =
    cls === "shell" ? null : (all.map((v) => fields(v.pathFields)).find(Boolean) ?? null);
  const asked =
    cls === "shell" ? SHELL_TOOL : cls === "write" ? "Write" : cls === "read" ? "Read" : tool;
  return { tool: asked, input, command, path };
}
