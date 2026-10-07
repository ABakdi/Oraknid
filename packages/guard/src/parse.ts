import { createRequire } from "node:module";
import { Language, type Node, Parser } from "web-tree-sitter";

// A command line read as bash reads it (ADR-053, layer 1), with
// tree-sitter-bash: pipelines, `&&` and `;` lists, subshells, loops,
// redirections, command and process substitution, `sh -c '…'`, and the
// command an `ssh host '…'` runs on the far side, each parsed again. It
// never runs anything.

/** A redirection: `> file`, `>> file`, `2>&1`, `< in`. */
export interface Redirect {
  op: string;
  /** The file or descriptor it names, quotes taken off. */
  target: string;
  /** False when the target is built at run time (`> "$out"`). */
  literal: boolean;
}

/** One simple command, wherever it sits in the line. */
export interface Part {
  /** The program that really runs, wrappers (`sudo`, `env`, `timeout`…) taken off; its basename. */
  program: string;
  /** Its arguments, quotes taken off. */
  args: string[];
  /** The words as written (wrappers included), quotes taken off. */
  argv: string[];
  /** Every word is known before it runs (no `$x`, `$(…)`, no xargs input). */
  literal: boolean;
  /** Wrappers taken off, in order: `sudo`, `env`, `timeout`, `xargs`… */
  wrappers: string[];
  redirects: Redirect[];
  /** Where it runs: null on this computer, else the host an `ssh` names. */
  host: string | null;
  /** How it was reached: inside `sh -c`, on the far side of `ssh`, or inside `$(…)`. */
  via: "shell" | "ssh" | "substitution" | null;
  /** Programs that feed its input through a pipe. */
  pipedFrom: string[];
  /** The folder a `cd` before it in the same line moved to, when literal. */
  dir: string | null;
  /** Its source text. */
  text: string;
}

/** An `ssh` in the line: its host, options and the command it runs there. */
export interface SshCall {
  host: string;
  /** `-F <file>`, when given. */
  config: string | null;
  /** The command run on the host ("" for an interactive login). */
  remote: string;
  literal: boolean;
}

export interface Parsed {
  parts: Part[];
  ssh: SshCall[];
  /** The parser met something it could not read: nothing may be allowed at once. */
  error: boolean;
}

let parser: Parser | null = null;
let loading: Promise<void> | null = null;

/** Loads the grammar once (a few tens of milliseconds); parsing is synchronous afterwards. */
export function initParser(): Promise<void> {
  if (parser) return Promise.resolve();
  loading ??= (async () => {
    const require = createRequire(import.meta.url);
    await Parser.init();
    const bash = await Language.load(require.resolve("tree-sitter-bash/tree-sitter-bash.wasm"));
    const p = new Parser();
    p.setLanguage(bash);
    parser = p;
  })();
  return loading;
}

export const parserReady = () => parser !== null;

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "mksh", "fish"]);
const MAX_DEPTH = 8;

/** Parses a command line. Throws when `initParser` has not finished. */
export function parseCommand(command: string): Parsed {
  if (!parser) throw new Error("The command parser is not loaded yet.");
  const out: Parsed = { parts: [], ssh: [], error: false };
  parseInto(command, out, { host: null, via: null, depth: 0 });
  return out;
}

interface Ctx {
  host: string | null;
  via: Part["via"];
  depth: number;
}

function parseInto(source: string, out: Parsed, ctx: Ctx) {
  if (ctx.depth > MAX_DEPTH) {
    out.error = true;
    return;
  }
  const tree = (parser as Parser).parse(source);
  if (!tree) {
    out.error = true;
    return;
  }
  try {
    if (tree.rootNode.hasError) out.error = true;
    const dir = { value: null as string | null };
    walk(tree.rootNode, out, ctx, [], [], dir);
  } finally {
    tree.delete();
  }
}

