// A `.env` text read and written (ADR-059): `KEY=value` lines, `export`,
// single and double quotes (double quotes with \n, \", \\ escapes and
// spanning lines), and comments. What can't be read is said by its line
// number, never by its value.

export interface DotEnvEntry {
  name: string;
  value: string;
  line: number;
}

export function parseDotEnv(text: string): {
  entries: DotEnvEntry[];
  skipped: { line: number; reason: string }[];
} {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const entries: DotEnvEntry[] = [];
  const skipped: { line: number; reason: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const raw = (lines[i] ?? "").trim();
    if (!raw || raw.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s?(.*)$/.exec(raw);
    if (!m) {
      skipped.push({ line: lineNo, reason: "not a KEY=value line" });
      continue;
    }
    const name = m[1] as string;
    let rest = (m[2] ?? "").trim();
    let value: string;
    if (rest.startsWith('"')) {
      // Until the closing quote, maybe on a later line.
      let body = rest.slice(1);
      let end = closing(body, '"');
      while (end < 0 && i + 1 < lines.length) {
        i++;
        body += `\n${lines[i] ?? ""}`;
        end = closing(body, '"');
      }
      if (end < 0) {
        skipped.push({ line: lineNo, reason: `${name}: its quote is never closed` });
        continue;
      }
      value = body
        .slice(0, end)
        .replace(/\\(.)/g, (_, c: string) =>
          c === "n" ? "\n" : c === "r" ? "\r" : c === "t" ? "\t" : c,
        );
    } else if (rest.startsWith("'")) {
      const end = rest.indexOf("'", 1);
      if (end < 0) {
        skipped.push({ line: lineNo, reason: `${name}: its quote is never closed` });
        continue;
      }
      value = rest.slice(1, end);
    } else {
      // An unquoted value ends at a comment after a space.
      const hash = rest.search(/\s#/);
      if (hash >= 0) rest = rest.slice(0, hash);
      value = rest.trim();
    }
    entries.push({ name, value, line: lineNo });
  }
  return { entries, skipped };
}

/** Where the unescaped quote `q` closes `s`, or -1. */
function closing(s: string, q: string): number {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\") {
      i++;
      continue;
    }
    if (s[i] === q) return i;
  }
  return -1;
}

/** `NAME=value` lines, a value quoted when it needs to be (sh and dotenv read it back the same). */
export function toDotEnv(values: Record<string, string>): string {
  const out: string[] = [];
  for (const name of Object.keys(values).sort()) {
    const v = values[name] ?? "";
    if (/^[A-Za-z0-9_./:@%+,=-]*$/.test(v)) out.push(`${name}=${v}`);
    else
      out.push(
        `${name}="${v
          .replaceAll("\\", "\\\\")
          .replaceAll('"', '\\"')
          .replaceAll("$", "\\$")
          .replaceAll("`", "\\`")
          .replaceAll("\n", "\\n")}"`,
      );
  }
  return `${out.join("\n")}\n`;
}
