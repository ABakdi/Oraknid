import { useLocation } from "wouter";

/**
 * How far into this app's own history the current entry is (Web-UI →
 * Going back): every in-app push counts one, a replace keeps the count, and
 * going back reads it from the entry. A back control uses the browser's
 * history when there is some of mine, and a sensible parent otherwise (a
 * link opened in a new tab, a reload of a deep address).
 */
let depth = 0;

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

const stamp = (state: unknown, d: number) =>
  isRecord(state) ? { ...state, oraknidDepth: d } : state == null ? { oraknidDepth: d } : state;

const read = () => {
  const s: unknown = typeof history === "undefined" ? null : history.state;
  return isRecord(s) && typeof s.oraknidDepth === "number" ? s.oraknidDepth : 0;
};

const patched = Symbol.for("oraknid.nav");
if (typeof window !== "undefined" && !(window as unknown as Record<symbol, boolean>)[patched]) {
  (window as unknown as Record<symbol, boolean>)[patched] = true;
  depth = read();
  const push = history.pushState;
  const replace = history.replaceState;
  history.pushState = function (state: unknown, title: string, url?: string | URL | null) {
    depth += 1;
    return push.call(this, stamp(state, depth), title, url);
  };
  history.replaceState = function (state: unknown, title: string, url?: string | URL | null) {
    return replace.call(this, stamp(state, depth), title, url);
  };
  window.addEventListener("popstate", () => {
    depth = read();
  });
}

/** True when going back stays in this app. */
export const canGoBack = () => depth > 0;

/** Back where I came from, or to `fallback` when I arrived here directly. */
export function useBack(fallback: string) {
  const [, go] = useLocation();
  return () => {
    if (canGoBack()) history.back();
    else go(fallback, { replace: true });
  };
}

/** Marks a navigation as a drill-down from another page, so the target shows a way back. */
export const FROM_PAGE = { from: "page" } as const;
export const cameFromPage = () => isRecord(history.state) && history.state.from === "page";
