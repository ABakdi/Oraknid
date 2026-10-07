import { store } from "@/lib/store";

/**
 * The command palette's search (Web-UI → Layout → Command palette): every
 * place and control as an entry, found by a fuzzy match over its name, what
 * is under it and its words, with the ones I opened lately first.
 */

export interface PaletteEntry {
  /** Unique: "<group>:<id>". */
  key: string;
  group: string;
  label: string;
  /** Under the name: a job's description, a project's folder… */
  sub?: string;
  /** Words it is also found by. */
  keywords?: string;
  /** Where it goes; a control has `run` instead. */
  href?: string;
  run?: () => unknown;
  /** What it says in the toast once it has run. */
  done?: string;
  /** Can't be taken back: a second step names what happens (Web-UI → A second step). */
  confirm?: string;
}

/**
 * How well `query` matches `text`, fuzzily: each of its words must appear
 * in order as letters of the text (a subsequence); runs of letters, word
 * starts and the very start score more. 0: no match.
 */
export function fuzzyScore(query: string, text: string): number {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return 1;
  const hay = text.toLowerCase();
  let total = 0;
  for (const w of words) {
    const s = wordScore(w, hay);
    if (!s) return 0;
    total += s;
  }
  return total;
}

function wordScore(word: string, hay: string): number {
  // A plain substring is the best kind of match.
  const at = hay.indexOf(word);
  if (at >= 0) {
    const start = at === 0 || /[^a-z0-9]/.test(hay[at - 1] ?? "");
    return 10 * word.length + (start ? 8 : 0) + (at === 0 ? 4 : 0);
  }
  let score = 0;
  let from = 0;
  let prev = -2;
  for (const ch of word) {
    const i = hay.indexOf(ch, from);
    if (i < 0) return 0;
    score += i === prev + 1 ? 3 : 1;
    if (i === 0 || /[^a-z0-9]/.test(hay[i - 1] ?? "")) score += 2;
    prev = i;
    from = i + 1;
  }
  return score;
}

/** At most this many of one group while searching, so every group shows. */
const PER_GROUP = 8;

/**
 * The entries a query finds, best first, at most a few of each group; the
 * ones I chose lately rank higher. No query: nothing but `recent` is
 * searched for (the palette shows the places and controls as they are).
 */
export function searchPalette(
  entries: PaletteEntry[],
  query: string,
  recent: string[] = [],
): PaletteEntry[] {
  if (!query.trim()) return entries;
  const scored = entries
    .map((e) => {
      const name = fuzzyScore(query, e.label);
      const rest = fuzzyScore(query, `${e.label} ${e.sub ?? ""} ${e.keywords ?? ""} ${e.group}`);
      const lately = recent.indexOf(e.key);
      const s = Math.max(name * 2, rest);
      return { e, s: s ? s + (lately >= 0 ? 10 - Math.min(lately, 9) : 0) : 0 };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);
  const count = new Map<string, number>();
  return scored
    .filter(({ e }) => {
      const n = (count.get(e.group) ?? 0) + 1;
      count.set(e.group, n);
      return n <= PER_GROUP;
    })
    .map((x) => x.e);
}

/** What I chose lately, newest first: a place's key, name and address. */
export interface RecentItem {
  key: string;
  label: string;
  sub?: string;
  href: string;
}

const RECENT = "palette.recent";
const KEEP = 8;

export const recentItems = (): RecentItem[] => {
  try {
    const v = JSON.parse(store.get(RECENT) ?? "[]");
    return Array.isArray(v)
      ? v.filter((x): x is RecentItem => typeof x?.key === "string" && typeof x?.href === "string")
      : [];
  } catch {
    return [];
  }
};

/** Remembers a place I opened from the palette, on this device only. */
export function remember(e: PaletteEntry) {
  if (!e.href) return;
  const item: RecentItem = {
    key: e.key,
    label: e.label,
    href: e.href,
    ...(e.sub ? { sub: e.sub } : {}),
  };
  store.set(
    RECENT,
    JSON.stringify([item, ...recentItems().filter((x) => x.key !== e.key)].slice(0, KEEP)),
  );
}
