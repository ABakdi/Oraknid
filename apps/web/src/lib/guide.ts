import type { HelperGuidePage } from "@oraknid/contracts";
import order from "../../../site/docs/guide.json";

/**
 * The guide inside Oraknid (ADR-041): the site's own pages
 * (apps/site/docs/*.md), put in the app when it is built, so they read the
 * same offline and through The Nest. Written once, for the site and the app.
 */

const REPO = "https://github.com/ABakdi/Oraknid";

const files = import.meta.glob("../../../site/docs/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

export interface GuideHeading {
  /** The anchor: `/docs/<page>/<id>`. */
  id: string;
  text: string;
  level: number;
}

export interface GuidePage {
  slug: string;
  title: string;
  /** One line: what the page is about. */
  line: string;
  /** Its markdown, as the site renders it. */
  body: string;
  headings: GuideHeading[];
}

/** A heading's anchor, as GitHub makes them: "Your phone, from anywhere" → "your-phone-from-anywhere". */
export const anchorOf = (text: string) =>
  text
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");

const headingsOf = (body: string): GuideHeading[] => {
  const out: GuideHeading[] = [];
  let fence = false;
  for (const line of body.split("\n")) {
    if (line.startsWith("```")) fence = !fence;
    const m = !fence && /^(#{2,4})\s+(.+?)\s*#*$/.exec(line);
    if (m)
      out.push({ id: anchorOf(m[2] as string), text: m[2] as string, level: m[1]?.length ?? 2 });
  }
  return out;
};

export const GUIDE: GuidePage[] = (order as [string, string, string][])
  .filter(([slug]) => files[`../../../site/docs/${slug}.md`] !== undefined)
  .map(([slug, title, line]) => {
    const body = (files[`../../../site/docs/${slug}.md`] as string).replaceAll("{{repo}}", REPO);
    return { slug, title, line, body, headings: headingsOf(body) };
  });

export const guidePage = (slug: string | undefined) => GUIDE.find((p) => p.slug === slug);

/**
 * A link in the guide, made for the site (`jobs.html`, `/docs/jobs.html#x`,
 * `/docs/`), as a page of the app: `/docs/jobs`, a heading as one more
 * segment (`/docs/jobs/x`, which reads the same at home and through The
 * Nest, where the route itself is in the hash). Others are left alone.
 */
export function docHref(href: string): string {
  const m = /^(?:\/docs\/)?([a-z0-9-]+)\.html(?:#(.+))?$/.exec(href);
  if (m) return `/docs/${m[1]}${m[2] ? `/${m[2]}` : ""}`;
  if (href === "/docs/" || href === "/docs/index.html") return "/docs";
  return href;
}

// The search: over headings and text, a small score per section.

const STOP = new Set(
  "a an and are as at be by can do does for from how i in is it its me my of on or the this to what when where which who why will with you your".split(
    " ",
  ),
);

/** The words of a question worth searching for. */
export const terms = (q: string) => [
  ...new Set(
    q
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 1 && !STOP.has(w)),
  ),
];

interface Section {
  page: GuidePage;
  heading: GuideHeading | null;
  text: string;
}

const plain = (md: string) =>
  md
    .replace(/```[a-z]*\n?/g, "")
    .replace(/[`*_>#]/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

function sections(pages: GuidePage[]): Section[] {
  const out: Section[] = [];
  for (const page of pages) {
    let heading: GuideHeading | null = null;
    let lines: string[] = [];
    let fence = false;
    let h = 0;
    const flush = () => {
      const text = plain(lines.join("\n"));
      if (text || heading) out.push({ page, heading, text });
      lines = [];
    };
    for (const line of page.body.split("\n")) {
      if (line.startsWith("```")) fence = !fence;
      if (!fence && /^#{2,4}\s/.test(line)) {
        flush();
        heading = page.headings[h++] ?? null;
      } else if (!/^#\s/.test(line)) lines.push(line);
    }
    flush();
  }
  return out;
}

export interface GuideHit {
  slug: string;
  title: string;
  /** The section's heading, when it isn't the page's top. */
  heading: string | null;
  /** Where it goes: `/docs/<page>` or `/docs/<page>/<heading anchor>`. */
  href: string;
  /** A few words around the first match. */
  snippet: string;
  score: number;
}

const count = (hay: string, w: string) => {
  let n = 0;
  for (let i = hay.indexOf(w); i !== -1 && n < 3; i = hay.indexOf(w, i + w.length)) n++;
  return n;
};

/** Sections of the guide matching words of `q`, best first: headings weigh most. */
export function searchGuide(q: string, pages: GuidePage[] = GUIDE, limit = 20): GuideHit[] {
  const words = terms(q);
  if (!words.length) return [];
  const hits: GuideHit[] = [];
  for (const s of sections(pages)) {
    const head = (s.heading?.text ?? "").toLowerCase();
    const title = s.page.title.toLowerCase();
    const text = s.text.toLowerCase();
    let score = 0;
    let matched = 0;
    for (const w of words) {
      const here = (head.includes(w) ? 5 : 0) + (title.includes(w) ? 2 : 0) + count(text, w);
      if (here) matched++;
      score += here;
    }
    if (!score) continue;
    // Every word found in one section counts double.
    if (matched === words.length && words.length > 1) score *= 2;
    const at = Math.max(
      0,
      Math.min(...words.map((w) => text.indexOf(w)).filter((i) => i >= 0), text.length),
    );
    const start = Math.max(0, at - 60);
    const snippet = `${start ? "…" : ""}${s.text.slice(start, start + 160).trim()}${start + 160 < s.text.length ? "…" : ""}`;
    hits.push({
      slug: s.page.slug,
      title: s.page.title,
      heading: s.heading?.text ?? null,
      href: `/docs/${s.page.slug}${s.heading ? `/${s.heading.id}` : ""}`,
      snippet,
      score,
    });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * The guide's pages for the helper's context (ADR-041): the ones most
 * related to my question (and the page I asked from first); the whole
 * guide when none stands out, since it is small.
 */
export function guideFor(question: string, about?: string, max = 3): HelperGuidePage[] {
  const scores = new Map<string, number>();
  for (const h of searchGuide(question, GUIDE, 200))
    scores.set(h.slug, (scores.get(h.slug) ?? 0) + h.score);
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([slug]) => slug);
  const chosen = ranked.length
    ? [...new Set([...(about ? [about] : []), ...ranked])].slice(0, max)
    : GUIDE.map((p) => p.slug);
  return chosen
    .map((slug) => guidePage(slug))
    .filter((p): p is GuidePage => !!p)
    .map((p) => ({ slug: p.slug, title: p.title, text: p.body }));
}
