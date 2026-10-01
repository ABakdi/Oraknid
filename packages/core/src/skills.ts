// The skill format (docs/01-Specification/Skills.md): markdown with
// optional front matter. Bad front matter never blocks an upload; what
// was ignored is said plainly.

export interface ParsedSkill {
  name: string;
  description: string;
  interview: boolean;
  requiredTools: string[];
  verify: string[];
  body: string;
  /** Front-matter problems, in words, for the UI. */
  ignored: string[];
}

export function parseSkill(markdown: string, fallbackName: string): ParsedSkill {
  const out: ParsedSkill = {
    name: fallbackName,
    description: "",
    interview: false,
    requiredTools: [],
    verify: [],
    body: markdown,
    ignored: [],
  };
  const m = markdown.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return out;
  out.body = markdown.slice(m[0].length).replace(/^\n+/, "");

  // A small YAML subset: `key: value`, `key: [a, b]`, `key:` followed by `- item` lines, one level of nesting.
  const fields = new Map<string, string | string[]>();
  let listKey: string | null = null;
  let parent: string | null = null;
  for (const raw of (m[1] as string).split("\n")) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const item = raw.match(/^\s+-\s+(.*)$/);
    if (item && listKey) {
      (fields.get(listKey) as string[]).push(unquote(item[1] as string));
      continue;
    }
    const kv = raw.match(/^(\s*)([\w-]+):\s*(.*)$/);
    if (!kv) {
      out.ignored.push(`Could not read the line "${raw.trim()}".`);
      continue;
    }
    const [, indent, key, value] = kv as unknown as [string, string, string, string];
    const name = indent ? `${parent}.${key}` : key;
    if (!indent) parent = key;
    if (value === "") {
      fields.set(name, []);
      listKey = name;
    } else if (value.startsWith("[")) {
      fields.set(
        name,
        value
          .replace(/^\[|\]$/g, "")
          .split(",")
          .map((s) => unquote(s.trim()))
          .filter(Boolean),
      );
      listKey = null;
    } else {
      fields.set(name, unquote(value));
      listKey = null;
    }
  }

  const str = (k: string) => {
    const v = fields.get(k);
    if (typeof v === "string") return v;
    if (v !== undefined && !(Array.isArray(v) && v.length === 0))
      out.ignored.push(`"${k}" should be text.`);
    return undefined;
  };
  const list = (k: string) => {
    const v = fields.get(k);
    if (Array.isArray(v)) return v;
    if (v !== undefined) out.ignored.push(`"${k}" should be a list.`);
    return undefined;
  };

  out.name = str("name") ?? fallbackName;
  out.description = str("description") ?? "";
  const interview = str("interview");
  if (interview !== undefined) {
    if (interview === "true" || interview === "false") out.interview = interview === "true";
    else out.ignored.push(`"interview" should be true or false, not "${interview}".`);
  }
  out.requiredTools = list("requires.tools") ?? [];
  out.verify = list("verify") ?? [];
  const known = new Set([
    "name",
    "description",
    "interview",
    "requires",
    "requires.tools",
    "verify",
    "metadata",
  ]);
  for (const k of fields.keys()) {
    if (!known.has(k) && !k.startsWith("metadata."))
      out.ignored.push(`"${k}" is not a field Oraknid knows; it was ignored.`);
  }
  return out;
}

const unquote = (s: string) => s.replace(/^(["'])(.*)\1$/, "$2");

/**
 * The part of a skill a session needs: its short version and the section
 * matching the task, never the whole file every time (Skills → The Eye).
 */
export function skillExcerpt(body: string, topic: string, maxChars = 4000): string {
  const sections = body.split(/^(?=## )/m);
  const intro = sections[0] ?? "";
  // Stems, so "release" finds "Releasing".
  const words = topic
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 3)
    .map((w) => w.slice(0, 5));
  const scored = sections
    .slice(1)
    .map((s) => ({ s, score: words.filter((w) => s.toLowerCase().includes(w)).length }))
    .sort((a, b) => b.score - a.score);
  const best = scored[0] && scored[0].score > 0 ? `\n\n${scored[0].s}` : "";
  const text = `${intro.trim()}${best}`;
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…` : text;
}
