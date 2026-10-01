import type { Autonomy } from "@oraknid/contracts";

// The permission policy (Approvals-and-Autonomy → Leg permission prompts,
// Security → Command allow/deny list). The sandbox is the second wall;
// this is the first.

export type GatedAction =
  | "send"
  | "push"
  | "merge"
  | "deploy"
  | "delete"
  | "spend"
  | "external-write"
  | "install";

/** Gated at every level unless I waive them for the job (BR-5). */
export const ALWAYS_GATED: ReadonlySet<GatedAction> = new Set([
  "send",
  "push",
  "deploy",
  "delete",
  "spend",
]);

export interface PolicyRequest {
  tool: string;
  command: string | null;
  /** Absolute path the tool touches, if any. */
  path: string | null;
}

export interface PolicyContext {
  worktree: string;
  autonomy: Autonomy;
  /** Gates I waived for this job. */
  waived: ReadonlySet<GatedAction>;
  /** Extra patterns (regex sources) from my settings, most specific last. */
  allow?: string[];
  deny?: string[];
}

export type PolicyVerdict =
  | { verdict: "allow"; reason: string }
  | { verdict: "deny"; reason: string; drift: "D7" }
  | { verdict: "ask"; reason: string; gated: GatedAction | null };

/** Never, at any level (Security → shipped defaults). */
export const DEFAULT_DENY: { pattern: RegExp; why: string }[] = [
  { pattern: /(^|[\s;&|(])sudo(\s|$)/, why: "runs as root" },
  { pattern: /\bsu\s+-?\s*\w*/, why: "switches user" },
  {
    pattern: /\brm\s+(-\w*\s+)*-\w*[rR]\w*\s+(-\w+\s+)*(\/|~|\$HOME)(\s|\/?$)/,
    why: "deletes a whole tree from / or home",
  },
  { pattern: /\bchmod\s+(-R\s+)?777\b/, why: "makes files world-writable" },
  { pattern: /\b(curl|wget)\b[^|]*\|\s*(ba|z)?sh\b/, why: "pipes a download into a shell" },
  { pattern: /(~|\$HOME|\/home\/[^/\s]+)\/\.ssh\b/, why: "touches SSH keys" },
  { pattern: /\bmkfs(\.\w+)?\b|\bdd\s+if=/, why: "writes raw disks" },
  { pattern: /:\(\)\s*\{.*\};\s*:/, why: "is a fork bomb" },
  { pattern: /\b(shutdown|reboot|poweroff|halt)\b/, why: "stops the machine" },
  {
    pattern: /\bgit\s+push\b.*\s(--force|-f)(\s|$)/,
    why: "force-pushes, rewriting published history (BR-14)",
  },
];

/** Actions that wait for my approval (Approvals → Gated actions). */
export const GATED: { action: GatedAction; pattern: RegExp }[] = [
  { action: "push", pattern: /\bgit\s+push\b/ },
  { action: "merge", pattern: /\bgit\s+merge\b/ },
  {
    action: "deploy",
    pattern:
      /\b(deploy|kubectl\s+apply|terraform\s+apply|helm\s+(install|upgrade)|docker\s+push)\b/,
  },
  {
    action: "external-write",
    pattern:
      /\b(npm|pnpm|yarn|cargo|twine)\s+publish\b|\bgh\s+(pr|issue|release)\s+(create|merge|close|comment)\b/,
  },
  { action: "send", pattern: /\b(sendmail|mailx?|msmtp)\b/ },
  {
    action: "install",
    pattern:
      /\b(pacman|apt(-get)?|dnf|yum|zypper|brew|snap|flatpak)\s+(-\S+\s+)*(install|-S)\b|\b(npm|pnpm|yarn)\s+(i|install|add)\s+(-g|--global)\b|\bpip\s+install\s+--user\b/,
  },
  { action: "delete", pattern: /\bgit\s+branch\s+-[dD]\b|\bgit\s+push\s+\S+\s+--delete\b/ },
];

/** Programs a coding task normally runs. Anything else is unknown. */
const ALLOWED_PROGRAMS = new Set(
  `sh bash dash zsh [ git node npm npx pnpm yarn bun deno tsc tsx vitest jest eslint biome prettier python python3 pip pytest uv cargo rustc go make cmake
   ls cat head tail wc grep rg find fd sed awk sort uniq cut tr xargs diff patch echo printf test true false pwd cd mkdir mktemp touch cp mv rm ln
   chmod which env date basename dirname realpath readlink jq sleep tee stat file du df`.split(
    /\s+/,
  ),
);

/** Tools that only read, or only plan: allowed (the sandbox confines them). */
const READ_ONLY_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
  "Task",
  "AskUserQuestion",
  "ExitPlanMode",
  "read_file",
  "list_dir",
  "search",
]);
const FILE_TOOLS = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "write_file",
  "edit_file",
]);
const SHELL_TOOLS = new Set(["Bash", "run_command"]);

