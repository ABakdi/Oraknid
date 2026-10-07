// The terminal app's slash commands (ADR-055): their names, what they take,
// a line of help each; what I type read as a command, a number or words.

/** Where a command makes sense: anywhere, on the current job, or on the current server. */
export type Scope = "any" | "job" | "server";

export interface CommandSpec {
  name: string;
  /** What follows the name, as the help shows it: "<n>", "[all]". */
  args?: string;
  help: string;
  scope: Scope;
}

export const COMMANDS: CommandSpec[] = [
  { name: "projects", help: "Your projects, numbered: pick one to talk to its Eye", scope: "any" },
  { name: "project", args: "<n|name>", help: "Make a project the current one", scope: "any" },
  {
    name: "jobs",
    args: "[all]",
    help: "The current project's jobs (every project's with all)",
    scope: "any",
  },
  { name: "job", args: "<n>", help: "A job: its plan as a tree, its tasks", scope: "any" },
  {
    name: "logs",
    help: "Logs: the job's sessions, a server's (followed), or Oraknid's own",
    scope: "any",
  },
  { name: "pause", help: "Pause the current job", scope: "job" },
  { name: "resume", help: "Resume the current job", scope: "job" },
  {
    name: "cancel",
    help: "Cancel the current job, or the one this conversation is about (y/N)",
    scope: "job",
  },
  {
    name: "redirect",
    args: "<instruction>",
    help: "Tell the current job what to do instead",
    scope: "job",
  },
  {
    name: "inbox",
    help: "Questions and approvals waiting for you, answered by number",
    scope: "any",
  },
  { name: "answer", help: "Answer The Eye's open questions in this conversation", scope: "any" },
  { name: "stop", help: "Stop what The Eye is thinking (Esc does the same)", scope: "any" },
  { name: "servers", help: "Your servers, numbered: pick one for its overview", scope: "any" },
  { name: "server", args: "<n|name>", help: "Make a server the current one", scope: "any" },
  {
    name: "chat",
    help: "Talk to the current server's Eye (again: back to the project's)",
    scope: "server",
  },
  { name: "docker", help: "The server's containers and images", scope: "server" },
  { name: "db", help: "The server's databases", scope: "server" },
  { name: "proxy", help: "The server's proxies, sites and certificates", scope: "server" },
  { name: "state", help: "The server's state document", scope: "server" },
  { name: "ssh", help: "A shell on the server, through Oraknid's key", scope: "server" },
  {
    name: "backups",
    help: "Backup plans and their last runs (the server's, when one is chosen)",
    scope: "any",
  },
  { name: "agents", help: "Your Legs, their accounts, usage and quota", scope: "any" },
  { name: "models", help: "Local models and the models your Legs offer", scope: "any" },
  { name: "usage", help: "Tokens, money and plan windows", scope: "any" },
  { name: "health", help: "This computer: danger, tasks running, paused for room", scope: "any" },
  { name: "mail", help: "Mail accounts, then their threads", scope: "any" },
  { name: "repos", help: "Your GitHub repositories", scope: "any" },
  { name: "storage", help: "Disk used by Oraknid, and cloud storage", scope: "any" },
  { name: "chats", help: "Your chats with models", scope: "any" },
  { name: "skills", help: "The skills jobs can use", scope: "any" },
  { name: "settings", args: "[name value]", help: "The common settings, by name", scope: "any" },
  { name: "update", help: "Is there a newer Oraknid? Update to it", scope: "any" },
  { name: "doctor", help: "Check this computer and say what is wrong", scope: "any" },
  { name: "help", help: "Every command, a line each", scope: "any" },
  { name: "quit", help: "Leave (Oraknid keeps running)", scope: "any" },
];

const BY_NAME = new Map(COMMANDS.map((c) => [c.name, c]));

/** Short names that also work. */
const ALIASES: Record<string, string> = { exit: "quit", q: "quit", "?": "help", databases: "db" };

export function findCommand(name: string): CommandSpec | undefined {
  const n = name.toLowerCase();
  return BY_NAME.get(ALIASES[n] ?? n);
}

export type Parsed =
  | { kind: "empty" }
  | { kind: "command"; name: string; args: string; spec: CommandSpec | undefined }
  | { kind: "number"; n: number }
  | { kind: "text"; text: string };

/** What a line I typed is: a command, a number (picking from a list), or words for The Eye. */
export function parseInput(line: string): Parsed {
  const text = line.trim();
  if (!text) return { kind: "empty" };
  if (/^\d{1,4}$/.test(text)) return { kind: "number", n: Number(text) };
  // A path or "//" is words, not a command.
  const m = /^\/([a-z?][\w-]*)(?:\s+([\s\S]*))?$/i.exec(text);
  if (m) {
    const name = (m[1] ?? "").toLowerCase();
    const spec = findCommand(name);
    return { kind: "command", name: spec?.name ?? name, args: (m[2] ?? "").trim(), spec };
  }
  return { kind: "text", text };
}

/**
 * The commands that complete what I am typing: while it is "/" and a word
 * with no space yet, those that start with it first, then those that
 * contain it; the current context's first among equals.
 */
export function completions(
  line: string,
  context: { job: boolean; server: boolean },
): CommandSpec[] {
  const m = /^\/([\w-]*)$/.exec(line);
  if (!m) return [];
  const word = (m[1] ?? "").toLowerCase();
  const fits = (c: CommandSpec) =>
    c.scope === "any" ||
    (c.scope === "job" && context.job) ||
    (c.scope === "server" && context.server);
  const starts = COMMANDS.filter((c) => c.name.startsWith(word));
  const contains = word
    ? COMMANDS.filter((c) => !c.name.startsWith(word) && c.name.includes(word))
    : [];
  const order = (xs: CommandSpec[]) => [...xs.filter(fits), ...xs.filter((c) => !fits(c))];
  return [...order(starts), ...order(contains)];
}

/**
 * Typing a number in a list of `count`: picks at once when no longer number
 * could follow (3 in a list of 5), waits for Enter when one could (1 in a
 * list of 12); null when it is no item.
 */
export function numberPick(typed: string, count: number): { pick: number } | { wait: true } | null {
  if (!/^\d{1,4}$/.test(typed)) return null;
  const n = Number(typed);
  if (n < 1 || n > count) return null;
  return n * 10 <= count ? { wait: true } : { pick: n };
}

/** The help, a line per command. */
export function helpLines(): string[] {
  const width = Math.max(...COMMANDS.map((c) => `/${c.name}${c.args ? ` ${c.args}` : ""}`.length));
  return COMMANDS.map((c) => {
    const head = `/${c.name}${c.args ? ` ${c.args}` : ""}`;
    const where = c.scope === "job" ? " (a job)" : c.scope === "server" ? " (a server)" : "";
    return `${head.padEnd(width)}  ${c.help}${where}`;
  });
}
