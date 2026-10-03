import { posix } from "node:path";
import type { Autonomy } from "@oraknid/contracts";
import { programsIn } from "./shell.ts";

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

/** My own rules at one level (job, project, global): regex sources matched against commands. */
export interface RuleLevel {
  level: "job" | "project" | "global";
  allow: string[];
  deny: string[];
}

export interface PolicyContext {
  worktree: string;
  autonomy: Autonomy;
  /** Gates I waived for this job. */
  waived: ReadonlySet<GatedAction>;
  /**
   * My rules, most specific level first. The first level with a matching
   * rule decides; within a level, deny beats allow. The shipped
   * never-allowed list stays absolute whatever I write here.
   */
  rules?: RuleLevel[];
  /** The task's context holds untrusted content: gated actions always ask, whatever the autonomy (BR-15). */
  untrusted?: boolean;
  /**
   * What the job's tools declared about their calls, by `mcp__<tool>__<name>`
   * (ADR-021): a read passes, a send is the gated action `send`. Anything
   * else is an external write. "held": Oraknid's own tool holds the call
   * for my approval itself (an agent's email waits as a draft, ADR-032).
   */
  mcp?: ReadonlyMap<string, McpDeclaration>;
}

/**
 * What the policy knows of one MCP call (ADR-021, ADR-038): "read" passes;
 * "held" is held by Oraknid's own tool for my approval; a gated action asks
 * unless I waived it for the job; `{ linked }` is the project's linked
 * place (its GitHub repo), where the link is my approval, unless the task
 * read untrusted content (BR-15).
 */
export type McpDeclaration = "read" | "held" | GatedAction | { linked: GatedAction };

export type PolicyVerdict =
  | { verdict: "allow"; reason: string }
  /**
   * Refused. `drift` D7 is a forbidden action (it counts against the Leg);
   * null is a plain answer to the Leg (a check of Oraknid's it can't run).
   * `message` is what the Leg is told, when it isn't "Not allowed: <reason>".
   */
  | { verdict: "deny"; reason: string; drift: "D7" | null; message?: string }
  | { verdict: "ask"; reason: string; gated: GatedAction | null }
  /** Auto approval (ADR-014): a classifier decides between allow and ask. */
  | { verdict: "classify"; reason: string; programs: string[] };

/** A `.git` path as an argument: `.git`, `./.git`, `x/.git/…`, never `.gitignore` or `.github`. */
const GIT_PATH = String.raw`(^|[\s/'"=])\.git(/|['"]|\s|;|&|\||\)|$)`;
/** What the job folder's own `.git` rules say when one breaks (after the piano job, 2026-10-03). */
const KEEP_WORKTREE = "the job's folder must stay a worktree of the project";

/**
 * Checks Oraknid runs itself after the Leg ends (ADR-038, ADR-042):
 * `oraknid github-repo`, `oraknid github-branch <branch>`. No Leg can run
 * them (there is no `oraknid` in its sandbox), so trying is answered, never
 * asked about (after the piano job, 2026-10-03).
 */