/** A word's value as the shell passes it, and whether it is known before running. */
export function wordValue(node: Node): { value: string; literal: boolean } {
  switch (node.type) {
    case "word":
      return { value: node.text.replace(/\\(.)/gs, "$1"), literal: true };
    case "number":
      return { value: node.text, literal: true };
    case "raw_string":
      return { value: node.text.slice(1, -1), literal: true };
    case "ansi_c_string":
      return { value: node.text.slice(2, -1), literal: true };
    case "string": {
      const named = node.namedChildren;
      const literal = named.every((c) => c?.type === "string_content");
      const inner = node.text.slice(1, -1);
      return { value: inner.replace(/\\([\\"$`])/g, "$1"), literal };
    }
    case "concatenation": {
      let value = "";
      let literal = true;
      for (const c of node.children) {
        if (!c) continue;
        const v = wordValue(c);
        value += v.value;
        literal &&= v.literal;
      }
      return { value, literal };
    }
    default:
      return { value: node.text, literal: false };
  }
}

function redirectsOf(node: Node): Redirect[] {
  const out: Redirect[] = [];
  const files = node.type === "file_redirect" ? [node] : node.descendantsOfType("file_redirect");
  for (const r of files) {
    if (!r) continue;
    const dest = r.childForFieldName("destination") ?? r.namedChildren.at(-1);
    const op =
      r.children.find((c) => c && !c.isNamed && /[<>]/.test(c.type))?.type ??
      (/>>/.test(r.text) ? ">>" : ">");
    if (!dest) continue;
    const v = wordValue(dest);
    out.push({ op, target: v.value, literal: v.literal });
  }
  for (const h of node.type === "herestring_redirect"
    ? [node]
    : node.descendantsOfType("herestring_redirect")) {
    if (h) out.push({ op: "<<<", target: "", literal: true });
  }
  return out;
}

function walk(
  node: Node,
  out: Parsed,
  ctx: Ctx,
  redirects: Redirect[],
  pipedFrom: string[],
  dir: { value: string | null },
) {
  switch (node.type) {
    case "command":
      command(node, out, ctx, redirects, pipedFrom, dir);
      return;
    case "redirected_statement": {
      const own: Redirect[] = [];
      for (const r of node.childrenForFieldName("redirect")) if (r) own.push(...redirectsOf(r));
      const body = node.childForFieldName("body");
      if (body) walk(body, out, ctx, [...redirects, ...own], pipedFrom, dir);
      // A heredoc's or herestring's own substitutions still run.
      for (const r of node.childrenForFieldName("redirect"))
        if (r) walkSubstitutions(r, out, ctx, dir);
      return;
    }
    case "pipeline": {
      let before: string[] = pipedFrom;
      for (const c of node.namedChildren) {
        if (!c) continue;
        const start = out.parts.length;
        walk(c, out, ctx, redirects, before, dir);
        before = out.parts.slice(start).map((p) => p.program);
      }
      return;
    }
    case "subshell": {
      // A subshell's `cd` stays inside it.
      const inner = { value: dir.value };
      for (const c of node.namedChildren) if (c) walk(c, out, ctx, redirects, pipedFrom, inner);
      return;
    }
    case "command_substitution":
    case "process_substitution": {
      const inner = { value: dir.value };
      for (const c of node.namedChildren)
        if (c) walk(c, out, { ...ctx, via: ctx.via ?? "substitution" }, [], [], inner);
      return;
    }
    case "function_definition":
    case "heredoc_body":
    case "comment":
      // A function's body runs only when called: its commands are still read.
      if (node.type === "function_definition") {
        const body = node.childForFieldName("body");
        if (body) walk(body, out, ctx, redirects, [], { value: dir.value });
      }
      return;
    default:
      for (const c of node.namedChildren) if (c) walk(c, out, ctx, redirects, pipedFrom, dir);
  }
}

/** Command substitutions inside words that aren't commands themselves (assignments, redirect targets). */
function walkSubstitutions(node: Node, out: Parsed, ctx: Ctx, dir: { value: string | null }) {
  for (const c of node.namedChildren) {
    if (!c) continue;
    if (c.type === "command_substitution" || c.type === "process_substitution")
      walk(c, out, ctx, [], [], dir);
    else walkSubstitutions(c, out, ctx, dir);
  }
}

function command(
  node: Node,
  out: Parsed,
  ctx: Ctx,
  redirects: Redirect[],
  pipedFrom: string[],
  dir: { value: string | null },
) {
  const words: { value: string; literal: boolean }[] = [];
  const own: Redirect[] = [];
  for (const c of node.namedChildren) {
    if (!c) continue;
    if (c.type === "variable_assignment") {
      walkSubstitutions(c, out, ctx, dir);
      continue;
    }
    if (c.type === "file_redirect" || c.type === "herestring_redirect") {
      own.push(...redirectsOf(c));
      walkSubstitutions(c, out, ctx, dir);
      continue;
    }
    if (c.type === "command_name") {
      const w = c.namedChild(0);
      if (w) words.push(wordValue(w));
      walkSubstitutions(c, out, ctx, dir);
      continue;
    }
    words.push(wordValue(c));
    if (c.type === "command_substitution" || c.type === "process_substitution")
      walk(c, out, ctx, [], [], dir);
    else walkSubstitutions(c, out, ctx, dir);
  }
  const argv = words.map((w) => w.value);
  const eff = effective(argv);
  const literal = words.every((w) => w.literal) && !eff.wrappers.includes("xargs");
  const part: Part = {
    program: eff.program,
    args: eff.args,
    argv,
    literal,
    wrappers: eff.wrappers,
    redirects: [...redirects, ...own],
    host: ctx.host,
    via: ctx.via,
    pipedFrom,
    dir: dir.value,
    text: node.text,
  };
  out.parts.push(part);

  // `cd <dir>` moves the rest of the line.
  if (part.program === "cd") {
    const target = part.args.find((a) => !a.startsWith("-"));
    dir.value = target && words.every((w) => w.literal) ? join(dir.value, target) : null;
  }

  // `sh -c '<script>'`: the script is read again.
  if (SHELLS.has(part.program)) {
    const i = part.args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
    if (i >= 0) {
      const script = part.args[i + 1];
      const scriptWord = words[words.length - part.args.length + i + 1];
      if (script !== undefined && scriptWord?.literal)
        parseInto(script, out, { host: ctx.host, via: ctx.via ?? "shell", depth: ctx.depth + 1 });
      else part.literal = false;
    }
  }

  // `ssh [options] host '<command>'`: the command is read again, as run on that host.
  if (part.program === "ssh" && !ctx.host) {
    const call = sshCall(part.args);
    if (call) {
      const offset = words.length - part.args.length;
      const remoteWords = words.slice(offset + call.remoteAt);
      call.literal = remoteWords.every((w) => w.literal);
      out.ssh.push(call);
      if (call.remote && call.literal)
        parseInto(call.remote, out, { host: call.host, via: "ssh", depth: ctx.depth + 1 });
      if (!call.literal) part.literal = false;
    }
  }
}

const join = (base: string | null, target: string) =>
  target.startsWith("/") || target.startsWith("~") || !base
    ? target
    : `${base.replace(/\/$/, "")}/${target}`;

/** ssh's options that take a value: `-F file`, `-o Opt=x`, `-p 22`… */
const SSH_WITH_VALUE = new Set("BbcDEeFIiJLlmOoPpQRSWw".split(""));

/** An ssh's host, config and remote command, from its arguments. */
export function sshCall(args: string[]): (SshCall & { remoteAt: number }) | null {
  let config: string | null = null;
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--") {
      i++;
      break;
    }
    if (!a.startsWith("-") || a === "-") break;
    // Clustered flags: `-tt`, `-qF file`, `-p22`.
    for (let k = 1; k < a.length; k++) {
      const f = a[k] as string;
      if (SSH_WITH_VALUE.has(f)) {
        const inline = a.slice(k + 1);
        const value = inline || (args[++i] ?? "");
        if (f === "F") config = value;
        break;
      }
    }
  }
  const host = args[i];
  if (host === undefined) return null;
  const remote = args.slice(i + 1).join(" ");
  return {
    host: host.replace(/^[^@]+@/, ""),
    config,
    remote,
    literal: true,
    remoteAt: i + 1,
  };
}

/** Options of wrappers that take a value. */
const WRAPPER_VALUES: Record<string, Set<string>> = {
  sudo: new Set(["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U", "-T", "--user", "--group"]),
  doas: new Set(["-u", "-C"]),
  env: new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]),
  timeout: new Set(["-s", "-k", "--signal", "--kill-after"]),
  nice: new Set(["-n", "--adjustment"]),
  ionice: new Set(["-c", "-n", "--class", "--classdata"]),
  stdbuf: new Set(["-i", "-o", "-e"]),
  xargs: new Set(["-n", "-I", "-i", "-d", "-P", "-L", "-l", "-s", "-E", "-e", "-a", "--max-args"]),
  chrt: new Set([]),
  taskset: new Set([]),
  exec: new Set(["-a"]),
  time: new Set(["-f", "-o"]),
  command: new Set([]),
  nohup: new Set([]),
  setsid: new Set([]),
  caffeinate: new Set([]),
  unbuffer: new Set([]),
  watch: new Set(["-n", "-d", "--interval"]),
  flock: new Set(["-w", "-E", "-c"]),
};

