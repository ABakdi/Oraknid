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
  const skipped = optionsLength(rest);
  if (skipped === null) return null;
  rest = rest.slice(skipped);
  const h = /^(\S+)(?:\s+([\s\S]*))?$/.exec(rest);
  if (!h) return null;
  const alias = (h[1] as string).replace(/^[^@]+@/, "");
  if (!aliases.includes(alias)) return null;
  const raw = (h[2] ?? "").trim();
  const quoted = /^'([^']*)'$/.exec(raw) ?? /^"((?:[^"\\]|\\.)*)"$/.exec(raw);
  if (quoted) return { alias, remote: quoted[1] as string, whole: true };
  return { alias, remote: raw, whole: segments(raw).length <= 1 };
}

/** How much of `text` is ssh's options (`-F file -o X=y -q`), with the space after them; null when one lacks its value. */
function optionsLength(text: string): number | null {
  let at = 0;
  for (;;) {
    const m = /^(-[A-Za-z0-9]+)(?:\s+|$)/.exec(text.slice(at));
    if (!m) return at;
    at += m[0].length;
    if (WITH_VALUE.has(m[1] as string)) {
      const v = /^(\S+)(?:\s+|$)/.exec(text.slice(at));
      if (!v) return null;
      at += v[0].length;
    }
  }
}

