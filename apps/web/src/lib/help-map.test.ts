import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ALL_CONTROLS, CONTROLS, itemOf, PAGES, pathOf, screensText } from "./help-map";

// The map of the screens stays true (ADR-041): every control it names is in the screens.

const src = join(__dirname, "..");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return files(p);
    return /\.tsx$/.test(f) && !/\.test\.tsx$/.test(f) ? [p] : [];
  });
const sources = new Map(files(src).map((f) => [f.slice(src.length + 1), readFileSync(f, "utf8")]));
const all = [...sources.values()].join("\n");
const literal = new Set(
  [...all.matchAll(/\b(?:data-help|help)="([^"]+)"/g)].map((m) => m[1] as string),
);
const read = (f: string) => sources.get(f) ?? "";
/** The file builds `data-help` from this template (written here without its `${…}`). */
const builds = (f: string, template: string) =>
  read(f).includes(`data-help={\`${template.replaceAll("{", "${")}\`}`);

/** Where an id that isn't written out in full comes from. */
function inScreens(id: string): boolean {
  if (literal.has(id)) return true;
  // A page's tabs: PageTabs gives each `<page>.tab.<tab>` (page-tabs.tsx).
  const tab = /^(\w+)\.tab\.([\w-]+)$/.exec(id);
  if (tab) {
    const page = read(`pages/${tab[1]}.tsx`);
    return (
      builds("components/page-tabs.tsx", "{helpKey}.tab.{x.id}") &&
      page.includes("<PageTabs") &&
      new RegExp(`id: "${tab[2]}"`).test(page)
    );
  }
  // An account's switches: toggle("auto", …) gives `mail.account.auto`.
  const account = /^mail\.account\.(\w+)$/.exec(id);
  if (account)
    return (
      builds("components/mail-accounts-card.tsx", "mail.account.{id}") &&
      new RegExp(`toggle\\(\\s*"${account[1]}"`).test(read("components/mail-accounts-card.tsx"))
    );
  // The sidebar's pages: `nav.<label>`.
  const nav = /^nav\.(\w+)$/.exec(id);
  if (nav)
    return (
      builds("components/shell.tsx", "nav.{label.toLowerCase()}") &&
      new RegExp(`label: "${nav[1]}"`, "i").test(read("components/shell.tsx"))
    );
  return false;
}

describe("the map of the screens (ADR-041)", () => {
  it("names every control that is in the screens, by its data-help id", () => {
    const missing = ALL_CONTROLS.map((c) => c.id).filter((id) => !inScreens(id));
    expect(missing).toEqual([]);
    // The steps that open a menu or a dialog are in the screens too.
    const via = ALL_CONTROLS.flatMap((c) => c.via ?? []).filter((id) => !inScreens(id));
    expect(via).toEqual([]);
    // Enough of them to be useful.
    expect(CONTROLS.length).toBeGreaterThanOrEqual(40);
  });

  it("has one entry per id, on pages and tabs that exist", () => {
    const ids = ALL_CONTROLS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of ALL_CONTROLS) {
      if (c.page === null) continue;
      const p = PAGES.find((x) => x.id === c.page);
      expect(p, c.id).toBeDefined();
      if (c.tab) expect(p?.tabs?.some((x) => x.id === c.tab) ?? true, c.id).toBe(true);
    }
  });

  it("builds a page's address from its item and tab, dropping what's missing", () => {
    expect(pathOf("settings", undefined, "security")).toBe("/settings/security");
    expect(pathOf("settings")).toBe("/settings");
    expect(pathOf("projects", "P1", "work")).toBe("/projects/P1/work");
    expect(pathOf("projects", undefined, "work")).toBe("/projects");
    expect(pathOf("overview")).toBe("/");
    expect(pathOf("/projects/P1/eye")).toBe("/projects/P1/eye");
    expect(pathOf('/x"><script>')).toBeNull();
    expect(pathOf("nowhere")).toBeNull();
    expect(itemOf("projects", "/projects/P1/settings")).toBe("P1");
    expect(itemOf("projects", "/settings/general")).toBeUndefined();
  });

  it("reads to the helper as pages, tabs and controls by id", () => {
    const text = screensText();
    expect(text).toContain("- settings: Settings (/settings/{tab})");
    expect(text).toContain("security (Security:");
    expect(text).toMatch(/- work\.goal \[field\]: What do you want done\?/);
    expect(text).toMatch(/- project\.archive \[needs item\]/);
    expect(text.length).toBeLessThan(80_000);
  });
});