const basename = (p: string) => p.split("/").at(-1) ?? p;

/** The program a command really runs, its wrappers taken off. */
export function effective(argv: string[]): { program: string; args: string[]; wrappers: string[] } {
  const wrappers: string[] = [];
  let i = 0;
  for (;;) {
    const w = argv[i];
    // A wrapper alone (`env`, `sudo` with no command) is the program itself.
    if (w === undefined) return { program: wrappers.pop() ?? "", args: [], wrappers };
    const name = basename(w);
    const values = WRAPPER_VALUES[name];
    // `command -v x` only looks a program up.
    if (name === "command" && /^-[vV]$/.test(argv[i + 1] ?? ""))
      return { program: "command", args: argv.slice(i + 1), wrappers };
    if (!values) return { program: name, args: argv.slice(i + 1), wrappers };
    wrappers.push(name);
    i++;
    // Its options, then for env its assignments, for timeout its duration, for taskset its mask.
    while (i < argv.length) {
      const a = argv[i] as string;
      if (a === "--") {
        i++;
        break;
      }
      if (a.startsWith("-") && a !== "-") {
        i += values.has(a) ? 2 : 1;
        continue;
      }
      if (name === "env" && /^\w+=/.test(a)) {
        i++;
        continue;
      }
      if (name === "sudo" && /^\w+=/.test(a)) {
        i++;
        continue;
      }
      break;
    }
    if (name === "timeout" || name === "taskset" || name === "chrt") i++;
  }
}
