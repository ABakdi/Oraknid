// A small shell lexer for the permission policy (Checkpoint 1 → B1-01):
// which programs does a command line really run? It understands quotes,
// escapes, comments, heredocs, redirections, assignments, reserved words,
// `for … in` lists, `case` patterns, function definitions, and command
// and process substitution, which it reads recursively. It never runs
// anything.

const RESERVED = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "while",
  "until",
  "do",
  "done",
  "case",
  "esac",
  "for",
  "select",
  "in",
  "function",
  "time",
  "!",
  "{",
  "}",
  "[[",
  "]]",
  "coproc",
]);

/** Words after which a new command starts. */
const OPENS = new Set(["then", "else", "elif", "do", "!", "time", "{", "if", "while", "until"]);

/** Built-ins and keywords that are not programs at all. */
const BUILTIN_NOOPS = new Set(["", ":", "true", "false"]);

export function programsIn(script: string): string[] {
  const out: string[] = [];
  parse(script, out, 0);
  return out;
}

function parse(src: string, out: string[], depth: number): void {
  if (depth > 20) return;
  let i = 0;
  let atCommand = true;
  /** for/select: skip the variable and its `in` list until `do`. */
  let skipUntilDo = false;
  /** case: the subject, then patterns ending in `)`. */
  let caseState: "subject" | "in" | "pattern" | null = null;
  const pendingHeredocs: { delim: string; strip: boolean }[] = [];
  /** The next word is a redirection target, not a command. */
  let redirectTarget = false;

  const readWord = (): string => {
    let w = "";
    while (i < src.length) {
      const c = src[i] as string;
      if (/\s/.test(c) || ";&|()<>".includes(c)) {
        // `<(` and `>(` are process substitution only at the start of a word.
        if ((c === "<" || c === ">") && src[i + 1] === "(" && w === "") {
          const end = matching(src, i + 1);
          parse(src.slice(i + 2, end), out, depth + 1);
          i = end + 1;
          w += "_";
          continue;
        }
        break;
      }
      if (c === "\\") {
        w += src[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === "'") {
        const end = src.indexOf("'", i + 1);
        w += src.slice(i + 1, end < 0 ? src.length : end);
        i = end < 0 ? src.length : end + 1;
        continue;
      }
      if (c === '"') {
        i++;
        while (i < src.length && src[i] !== '"') {
          if (src[i] === "\\") {
            w += src[i + 1] ?? "";
            i += 2;
          } else if (src[i] === "$" && src[i + 1] === "(" && src[i + 2] !== "(") {
            const end = matching(src, i + 1);
            parse(src.slice(i + 2, end), out, depth + 1);
            i = end + 1;
            w += "_";
          } else if (src[i] === "`") {
            const end = src.indexOf("`", i + 1);
            parse(src.slice(i + 1, end < 0 ? src.length : end), out, depth + 1);
            i = end < 0 ? src.length : end + 1;
            w += "_";
          } else {
            w += src[i];
            i++;
          }
        }
        i++;
        continue;
      }
      if (c === "$" && src[i + 1] === "(") {
        const end = matching(src, i + 1);
        // $(( … )) is arithmetic; $( … ) runs commands.
        if (src[i + 2] !== "(") parse(src.slice(i + 2, end), out, depth + 1);
        i = end + 1;
        w += "_";
        continue;
      }
      if (c === "`") {
        const end = src.indexOf("`", i + 1);
        parse(src.slice(i + 1, end < 0 ? src.length : end), out, depth + 1);
        i = end < 0 ? src.length : end + 1;
        w += "_";
        continue;
      }
      w += c;
      i++;
    }
    return w;
  };

  const skipHeredocBodies = () => {
    // Called at a newline: each pending heredoc's body runs until its delimiter line.
    for (const h of pendingHeredocs.splice(0)) {
      for (;;) {
        if (i >= src.length) return;
        const nl = src.indexOf("\n", i);
        const line = src.slice(i, nl < 0 ? src.length : nl);
        i = nl < 0 ? src.length : nl + 1;
        if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) break;
      }
    }
  };

  while (i < src.length) {
    const c = src[i] as string;
    if (c === "\n") {
      i++;
      skipHeredocBodies();
      if (!skipUntilDo) atCommand = true;
      if (caseState === "in") caseState = "pattern";
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      i++;
      continue;
    }
    if (c === "#" && (i === 0 || /\s|;|&|\|/.test(src[i - 1] as string))) {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === ";") {
      if (src[i + 1] === ";") {
        // `;;` ends a case branch: a pattern comes next.
        i += 2;
        if (caseState) caseState = "pattern";
        continue;
      }
      i++;
      if (!skipUntilDo) atCommand = true;
      continue;
    }
    if (c === "|" && caseState === "pattern") {
      // `a|b)`: alternatives of one case pattern, not a pipe.
      i++;
      continue;
    }
    if ((c === "<" || c === ">") && src[i + 1] === "(") {
      // Process substitution: its commands run too.
      const end = matching(src, i + 1);
      parse(src.slice(i + 2, end), out, depth + 1);
      i = end + 1;
      continue;
    }
    if (c === "&" || c === "|") {
      i +=
        src[i + 1] === c || (c === "&" && src[i + 1] === ">") || (c === "|" && src[i + 1] === "&")
          ? 2
          : 1;
      if (src[i - 1] === ">") redirectTarget = true;
      else atCommand = true;
      continue;
    }
    if (c === "(" || c === ")") {
      i++;
      // In a case statement, `)` ends a pattern: the branch's command follows.
      if (caseState === "pattern" && c === "(") continue;
      if (caseState === "pattern") caseState = "in";
      atCommand = true;
      continue;
    }
    if (c === "<" || c === ">" || (/[0-9]/.test(c) && /[<>]/.test(src[i + 1] ?? ""))) {
      // Redirection: `<`, `>`, `>>`, `2>`, `>&2`, heredoc `<<`/`<<-`, herestring `<<<`.
      if (/[0-9]/.test(c)) i++;
      if (src.startsWith("<<<", i)) {
        i += 3;
        redirectTarget = true;
        continue;
      }
      if (src.startsWith("<<", i)) {
        i += 2;
        const strip = src[i] === "-";
        if (strip) i++;
        while (src[i] === " ") i++;
        const delim = readWord();
        pendingHeredocs.push({ delim, strip });
        continue;
      }
      i++;
      if (src[i] === ">" || src[i] === "&" || src[i] === "|") i++;
      if (src[i - 1] === "&" && /[0-9-]/.test(src[i] ?? "")) {
        i++;
        continue;
      }
      redirectTarget = true;
      continue;
    }

    const word = readWord();
    if (word === "" && i < src.length && !/\s/.test(src[i] as string)) {
      i++;
      continue;
    }
    if (redirectTarget) {
      redirectTarget = false;
      continue;
    }
    if (caseState === "subject") {
      if (word === "in") caseState = "pattern";
      continue;
    }
    if (caseState === "pattern") {
      if (word === "esac") {
        caseState = null;
        atCommand = false;
        continue;
      }
      // A pattern word; its `)` (handled above) starts the branch's command.
      continue;
    }
    if (skipUntilDo) {
      if (word === "do") {
        skipUntilDo = false;
        atCommand = true;
      }
      continue;
    }
    if (!atCommand) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/.test(word)) continue; // assignment before a command
    if (RESERVED.has(word)) {
      if (word === "for" || word === "select") skipUntilDo = true;
      else if (word === "case") caseState = "subject";
      else if (word === "function") {
        readWordAfterSpaces();
        atCommand = false;
      } else if (OPENS.has(word)) atCommand = true;
      else
        atCommand =
          word === "done" || word === "fi" || word === "esac" || word === "}" ? false : atCommand;
      continue;
    }
    // `name() { … }` defines a function.
    if (src.slice(i).match(/^\s*\(\s*\)/)) {
      i = src.indexOf(")", i) + 1;
      atCommand = true;
      continue;
    }
    atCommand = false;
    const program = word.replace(/^.*\//, "");
    if (!BUILTIN_NOOPS.has(program) && word !== "_") out.push(program);
    // A program that runs another one (`bash -c …`, `env …`, `find -exec …`):
    // what it runs is read too, or the policy would see only the wrapper (Audit 2).
    if (RUNS_OTHERS.has(program)) {
      const args: string[] = [];
      for (;;) {
        while (src[i] === " " || src[i] === "\t") i++;
        if (i >= src.length || /[\n;&|()<>]/.test(src[i] as string)) break;
        if (/[0-9]/.test(src[i] as string) && /[<>]/.test(src[i + 1] ?? "")) break;
        const w = readWord();
        if (w === "" && i < src.length && !/\s/.test(src[i] as string)) break;
        args.push(w);
      }
      for (const inner of innerCommands(program, args)) parse(inner, out, depth + 1);
    }
  }

  function readWordAfterSpaces() {
    while (src[i] === " ") i++;
    readWord();
  }
}

