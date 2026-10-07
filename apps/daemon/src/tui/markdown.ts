// Markdown for the terminal (ADR-055): The Eye's replies as the web renders
// them, in ANSI: headings bold, code dim and indented, lists with bullets,
// emphasis, links with their address. No library: what The Eye writes is
// plain Markdown, and every line is kept.

const ESC = "\x1b[";
export const ansi = {
  bold: (s: string) => `${ESC}1m${s}${ESC}22m`,
  dim: (s: string) => `${ESC}2m${s}${ESC}22m`,
  italic: (s: string) => `${ESC}3m${s}${ESC}23m`,
  underline: (s: string) => `${ESC}4m${s}${ESC}24m`,
  cyan: (s: string) => `${ESC}36m${s}${ESC}39m`,
  yellow: (s: string) => `${ESC}33m${s}${ESC}39m`,
  green: (s: string) => `${ESC}32m${s}${ESC}39m`,
  red: (s: string) => `${ESC}31m${s}${ESC}39m`,
  magenta: (s: string) => `${ESC}35m${s}${ESC}39m`,
};

/** Without its colours: for tests and widths. */
export function plain(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are what is removed
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Emphasis, code and links inside a line. */
export function inline(text: string): string {
  const codes: string[] = [];
  // Code first: nothing inside it is emphasis.
  let s = text.replace(/`([^`]+)`/g, (_m, c: string) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = s
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, href: string) =>
      label === href ? ansi.underline(href) : `${ansi.underline(label)} ${ansi.dim(`(${href})`)}`,
    )
    .replace(/\*\*([^*]+)\*\*/g, (_m, b: string) => ansi.bold(b))
    .replace(/__([^_]+)__/g, (_m, b: string) => ansi.bold(b))
    .replace(
      /(^|[^*\w])\*([^*\s][^*]*)\*(?!\*)/g,
      (_m, pre: string, i: string) => `${pre}${ansi.italic(i)}`,
    )
    .replace(
      /(^|[^_\w])_([^_\s][^_]*)_(?!\w)/g,
      (_m, pre: string, i: string) => `${pre}${ansi.italic(i)}`,
    )
    .replace(/~~([^~]+)~~/g, (_m, d: string) => ansi.dim(d));
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the placeholders set above
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => ansi.cyan(codes[Number(i)] ?? ""));
}

/** A Markdown text as terminal lines. */
export function renderMarkdown(text: string): string[] {
  const out: string[] = [];
  let fence: string | null = null;
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.replace(/\t/g, "  ");
    const f = /^\s*(```|~~~)/.exec(line);
    if (f) {
      if (fence === null) {
        fence = f[1] ?? "```";
        const lang = line.trim().slice(3).trim();
        if (lang) out.push(ansi.dim(`  ${lang}`));
      } else fence = null;
      continue;
    }
    if (fence !== null) {
      out.push(ansi.cyan(`  ${line}`));
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const title = inline(h[2] ?? "");
      out.push(h[1] === "#" ? ansi.bold(ansi.underline(title)) : ansi.bold(title));
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push(ansi.dim("─".repeat(24)));
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      out.push(`${ansi.dim("│")} ${ansi.italic(inline(quote[1] ?? ""))}`);
      continue;
    }
    const task = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (task) {
      out.push(`${task[1]}${task[2] === " " ? "☐" : ansi.green("☑")} ${inline(task[3] ?? "")}`);
      continue;
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      out.push(`${bullet[1]}• ${inline(bullet[2] ?? "")}`);
      continue;
    }
    const numbered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      out.push(`${numbered[1]}${numbered[2]}. ${inline(numbered[3] ?? "")}`);
      continue;
    }
    // A table's rule line goes; its rows stay, cells apart.
    if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line)) continue;
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const cells = line
        .trim()
        .slice(1, -1)
        .split("|")
        .map((c) => inline(c.trim()));
      out.push(cells.join(ansi.dim("  │  ")));
      continue;
    }
    out.push(inline(line));
  }
  // No blank lines at the ends, nor two in a row.
  const tidy: string[] = [];
  for (const l of out) if (l.trim() || (tidy.length && tidy.at(-1)?.trim())) tidy.push(l);
  while (tidy.length && !tidy.at(-1)?.trim()) tidy.pop();
  return tidy;
}
