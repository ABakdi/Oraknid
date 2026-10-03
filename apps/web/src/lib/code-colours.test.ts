import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Repos' code colours (ADR-040) read at AA (4.5:1) in both themes, on every
// surface code sits on: the well, a card, muted, the canvas, and a diff's
// added, removed and hunk rows. Read from index.css itself.

const css = readFileSync(join(__dirname, "..", "index.css"), "utf8");

/** Every `--name: #hex` (or `var(--other)`) in the blocks whose selector is exactly this. */
function tokens(selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = new RegExp(`(?:^|\\n)${selector.replace(".", "\\.")}\\s*\\{([^}]*)\\}`, "g");
  for (const block of css.matchAll(re))
    for (const m of (block[1] as string).matchAll(/--([\w-]+):\s*([^;]+);/g))
      out[m[1] as string] = (m[2] as string).trim();
  return out;
}

const light = tokens(":root");
const dark = { ...light, ...tokens(".dark") };

function resolve(t: Record<string, string>, name: string): string {
  let v = t[name];
  for (let i = 0; v?.startsWith("var(") && i < 5; i++) v = t[v.slice(6, -1)];
  if (!v || !/^#[0-9a-f]{6}$/i.test(v)) throw new Error(`--${name} isn't a colour: ${v}`);
  return v;
}

const rgb = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
const lum = (c: number[]) => {
  const [r, g, b] = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [
    number,
    number,
    number,
  ];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const mix = (a: number[], b: number[], t: number) =>
  a.map((v, i) => v * t + (b[i] as number) * (1 - t));
const ratio = (a: number[], b: number[]) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

const FG = [
  "code-keyword",
  "code-string",
  "code-number",
  "code-title",
  "code-type",
  "muted-foreground",
  "success",
  "destructive",
  "primary",
];

describe("Repos' code colours (ADR-040)", () => {
  for (const [name, t] of [
    ["light", light],
    ["dark", dark],
  ] as const)
    it(`read at AA in the ${name} theme`, () => {
      const field = rgb(resolve(t, "field"));
      const surfaces: Record<string, number[]> = {
        field,
        card: rgb(resolve(t, "card")),
        muted: rgb(resolve(t, "muted")),
        background: rgb(resolve(t, "background")),
        // The diff's rows: success/12, destructive/12 and primary/8 over the well.
        added: mix(rgb(resolve(t, "success")), field, 0.12),
        removed: mix(rgb(resolve(t, "destructive")), field, 0.12),
        hunk: mix(rgb(resolve(t, "primary")), field, 0.08),
      };
      const low: string[] = [];
      for (const fg of FG)
        for (const [s, bg] of Object.entries(surfaces)) {
          const r = ratio(rgb(resolve(t, fg)), bg);
          if (r < 4.5) low.push(`${fg} on ${s}: ${r.toFixed(2)}`);
        }
      expect(low).toEqual([]);
    });
});
