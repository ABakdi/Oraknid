import { toast } from "sonner";
import { t } from "./i18n";
import { remote } from "./remote";

/**
 * This page against the one the daemon serves now (ADR-048). After an update
 * the daemon serves a new build while a page left open still runs the old
 * one; its entry script's name (a content hash) tells them apart, whatever
 * the version says (dev updates keep it).
 */
const ENTRY = /\/assets\/index-[\w-]+\.js/;

export function entryOf(html: string): string | null {
  return html.match(ENTRY)?.[0] ?? null;
}

function loadedEntry(): string | null {
  for (const s of Array.from(document.scripts)) {
    const src = s.getAttribute("src");
    if (src && ENTRY.test(src)) return entryOf(src);
  }
  return null;
}

let told = false;

/** Whether the daemon now serves another build than this page's. */
export async function staleBuild(): Promise<boolean> {
  // Away from home the loader brings the app through the tunnel: it is checked there.
  if (remote()) return false;
  const mine = loadedEntry();
  if (!mine) return false;
  try {
    const res = await fetch("/", { cache: "no-store" });
    if (!res.ok) return false;
    const served = entryOf(await res.text());
    return !!served && served !== mine;
  } catch {
    return false;
  }
}

/**
 * Checked when the live socket comes back (a restart, as after an update) and
 * when I return to the tab: a page out of sight reloads by itself; one in
 * front of me offers the reload, so nothing I am typing is lost.
 */
export async function checkFresh() {
  if (told || !(await staleBuild())) return;
  if (document.visibilityState === "hidden") {
    location.reload();
    return;
  }
  told = true;
  toast(t("Oraknid was updated"), {
    description: t("This page is the version before: reload it to use the new one."),
    duration: Number.POSITIVE_INFINITY,
    action: { label: t("Reload"), onClick: () => location.reload() },
  });
}

let watching = false;

/** Started once by the app. */
export function watchFresh() {
  if (watching || typeof document === "undefined") return;
  watching = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void checkFresh();
  });
}
