// A task's scope as drift control measures it (Drift-Control → D1, M13.22):
// the globs its plan gave it, the files its own checks name, the files its
// instructions say it writes, and, for research and planning, docs/.
//
// Seen 2026-10-04: a research task whose plan said its scope was
// ["research", "documentation"] wrote docs/audio-libraries-recommendation.md,
// the very file its check tested (`test -s docs/audio-libraries-recommendation.md`),
// and D1 called that "outside its scope", put it back, reset and reassigned.

/** What scope needs to know of a task. */
export interface ScopedTask {
  kind: string;
  scope: string[];
  verify: string[];
  instructions?: string;
}

/** Task kinds whose deliverable is a document: theirs may go under docs/. */
const WRITES_DOCS = new Set(["research", "plan"]);

/**
 * The globs a task may change: its own scope, plus the files its checks
 * name and its instructions say it produces, plus docs/ for research and
 * planning. What a check reads is what the task must leave behind.
 */
export function taskScope(t: ScopedTask): string[] {
  const out = new Set(t.scope);
  for (const v of t.verify) for (const p of pathsIn(v)) out.add(p);
  if (t.instructions) for (const p of statedOutputs(t.instructions)) out.add(p);
  if (WRITES_DOCS.has(t.kind)) out.add("docs/**");
  return [...out];
}

/** A relative path or glob in a command line: `docs/x.md`, `src/**\/*.ts`, `package.json`. */
const PATH = /^(?:[\w@+*?-][\w@.+*?-]*\/)*[\w@+*?-][\w@.+*?-]*$/;

/**
 * The relative paths a shell command names as words: its files, not its
 * programs, options, URLs or numbers. Quoted text with spaces (an awk
 * program, a message) is no path.
 */
export function pathsIn(command: string): string[] {
  const out: string[] = [];
  for (const w of words(command)) {
    const word = w.text.replace(/^\.\//, "");
    if (!PATH.test(word) || word.includes("..")) continue;
    // A path has a folder or an extension; a bare word is a program or an argument. Quoted,
    // a word without a folder is more often a pattern or a message ('Tone.js') than a file.
    const hasDir = word.includes("/");
    if (w.quoted && !hasDir) continue;
    const ext = /\.([A-Za-z][\w-]{0,9})$/.exec(word);
    if (!hasDir && !ext) continue;
    if (/^\d+(\.\d+)*$/.test(word)) continue;
    out.push(word);
  }
  return [...new Set(out)];
}

/** Shell words, quotes taken off; separators (`;`, `|`, `&`, redirections) split them. */
function words(command: string): { text: string; quoted: boolean }[] {
  const out: { text: string; quoted: boolean }[] = [];
  let cur = "";
  let quote: string | null = null;
  let any = false;
  let quoted = false;
  const flush = () => {
    if (any) out.push({ text: cur, quoted });
    cur = "";
    any = false;
    quoted = false;
  };
  for (const c of command) {
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      any = true;
      quoted = true;
      continue;
    }
    if (/[\s;|&()<>]/.test(c)) {
      flush();
      continue;
    }
    cur += c;
    any = true;
  }
  flush();
  return out;
}

/**
 * Files the instructions say the task writes: a path with a document's or
 * data's extension after "write", "create", "save", "produce"… in the same
 * line (`Write the comparison to docs/audio.md`).
 */
export function statedOutputs(instructions: string): string[] {
  const out = new Set<string>();
  const re =
    /\b(?:writ|creat|sav|produc|output|record|put|add|generat|updat)\w*\b[^\n]{0,80}?[`'"(\s]((?:[\w@+-][\w@.+-]*\/)*[\w@+-][\w@.+-]*\.(?:md|markdown|mdx|txt|rst|adoc|json|ya?ml|toml|csv|tsv|html?))(?=[`'")\s,.;:]|$)/gi;
  for (const m of instructions.matchAll(re)) {
    const p = (m[1] as string).replace(/^\.\//, "");
    if (!p.includes("..")) out.add(p);
  }
  return [...out];
}