const SHELLS = new Set(["sh", "bash", "dash", "zsh", "ksh", "mksh", "ash", "fish", "busybox"]);
/** Run the command in their arguments, after their own options. */
const EXECS = new Set([
  "env",
  "nice",
  "nohup",
  "timeout",
  "stdbuf",
  "setsid",
  "command",
  "exec",
  "builtin",
  "doas",
  "sudo",
  "time",
  "ionice",
  "taskset",
  "chrt",
  "flock",
  "unbuffer",
  "strace",
  "ltrace",
  "nsenter",
  "unshare",
  "chroot",
  "runuser",
  "xargs",
  "parallel",
]);
/** Their first plain argument is theirs (a duration, a mask, a lock file, a root), not the command. */
const TAKES_ONE = new Set(["timeout", "taskset", "chrt", "flock", "chroot", "runuser"]);
const RUNS_OTHERS = new Set([...SHELLS, ...EXECS, "eval", "watch", "find"]);

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

/** The command lines a wrapper runs, from its (unquoted) arguments. */
function innerCommands(program: string, args: string[]): string[] {
  if (SHELLS.has(program)) {
    // `-c script`, also inside a cluster: `-lc`, `-ec`, `-xc`.
    const at = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
    if (at >= 0 && args[at + 1] !== undefined) return [args[at + 1] as string];
    // `busybox sh …` / `busybox wget …`: the applet is the program.
    if (program === "busybox" && args[0]) return [args.map(quote).join(" ")];
    return [];
  }
  if (program === "eval" || program === "watch") {
    const rest = program === "watch" ? args.filter((a) => !a.startsWith("-")) : args;
    return rest.length ? [rest.join(" ")] : [];
  }
  if (program === "find") {
    const out: string[] = [];
    for (let k = 0; k < args.length; k++)
      if (/^-(exec|execdir|ok|okdir)$/.test(args[k] as string)) {
        const cmd: string[] = [];
        for (k++; k < args.length && args[k] !== ";" && args[k] !== "+"; k++)
          cmd.push(args[k] as string);
        if (cmd.length) out.push(cmd.map(quote).join(" "));
      }
    return out;
  }
  // EXECS: skip options (and an option's value when it is a separate word), assignments, then their own argument.
  let k = 0;
  let own = TAKES_ONE.has(program) ? 1 : 0;
  while (k < args.length) {
    const a = args[k] as string;
    if (a === "--") {
      k++;
      break;
    }
    if (a.startsWith("-")) {
      // `-n 5`, `-I {}`, `-u user`: a short option with a separate value.
      if (/^-[nIuPLdEsagcp]$/.test(a) && program !== "env") k++;
      k++;
      continue;
    }
    if (program === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) {
      k++;
      continue;
    }
    if (own > 0) {
      own--;
      k++;
      continue;
    }
    break;
  }
  return k < args.length ? [args.slice(k).map(quote).join(" ")] : [];
}

/** The index of the parenthesis that closes the one at `open`, respecting quotes. */
function matching(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end < 0) return src.length;
      i = end;
      continue;
    }
    if (c === "(") depth++;
    if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return src.length;
}