/** The programs a command line runs: the first word of every piece between ; && || | ( ). */
export function programsOf(command: string): string[] {
  return (
    command
      .split(/;|&&|\|\||\||\(|\)|`|\$\(/)
      .map((part) =>
        part
          .trim()
          .replace(/^["']+/, "")
          .trim()
          .replace(/^(\w+=\S*\s+)*/, ""),
      )
      .map((part) => part.split(/\s+/)[0] ?? "")
      // What's left of a quoted string or a test (`" = "hi" ]`) is not a program.
      .filter((word) => /^[\w./[][\w./+-]*$/.test(word))
      .map((word) => word.replace(/^.*\//, ""))
  );
}

const insideTree = (worktree: string, path: string) =>
  path === worktree || path.startsWith(worktree.endsWith("/") ? worktree : `${worktree}/`);

export function decide(r: PolicyRequest, ctx: PolicyContext): PolicyVerdict {
  const command = r.command ?? "";
  if (command) {
    for (const src of ctx.deny ?? []) {
      if (new RegExp(src).test(command))
        return { verdict: "deny", reason: `matches my deny rule /${src}/`, drift: "D7" };
    }
    for (const d of DEFAULT_DENY) {
      if (d.pattern.test(command))
        return { verdict: "deny", reason: `never allowed: it ${d.why}`, drift: "D7" };
    }
    for (const g of GATED) {
      if (!g.pattern.test(command)) continue;
      if (ctx.waived.has(g.action))
        return { verdict: "allow", reason: `${g.action} waived for this job` };
      if (ctx.autonomy === "full" && !ALWAYS_GATED.has(g.action)) {
        return { verdict: "allow", reason: `${g.action} allowed at Full autonomy` };
      }
      return { verdict: "ask", reason: `${g.action} needs my approval`, gated: g.action };
    }
  }

  if (READ_ONLY_TOOLS.has(r.tool)) return { verdict: "allow", reason: "reads only" };

  if (FILE_TOOLS.has(r.tool)) {
    if (r.path && insideTree(ctx.worktree, r.path))
      return { verdict: "allow", reason: "edits inside the worktree" };
    return {
      verdict: "ask",
      reason: `writes outside the worktree (${r.path ?? "no path"})`,
      gated: "delete",
    };
  }

  if (SHELL_TOOLS.has(r.tool)) {
    for (const src of ctx.allow ?? []) {
      if (new RegExp(src).test(command))
        return { verdict: "allow", reason: `matches my allow rule /${src}/` };
    }
    const unknown = programsOf(command).filter((p) => !ALLOWED_PROGRAMS.has(p));
    if (unknown.length === 0)
      return { verdict: "allow", reason: "every program is on the allow list" };
    if (ctx.autonomy === "full")
      return { verdict: "allow", reason: "unknown, but in the sandbox at Full autonomy" };
    return {
      verdict: "ask",
      reason: `runs ${unknown.join(", ")}, which is not on the allow list`,
      gated: null,
    };
  }

  // A tool Oraknid doesn't know (e.g. an MCP tool).
  if (ctx.autonomy === "full") return { verdict: "allow", reason: "unknown tool at Full autonomy" };
  return { verdict: "ask", reason: `uses ${r.tool}, which Oraknid does not know`, gated: null };
}