/** Where an ssh starts in a command line: after a separator, with the variables set for it (`HOME=… ssh`). */
const SSH_AT = /(^|[\s;&|(`])((?:[A-Za-z_]\w*=(?:'[^']*'|"[^"]*"|[^\s;&|()]*)\s+)*)ssh\s+/g;

/** A trailing `# guard …` (or any) comment of a check: the shell ignores it; Oraknid reads it. */
const COMMENT = /\s+#[^'"\n]*$/;

/** A check that guards what the work must keep true (`… # guard: Harvest still runs`). */
export const isGuardCheck = (command: string) => /\s#\s*guard\b/i.test(command);

/**
 * A check on one of the job's servers in its plain form (ADR-049): each
 * `ssh` to an alias as `ssh <alias>` alone. The variables set for it
 * (`HOME=<the job's home>`) and its options (`-F <the job's ssh config>`,
 * `-o BatchMode=yes`) are the agent's way to the server, private to its
 * sandbox and not where checks run (there, ssh can't open them: it said
 * "Can't open user config file …/jobs/<job>/ho", its own message cut at
 * 100 characters); Oraknid reaches the server over its own connection.
 */
export function plainServerCheck(command: string, aliases: string[]): string {
  let out = "";
  let last = 0;
  for (const m of command.matchAll(SSH_AT)) {
    const start = (m.index ?? 0) + (m[1] as string).length;
    const after = (m.index ?? 0) + m[0].length;
    if (start < last) continue;
    const rest = command.slice(after);
    const skipped = optionsLength(rest);
    if (skipped === null) continue;
    const h = /^(\S+)(\s+|$)/.exec(rest.slice(skipped));
    if (!h) continue;
    const alias = (h[1] as string).replace(/^[^@]+@/, "");
    if (!aliases.includes(alias)) continue;
    out += `${command.slice(last, start)}ssh ${alias}${h[2] ? " " : ""}`;
    last = after + skipped + h[0].length;
  }
  return `${out}${command.slice(last)}`.trim();
}

/**
 * A check that runs on one of the job's servers: the alias, the command run
 * there, and the check in its plain form. `ssh <alias> <command>` runs as
 * it is; a check that wraps its ssh in local shell (`n=$(ssh <alias> docker
 * ps -q | wc -l); [ "$n" -ge 2 ]`) runs whole on the server, its ssh taken
 * off, when every ssh in it goes to the same one of the job's servers and
 * nothing else in it reaches another machine. Null: not a server check.
 */
export function serverCheckOf(
  command: string,
  aliases: string[],
): { alias: string; remote: string; plain: string } | null {
  const plain = plainServerCheck(command, aliases);
  const bare = plain.replace(COMMENT, "").trim();
  const direct = parseSsh(bare, aliases);
  if (direct) return { alias: direct.alias, remote: direct.remote, plain };
  if (/\b(scp|rsync|sftp)\b/.test(bare) || copyAlias(bare, aliases)) return null;
  let remote = "";
  let last = 0;
  let alias: string | null = null;
  const re = /(^|[\s;&|(`])ssh\s+(\S+)\s+/g;
  for (let m = re.exec(bare); m; m = re.exec(bare)) {
    const at = m.index + (m[1] as string).length;
    if (at < last) continue;
    const to = m[2] as string;
    if (!aliases.includes(to) || (alias && alias !== to)) return null;
    alias = to;
    remote += bare.slice(last, at);
    let i = m.index + m[0].length;
    // `ssh <alias> '<command>'`: the quotes go with the ssh.
    const q = bare[i];
    if (q === "'" || q === '"') {
      let j = i + 1;
      let inner = "";
      for (; j < bare.length && bare[j] !== q; j++) {
        if (q === '"' && bare[j] === "\\" && j + 1 < bare.length) j++;
        inner += bare[j];
      }
      if (j >= bare.length) return null;
      remote += inner;
      i = j + 1;
    }
    last = i;
    re.lastIndex = i;
  }
  if (!alias) return null;
  remote += bare.slice(last);
  // Any other ssh left in it reaches somewhere else.
  if (/(^|[\s;&|(`])ssh\s/.test(remote)) return null;
  return { alias, remote: remote.trim(), plain };
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
  // A command substitution and a subshell are programs of their own: `n=$(docker ps -q | wc -l)`.
  const parts = segments(remote.replace(COMMENT, "").replace(/\$\(|[()`]/g, ";"));
  if (!parts.length) return false;
  return parts.every((segment) => {
    if (WRITES_FILE(segment)) return false;
    const all = words(segment);
    const [program, ...args] = core(all);
    // Only setting a variable (`n=` of `n=$(…)`) runs nothing.
    if (!program) return all.length > 0 && all.every((x) => /^\w+=/.test(x));
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

/** A compose project as `docker compose` names it: -p, the folder of -f, --project-directory, or the folder it runs in. */
function composeProjectOf(args: string[], dir: string | null): string | null {
  const base = (p: string) => p.replace(/\/+$/, "").split("/").at(-1) || null;
  for (let i = 0; i < args.length; i++) {
    const x = args[i] as string;
    if (x === "-p" || x === "--project-name") return args[i + 1] ?? null;
    const m = /^--project-name=(.+)$/.exec(x);
    if (m) return m[1] as string;
  }
  for (let i = 0; i < args.length; i++) {
    const x = args[i] as string;
    if (x === "--project-directory" && args[i + 1]) return base(args[i + 1] as string);
    if ((x === "-f" || x === "--file") && args[i + 1]) {
      const f = args[i + 1] as string;
      if (f.includes("/")) return base(f.slice(0, f.lastIndexOf("/")));
    }
  }
  return dir ? base(dir) : null;
}

/** docker's options that take a value, for telling its words apart. */
const DOCKER_WITH_VALUE = new Set(["-p", "--project-name", "-f", "--file", "--project-directory"]);

/**
 * What a change run on a server removes, by name (ADR-049): the paths of
 * an `rm`, the project of a `docker compose down`, the volumes, containers,
 * images or networks of a `docker … rm`. Null when it does anything else
 * (reading and `cd` aside), or names what it removes only through the
 * shell (`$x`, globs) or by a path too near the root to be one thing.
 */
export function removalTargets(remote: string): string[] | null {
  const targets: string[] = [];
  let dir: string | null = null;
  for (const segment of segments(withoutSudo(remote).replace(COMMENT, ""))) {
    const [program, ...args] = core(words(segment));
    if (!program) return null;
    const name = program.split("/").at(-1) as string;
    if (name === "cd") {
      dir = args[0] ?? null;
      continue;
    }
    if (readsOnly(segment)) continue;
    if (name === "rm" || name === "rmdir" || name === "unlink") {
      const paths = args.filter((x) => !x.startsWith("-"));
      if (!paths.length) return null;
      for (const x of paths) {
        if (!/^\/[^*?$`{}[\]\s]+$/.test(x) || x.split("/").filter(Boolean).length < 2) return null;
        targets.push(x.replace(/\/+$/, ""));
      }
      continue;
    }
    if (name === "docker" || name === "podman" || name === "docker-compose") {
      const plain: string[] = [];
      for (let i = 0; i < args.length; i++) {
        const x = args[i] as string;
        if (DOCKER_WITH_VALUE.has(x)) i++;
        else if (!x.startsWith("-")) plain.push(x);
      }
      const w = name === "docker-compose" ? ["compose", ...plain] : plain;
      if (w[0] === "compose" && (w.includes("down") || w.includes("rm"))) {
        const project = composeProjectOf(args, dir);
        if (!project) return null;
        targets.push(project);
        continue;
      }
      const two = /^(volume|network|container|image)$/.test(w[0] ?? "");
      const sub = two ? `${w[0]} ${w[1]}` : (w[0] ?? "");
      if (/^((volume|network|container|image) (rm|remove)|rm|rmi)$/.test(sub)) {
        const names = w.slice(two ? 2 : 1);
        if (!names.length || names.some((x) => /[$`*?]/.test(x))) return null;
        targets.push(...names);
        continue;
      }
    }
    return null;
  }
  return targets.length ? targets : null;
}

/** The line of `text` that names `target` (a path, or a name as a word), or null. */
export function namedIn(target: string, text: string): string | null {
  const esc = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = target.startsWith("/")
    ? new RegExp(`(^|[^\\w./-])${esc}/?(?=\\.?(?:$|[^\\w./-]))`, "m")
    : new RegExp(`(^|[^\\w.-])${esc}(?=\\.?(?:$|[^\\w-]))`, "im");
  const m = re.exec(text);
  if (!m) return null;
  const start = text.lastIndexOf("\n", m.index) + 1;
  const end = text.indexOf("\n", m.index + m[0].length);
  return text.slice(start, end < 0 ? undefined : end).trim();
}
