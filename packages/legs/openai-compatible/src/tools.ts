import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { PermissionRequest, SandboxPlan } from "@oraknid/leg-sdk";

/**
 * The tools Oraknid gives a bare model (Leg-Adapters → OpenAI-compatible).
 * The daemon runs them: files only inside the worktree, commands only
 * inside the sandbox.
 */
export const TOOLS = [
  fn(
    "read_file",
    "Read a text file in the workspace.",
    { path: str("Path relative to the workspace.") },
    ["path"],
  ),
  fn(
    "write_file",
    "Create or overwrite a text file in the workspace.",
    { path: str("Path relative to the workspace."), content: str("The whole new content.") },
    ["path", "content"],
  ),
  fn(
    "edit_file",
    "Replace one exact occurrence of old_text with new_text in a file.",
    {
      path: str("Path relative to the workspace."),
      old_text: str("Exact text to find."),
      new_text: str("Replacement."),
    },
    ["path", "old_text", "new_text"],
  ),
  fn(
    "list_dir",
    "List a directory in the workspace.",
    { path: str("Directory, relative; '.' for the root.") },
    ["path"],
  ),
  fn(
    "search",
    "Search file contents in the workspace for a regular expression (ripgrep or grep).",
    {
      pattern: str("Regular expression."),
      path: str("Where to search, relative; '.' for everywhere."),
    },
    ["pattern"],
  ),
  fn(
    "run_command",
    "Run a shell command in the workspace.",
    { command: str("The command line.") },
    ["command"],
  ),
] as const;

function fn(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
) {
  return {
    type: "function" as const,
    function: { name, description, parameters: { type: "object", properties, required } },
  };
}
function str(description: string) {
  return { type: "string", description };
}

/** Tools that change something need a permission decision; reads inside the workspace do not. */
export const MUTATING = new Set(["write_file", "edit_file", "run_command"]);

export function toRequest(
  cwd: string,
  tool: string,
  args: Record<string, unknown>,
): PermissionRequest {
  return {
    tool,
    input: args,
    command: tool === "run_command" ? String(args.command ?? "") : null,
    path: typeof args.path === "string" ? resolve(cwd, args.path) : null,
  };
}

export class ToolError extends Error {}

/** Resolves a path and refuses anything outside the workspace, symlinks included. */
export function inside(cwd: string, p: unknown): string {
  if (typeof p !== "string" || p === "") throw new ToolError("A path is required.");
  const root = realpathSync(cwd);
  const full = resolve(root, p);
  // Check the deepest existing ancestor, so a symlink cannot lead out.
  let probe = full;
  while (!existsSync(probe)) probe = dirname(probe);
  const real = realpathSync(probe);
  const rel = relative(root, real);
  if (rel.startsWith("..") || isAbsolute(rel))
    throw new ToolError(`${p} is outside the workspace.`);
  const relFull = relative(root, full);
  if (relFull.startsWith("..") || isAbsolute(relFull))
    throw new ToolError(`${p} is outside the workspace.`);
  return full;
}

const MAX_OUTPUT = 20_000;
const clip = (s: string) =>
  s.length > MAX_OUTPUT
    ? `${s.slice(0, MAX_OUTPUT)}\n… (${s.length - MAX_OUTPUT} more characters cut)`
    : s;

export interface ToolContext {
  cwd: string;
  sandbox: SandboxPlan | null;
  signal: AbortSignal;
  commandTimeoutMs: number;
}

export async function runTool(
  ctx: ToolContext,
  tool: string,
  args: Record<string, unknown>,
): Promise<string> {
  switch (tool) {
    case "read_file": {
      const p = inside(ctx.cwd, args.path);
      if (!existsSync(p)) throw new ToolError(`${String(args.path)} does not exist.`);
      return clip(readFileSync(p, "utf8"));
    }
    case "write_file": {
      const p = inside(ctx.cwd, args.path);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, String(args.content ?? ""));
      return `Wrote ${String(args.path)}.`;
    }
    case "edit_file": {
      const p = inside(ctx.cwd, args.path);
      if (!existsSync(p)) throw new ToolError(`${String(args.path)} does not exist.`);
      const text = readFileSync(p, "utf8");
      const old = String(args.old_text ?? "");
      const count = old ? text.split(old).length - 1 : 0;
      if (count !== 1) {
        throw new ToolError(
          count === 0
            ? "old_text was not found."
            : `old_text occurs ${count} times; make it unique.`,
        );
      }
      writeFileSync(p, text.replace(old, String(args.new_text ?? "")));
      return `Edited ${String(args.path)}.`;
    }
    case "list_dir": {
      const p = inside(ctx.cwd, args.path ?? ".");
      return readdirSync(p)
        .sort()
        .map((name) => (statSync(resolve(p, name)).isDirectory() ? `${name}/` : name))
        .join("\n");
    }
    case "search": {
      const where = relative(ctx.cwd, inside(ctx.cwd, args.path ?? ".")) || ".";
      const pattern = String(args.pattern ?? "");
      return run(ctx, "grep", [
        "-rnI",
        "--exclude-dir=.git",
        "--exclude-dir=node_modules",
        "-E",
        "--",
        pattern,
        where,
      ]);
    }
    case "run_command":
      return run(ctx, "/bin/sh", ["-c", String(args.command ?? "")]);
    default:
      throw new ToolError(`There is no tool called ${tool}.`);
  }
}

/** Runs a process in the sandbox (when there is one) and returns its combined output and exit code. */
function run(ctx: ToolContext, command: string, args: string[]): Promise<string> {
  const wrapped = ctx.sandbox
    ? ctx.sandbox.sandbox.wrap({
        command,
        args,
        cwd: ctx.cwd,
        writable: [...new Set([ctx.cwd, ctx.sandbox.home, ...ctx.sandbox.writable])],
        readonly: ctx.sandbox.readonly,
        home: ctx.sandbox.home,
        env: ctx.sandbox.env,
      })
    : { command, args };
  return new Promise((resolvePromise) => {
    const child = spawn(wrapped.command, wrapped.args, {
      cwd: ctx.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      signal: ctx.signal,
      timeout: ctx.commandTimeoutMs,
      killSignal: "SIGKILL",
    });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      out += d;
    });
    child.on("error", (e) => resolvePromise(clip(`${out}\n${e.message}`.trim())));
    child.on("close", (code, signal) => {
      const status = signal ? `killed (${signal})` : `exit ${code}`;
      resolvePromise(clip(`${out}${out.endsWith("\n") || !out ? "" : "\n"}[${status}]`));
    });
  });
}