export const ORAKNID_CHECK = /(^|[\s;&|(])oraknid\s+github-[\w-]+/;

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
  // A job's folder stays a worktree of its project (Jobs-and-Projects → Ending a job,
  // after the piano job, 2026-10-03): its `.git` is never re-created, moved or deleted.
  {
    pattern: new RegExp(
      String.raw`(^|[\s;&|(])(rm|rmdir|unlink|mv|cp|rsync|ln|tee|truncate|install|chmod|chown|shred)\b[^;&|\n]*` +
        GIT_PATH,
    ),
    why: `changes a .git: ${KEEP_WORKTREE}`,
  },
  {
    pattern: new RegExp(
      String.raw`(^|[^<>&0-9])>>?\s*` + GIT_PATH + String.raw`|\bdd\b[^;&|\n]*\bof=` + GIT_PATH,
    ),
    why: `writes into a .git: ${KEEP_WORKTREE}`,
  },
  {
    pattern: new RegExp(String.raw`\bsed\s+(-\S+\s+)*-i\S*\s[^;&|\n]*` + GIT_PATH),
    why: `edits a .git: ${KEEP_WORKTREE}`,
  },
  {
    // `git init` makes the folder a repository of its own; a scratch repo under /tmp is fine.
    pattern: /\bgit\s+init\b(?!(\s+-\S+)*\s+\/tmp\/)/,
    why: `makes a separate repository: ${KEEP_WORKTREE}`,
  },
  {
    pattern: /\bgit\s+worktree\s+(add|remove|move|prune|repair)\b|\.git\/worktrees\b/,
    why: "changes the project's worktrees, which Oraknid manages",
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

/**
 * Programs that work on files and processes but don't reach out on their
 * own: inside the sandbox they can only touch the worktree (ADR-014).
 */
const SANDBOX_SAFE = new Set(
  `python python3 python2 node deno bun ruby perl php lua bash zsh dash ksh go cargo rustc rustup gcc g++ cc clang clang++ ld make cmake ninja meson
   java javac kotlin mvn gradle dotnet swift zig nim elixir mix erl tsc esbuild vite rollup webpack swc playwright cypress mocha ava
   tar gzip gunzip zip unzip xz bzip2 zstd sha256sum md5sum shasum base64 hexdump od strings nl column fmt fold paste join comm split csplit
   seq yes expr bc dc numfmt stat file less more lsof ps pgrep top htop sqlite3 jq yq xmllint tidy pandoc convert identify ffmpeg sox
   npx npm pnpm yarn pip pip3 uv poetry pipenv bundle gem composer pytest tox nox black ruff mypy flake8 pylint isort prettier eslint biome
   shellcheck shfmt clang-format rustfmt gofmt go vet golint cat less ln install truncate dd mkfifo env printenv export unset alias source . type hash command
   exec wait trap set shift getopts local declare readonly return break continue exit cd pushd popd dirs umask ulimit times history`.split(
    /\s+/,
  ),
);

/** Programs that reach the network or credentials on their own: always a decision for the classifier. */
const REACHES_OUT = new Set(
  `curl wget ssh scp sftp rsync nc ncat netcat telnet ftp socat dig nslookup host ping traceroute gh glab aws gcloud az kubectl helm docker podman
   terraform ansible vault op pass gpg ssh-add ssh-keygen keyctl secret-tool security mail sendmail`.split(
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

/** The programs a command line runs, read as the shell reads it (B1-01). */
export function programsOf(command: string): string[] {
  return programsIn(command);
}

/** `..` and `.` are resolved first: `<worktree>/../x` is outside (Audit 1 → S1-05). */
const insideTree = (worktree: string, path: string) => {
  const p = posix.resolve(worktree, path);
  const w = posix.resolve(worktree);
  return p === w || p.startsWith(`${w}/`);
};

/** A rule I wrote that isn't a valid regex matches nothing, rather than breaking every decision. */
function safeTest(src: string, text: string): boolean {
  try {
    return new RegExp(src).test(text);
  } catch {
    return false;
  }
}

/** What my rules say about a command: the first level with a match decides; deny beats allow within it. */
function mine(command: string, rules: RuleLevel[]): PolicyVerdict | null {
  for (const level of rules) {
    const denied = level.deny.find((src) => safeTest(src, command));
    if (denied)
      return {
        verdict: "deny",
        reason: `matches my ${level.level} deny rule /${denied}/`,
        drift: "D7",
      };
    const allowed = level.allow.find((src) => safeTest(src, command));
    if (allowed)
      return { verdict: "allow", reason: `matches my ${level.level} allow rule /${allowed}/` };
  }
  return null;
}

/** A rule that allows exactly the programs of a command (for "allow this for the job"). */
export function allowRuleFor(command: string): string {
  const programs = [...new Set(programsOf(command))].map((p) =>
    p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  return `^\\s*(${programs.join("|")})(\\s|$)`;
}

/**
 * The command with git's and package managers' global options taken out, so
 * `git -C . push` reads as `git push` for the lists below (Audit 1 → S1-11).
 */
export function withoutGlobalOptions(command: string): string {
  return command
    .replace(
      /\bgit((?:\s+(?:-C\s+\S+|-c\s+\S+|--git-dir(?:=|\s+)\S+|--work-tree(?:=|\s+)\S+|--namespace(?:=|\s+)\S+|--no-pager|--paginate|-P|-p|--bare|--no-replace-objects|--literal-pathspecs|--exec-path(?:=\S+)?))+)(?=\s)/g,
      "git",
    )
    .replace(
      /\b(npm|pnpm|yarn)((?:\s+(?:--filter\s+\S+|-F\s+\S+|-C\s+\S+|--dir\s+\S+|--prefix\s+\S+|--workspace\s+\S+|-w\s+\S+|--?[\w-]+(?:=\S+)?))+)(?=\s)/g,
      "$1",
    );
}

/** Commands that fetch and run code, or run inline code: a look before they run (Audit 1 → S1-10). */
const FETCHES_OR_INLINE =
  /\b(npx|bunx|uvx)\s+(-\S+\s+)*(?!(vitest|tsc|tsx|eslint|prettier|biome|jest|playwright|vite|next|astro|turbo)\b)[@\w]|\b(pnpm|yarn)\s+dlx\b|\bnpm\s+exec\b|\b(pip3?|uv\s+pip)\s+install\b|\b(python3?|node|perl|ruby|php)\s+(-\S+\s+)*-[ce]\b/;

export function decide(r: PolicyRequest, ctx: PolicyContext): PolicyVerdict {
  const raw = r.command ?? "";
  const command = raw ? `${raw}\n${withoutGlobalOptions(raw)}` : "";
  const own = raw ? mine(raw, ctx.rules ?? []) : null;

  // Oraknid's own checks: answered to the Leg, never asked about, not a drift.
  if (raw && ORAKNID_CHECK.test(raw))
    return {
      verdict: "deny",
      reason: "it is a check Oraknid runs itself when the Leg finishes",
      drift: null,
      message:
        "Oraknid runs this check itself when you finish (it reads GitHub with the project's account); there is no `oraknid` command for you. Don't run it: do the task (GitHub work through the github tool), then say DONE.",
    };

  if (command) {
    for (const d of DEFAULT_DENY) {
      if (d.pattern.test(command))
        return { verdict: "deny", reason: `never allowed: it ${d.why}`, drift: "D7" };
    }
    if (own?.verdict === "deny") return own;
    for (const g of GATED) {
      if (!g.pattern.test(command)) continue;
      if (ctx.untrusted) {
        return {
          verdict: "ask",
          reason: `${g.action} needs my approval: this task read untrusted content`,
          gated: g.action,
        };
      }
      if (ctx.waived.has(g.action))
        return { verdict: "allow", reason: `${g.action} waived for this job` };
      // An allow rule of mine is a waiver for exactly what it matches.
      if (own?.verdict === "allow") return own;
      if (ctx.autonomy === "full" && !ALWAYS_GATED.has(g.action)) {
        return { verdict: "allow", reason: `${g.action} allowed at Full autonomy` };
      }
      return { verdict: "ask", reason: `${g.action} needs my approval`, gated: g.action };
    }
  }

  if (READ_ONLY_TOOLS.has(r.tool)) return { verdict: "allow", reason: "reads only" };

  if (FILE_TOOLS.has(r.tool)) {
    if (r.path && /(^|\/)\.git(\/|$)/.test(r.path))
      return {
        verdict: "deny",
        reason: `never allowed: it writes into a .git: ${KEEP_WORKTREE}`,
        drift: "D7",
      };
    if (r.path && insideTree(ctx.worktree, r.path))
      return { verdict: "allow", reason: "edits inside the worktree" };
    return {
      verdict: "ask",
      reason: `writes outside the worktree (${r.path ?? "no path"})`,
      gated: "delete",
    };
  }

  if (SHELL_TOOLS.has(r.tool)) {
    if (own?.verdict === "allow") return own;
    const unknown = [...new Set(programsOf(raw).filter((p) => !ALLOWED_PROGRAMS.has(p)))];
    const fetches = FETCHES_OR_INLINE.test(raw);
    if (fetches && ctx.autonomy === "standard")
      return {
        verdict: "classify",
        reason: "it fetches and runs code, or runs inline code, with the network open",
        programs: [...new Set(programsOf(raw))],
      };
    if (unknown.length === 0)
      return { verdict: "allow", reason: "every program is on the allow list" };
    // Supervised: every unknown program is my decision.
    if (ctx.autonomy === "supervised") {
      return {
        verdict: "ask",
        reason: `runs ${unknown.join(", ")}, which is not on the allow list`,
        gated: null,
      };
    }
    const outward = unknown.filter((p) => REACHES_OUT.has(p));
    const unfamiliar = unknown.filter((p) => !SANDBOX_SAFE.has(p) && !REACHES_OUT.has(p));
    if (outward.length === 0 && unfamiliar.length === 0) {
      return {
        verdict: "allow",
        reason: `${unknown.join(", ")} only work${unknown.length === 1 ? "s" : ""} inside the sandbox`,
      };
    }
    // Full: unfamiliar programs run in the sandbox; only what reaches out is classified.
    if (ctx.autonomy === "full" && outward.length === 0) {
      return { verdict: "allow", reason: "unknown, but in the sandbox at Full autonomy" };
    }
    const why = outward.length
      ? `${outward.join(", ")} can reach outside the machine`
      : `${unfamiliar.join(", ")} ${unfamiliar.length === 1 ? "is" : "are"} unfamiliar`;
    return { verdict: "classify", reason: why, programs: [...outward, ...unfamiliar] };
  }

  // An MCP tool may write outside: gated as an external write, like publishing (Security; Audit 1 → S1-15).
  if (r.tool.startsWith("mcp__")) {
    const declared = ctx.mcp?.get(r.tool);
    if (declared === "read") return { verdict: "allow", reason: `${r.tool} only reads` };
    if (declared === "held")
      return { verdict: "allow", reason: `${r.tool} waits for my approval in Oraknid itself` };
    if (typeof declared === "object") {
      if (!ctx.untrusted)
        return { verdict: "allow", reason: `${r.tool} works on the project's linked repo` };
      return {
        verdict: "ask",
        reason: `${r.tool} works on the project's linked repo, but this task read untrusted content`,
        gated: declared.linked,
      };
    }
    if (declared) {
      if (ctx.waived.has(declared) && !ctx.untrusted)
        return { verdict: "allow", reason: `${declared} waived for this job` };
      const what =
        declared === "send"
          ? "sends"
          : declared === "push"
            ? "pushes outside the project's linked repo, or rewrites its history"
            : declared === "delete"
              ? "deletes"
              : "may write outside the machine";
      return {
        verdict: "ask",
        reason: ctx.untrusted
          ? `${r.tool} ${what}, and this task read untrusted content`
          : `${r.tool} ${what}`,
        gated: declared,
      };
    }
    if (ctx.waived.has("external-write") && !ctx.untrusted)
      return { verdict: "allow", reason: "external-write waived for this job" };
    return {
      verdict: "ask",
      reason: `${r.tool} is an MCP tool: it may write outside the machine`,
      gated: "external-write",
    };
  }
  // A tool Oraknid doesn't know.
  if (ctx.autonomy === "full") return { verdict: "allow", reason: "unknown tool at Full autonomy" };
  if (ctx.autonomy === "supervised")
    return { verdict: "ask", reason: `uses ${r.tool}, which Oraknid does not know`, gated: null };
  return {
    verdict: "classify",
    reason: `uses ${r.tool}, which Oraknid does not know`,
    programs: [r.tool],
  };
}
