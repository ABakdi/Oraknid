import { decide, type PolicyContext, type PolicyVerdict } from "@oraknid/core";
import { readsOnlyProgram } from "@oraknid/guard";

// Commands a job runs on one of its servers (ADR-049): `ssh <alias> …`,
// read as what runs there. Root on a server is the server's business (sudo
// there is judged as a change, never refused as root on this computer); a
// server marked production asks before anything that isn't only reading.

/** One of a job's servers, as its commands name it. */
export interface JobServerRef {
  id: string;
  name: string;
  alias: string;
  production: boolean;
}

/** ssh's options that take a value: `-F file`, `-o Opt=x`, `-p 22`… */
const WITH_VALUE = new Set(
  "-B -b -c -D -E -e -F -I -i -J -L -l -m -O -o -p -Q -R -S -W -w".split(" "),
);

/**
 * An `ssh` to one of the aliases: the alias, the command it runs there,
 * and whether the whole command line is that one ssh (nothing after it
 * runs on this computer: no `|`, `;` or `&&` outside quotes).
 */
export function parseSsh(
  command: string,
  aliases: string[],
): { alias: string; remote: string; whole: boolean } | null {
  let rest = command.trim();
  const head = /^ssh(?:\s+|$)/.exec(rest);
  if (!head) return null;
  rest = rest.slice(head[0].length);
  for (;;) {
    const m = /^(-[A-Za-z0-9]+)(?:\s+|$)/.exec(rest);
    if (!m) break;
    rest = rest.slice(m[0].length);
    if (WITH_VALUE.has(m[1] as string)) {
      const v = /^(\S+)(?:\s+|$)/.exec(rest);
      if (!v) return null;
      rest = rest.slice(v[0].length);
    }
  }
  const h = /^(\S+)(?:\s+([\s\S]*))?$/.exec(rest);
  if (!h) return null;
  const alias = (h[1] as string).replace(/^[^@]+@/, "");
  if (!aliases.includes(alias)) return null;
  const raw = (h[2] ?? "").trim();
  const quoted = /^'([^']*)'$/.exec(raw) ?? /^"((?:[^"\\]|\\.)*)"$/.exec(raw);
  if (quoted) return { alias, remote: quoted[1] as string, whole: true };
  return { alias, remote: raw, whole: segments(raw).length <= 1 };
}

/** scp, rsync or sftp to or from one of the aliases (`alias:/path`): which one. */
export function copyAlias(command: string, aliases: string[]): string | null {
  if (!/^\s*(scp|rsync|sftp)\b/.test(command)) return null;
  return (
    aliases.find((a) => new RegExp(`(^|[\\s@])${a.replace(/[.]/g, "\\.")}:`).test(command)) ?? null
  );
}

/** The command line split where the shell runs another program: `;`, `&`, `|`, newlines (quotes kept). */
function segments(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string;
    if (q) {
      if (c === q) q = null;
      else if (c === "\\" && q === '"') cur += line[i++] ?? "";
      cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      cur += c;
      continue;
    }
    if (
      c === ";" ||
      c === "\n" ||
      c === "|" ||
      (c === "&" && line[i - 1] !== ">" && line[i + 1] !== ">")
    ) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** A segment's words, quotes taken off. */
function words(segment: string): string[] {
  const out: string[] = [];
  for (const m of segment.matchAll(/'([^']*)'|"((?:[^"\\]|\\.)*)"|(\S+)/g))
    out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}

/** The program and its arguments once `sudo`, `env A=b`, `timeout 5` and the like are taken off. */
function core(w: string[]): string[] {
  let i = 0;
  for (;;) {
    const x = w[i];
    if (x === undefined) return [];
    if (/^\w+=/.test(x)) i++;
    else if (x === "sudo") {
      i++;
      while (w[i]?.startsWith("-")) i += w[i] === "-u" || w[i] === "-g" ? 2 : 1;
    } else if (x === "env" || x === "nice" || x === "ionice" || x === "command") i++;
    else if (x === "timeout") i += 2;
    else return w.slice(i);
  }
}

/** Writing to a file with `>` or `>>` (but not `2>&1` or `>/dev/null`). */
const WRITES_FILE = (segment: string) =>
  /(^|[^0-9&<])>>?\s*(?!&|\/dev\/null\b)\S/.test(segment.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, ""));

/** Whether a command run on a server only reads: every program in it, with its arguments. */
export function readsOnly(remote: string): boolean {
  const parts = segments(remote);
  if (!parts.length) return false;
  return parts.every((segment) => {
    if (WRITES_FILE(segment)) return false;
    const [program, ...args] = core(words(segment));
    if (!program) return false;
    // The read-only list is the guard's, the same here and over ssh (ADR-053).
    return readsOnlyProgram(program.split("/").at(-1) as string, args);
  });
}

/** `sudo` taken off a command run on a server, for the policy of this computer. */
export function withoutSudo(remote: string): string {
  return remote.replace(/(^|[\s;&|(])sudo(?:\s+(?:-[ug]\s+\S+|-[A-Za-z]+))*\s+/g, "$1");
}

/**
 * The verdict on a command that reaches one of the job's servers, or null
 * when it reaches none of them (the usual policy then decides). The command
 * is judged by this computer's policy as `ssh <alias> <what runs there>`,
 * with root there not refused; on production, a change asks.
 */
export function serverVerdict(
  command: string,
  servers: JobServerRef[],
  policy: PolicyContext,
): PolicyVerdict | null {
  const aliases = servers.map((s) => s.alias);
  const ssh = parseSsh(command, aliases);
  const copy = ssh ? null : copyAlias(command, aliases);
  const alias = ssh?.alias ?? copy;
  if (!alias) return null;
  const server = servers.find((s) => s.alias === alias) as JobServerRef;
  // Only an ssh that is the whole line has its remote side read apart (a local `| sudo tee` stays local).
  const local = ssh?.whole ? `ssh ${alias} ${withoutSudo(ssh.remote)}` : command;
  const v = decide({ tool: "Bash", command: local, path: null }, policy);
  if (v.verdict === "deny") return v;
  const reads = !!ssh?.whole && readsOnly(ssh.remote);
  if (server.production && !reads)
    return {
      verdict: "ask",
      reason: `it may change ${server.name}, which is production`,
      gated: null,
    };
  return v;
}
