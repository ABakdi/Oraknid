import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

// Syntax colouring for a file in Repos (ADR-040): highlight.js's core with
// the languages I use most, loaded only when a file is opened.

const LANGS = {
  bash,
  c,
  cpp,
  css,
  diff,
  go,
  ini,
  java,
  javascript,
  json,
  markdown,
  python,
  rust,
  sql,
  typescript,
  xml,
  yaml,
};
for (const [name, lang] of Object.entries(LANGS)) hljs.registerLanguage(name, lang);

const BY_EXT: Record<string, keyof typeof LANGS> = {
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  css: "css",
  diff: "diff",
  patch: "diff",
  go: "go",
  ini: "ini",
  toml: "ini",
  cfg: "ini",
  java: "java",
  kt: "java",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  json: "json",
  md: "markdown",
  markdown: "markdown",
  py: "python",
  rs: "rust",
  sql: "sql",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescript",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  vue: "xml",
  yml: "yaml",
  yaml: "yaml",
};

/** The language of a file by its name, or null for plain text. */
export function languageOf(path: string): string | null {
  const base = path.split("/").pop() ?? path;
  if (/^dockerfile$/i.test(base) || /^makefile$/i.test(base)) return "bash";
  const ext = base.includes(".") ? base.split(".").pop()?.toLowerCase() : undefined;
  return (ext && BY_EXT[ext]) || null;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The text as HTML, one string per line, each line's spans closed and
 * reopened on the next so a comment across lines keeps its colour. Only
 * highlight.js's own spans are in it: the text itself is escaped.
 */
export function highlightLines(text: string, lang: string | null): string[] {
  const html =
    lang && hljs.getLanguage(lang)
      ? hljs.highlight(text, { language: lang, ignoreIllegals: true }).value
      : escapeHtml(text);
  const out: string[] = [];
  const open: string[] = [];
  for (const line of html.split("\n")) {
    let body = open.join("");
    for (const m of line.matchAll(/<span[^>]*>|<\/span>/g)) {
      if (m[0] === "</span>") open.pop();
      else open.push(m[0]);
    }
    body += line + "</span>".repeat(open.length);
    out.push(body);
  }
  // The last newline of a file is not a line of its own.
  if (out.length > 1 && text.endsWith("\n")) out.pop();
  return out;
}
