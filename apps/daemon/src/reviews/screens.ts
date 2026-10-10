import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ReviewScreen, ReviewScreenProfile, ReviewScreens } from "@oraknid/contracts";
import type { ReviewRow, Reviews } from "./service.ts";

// A review's screens (2026-10-10, the Keys design): a design made of one
// page per device (desktop.html, phone-landscape.html, phone-portrait.html)
// and no index.html. The review page picks the screen that fits the device
// it shows, at every device change; these are the pages it can pick from,
// each with the device its name speaks of.

/** The pages of a design folder: its .html files and its folders with an index.html, by name. */
export function pagesIn(dir: string): string[] {
  const pages: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return pages;
  }
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const full = join(dir, name);
    try {
      const st = statSync(full);
      if (st.isFile() && /\.html?$/i.test(name)) pages.push(name);
      else if (st.isDirectory() && existsSync(join(full, "index.html"))) pages.push(`${name}/`);
    } catch {}
  }
  return pages;
}

const PHONE = new Set(["phone", "phones", "mobile", "iphone", "android", "handset", "smartphone"]);
const TABLET = new Set(["tablet", "tablets", "ipad"]);
const LAPTOP = new Set(["laptop", "notebook", "macbook"]);
const DESKTOP = new Set(["desktop", "wide", "widescreen", "pc", "monitor"]);

/**
 * The device a page's name speaks of: "phone-portrait.html" →
 * phone-portrait, "mobile_landscape" → phone-landscape, "tablet" →
 * tablet, "wide" → desktop; a lone "portrait" or "landscape" is a
 * phone's; anything else is "other".
 */
export function screenProfile(name: string): ReviewScreenProfile {
  const words = name
    .toLowerCase()
    .replace(/\/$/, "")
    .replace(/\.html?$/, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const has = (set: Set<string>) => words.some((w) => set.has(w));
  const portrait = words.includes("portrait") || words.includes("vertical");
  const landscape = words.includes("landscape") || words.includes("horizontal");
  const turned = (base: "phone" | "tablet"): ReviewScreenProfile =>
    portrait ? `${base}-portrait` : landscape ? `${base}-landscape` : base;
  if (has(PHONE)) return turned("phone");
  if (has(TABLET)) return turned("tablet");
  if (has(LAPTOP)) return "laptop";
  if (has(DESKTOP)) return "desktop";
  if (portrait) return "phone-portrait";
  if (landscape) return "phone-landscape";
  return "other";
}

/** A page's name as the picker shows it: "phone-portrait.html" → "phone portrait". */
export const screenName = (page: string) =>
  page
    .replace(/\/$/, "")
    .replace(/\.html?$/i, "")
    .replace(/[-_]+/g, " ");

/** The screens of a design folder: its pages at the top, index.html as "/". */
export function designScreens(root: string): ReviewScreens {
  const pages = pagesIn(root);
  const index = pages.some((p) => p.toLowerCase() === "index.html");
  const screens: ReviewScreen[] = pages.map((p) =>
    p.toLowerCase() === "index.html"
      ? { path: "/", name: "index", profile: "other" }
      : { path: `/${encodeURI(p)}`, name: screenName(p), profile: screenProfile(p) },
  );
  return { index, screens };
}

/** A review's screens: a design's pages; an app is one, its entry (it fits each device itself). */
export function reviewScreens(reviews: Reviews, row: ReviewRow): ReviewScreens {
  if (row.kind !== "design")
    return { index: true, screens: [{ path: row.entry || "/", name: "app", profile: "other" }] };
  const root = reviews.designRoot(row);
  return root ? designScreens(root) : { index: false, screens: [] };
}
