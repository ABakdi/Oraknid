/**
 * `g` then a key (Web-UI → Keyboard). The key after `g` belongs to `g`:
 * it is swallowed before any page's own shortcuts see it, so `g r` on
 * Mail goes to Repos without replying, and `g c` without writing.
 * Listen in the capture phase on window, which runs before every page's
 * own listener.
 */

/** Keys that are only a modifier being pressed: they don't end the prefix. */
const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "AltGraph"]);

/** How long `g` waits for its key. */
export const GO_WAIT = 1500;

export function goPrefix(
  targets: Record<string, string>,
  go: (to: string) => void,
  typing: (e: KeyboardEvent) => boolean,
  now: () => number = Date.now,
) {
  let at = 0;
  return (e: KeyboardEvent) => {
    if (MODIFIERS.has(e.key)) return;
    if (e.metaKey || e.ctrlKey || e.altKey || typing(e)) {
      at = 0;
      return;
    }
    if (at && now() - at < GO_WAIT) {
      at = 0;
      // The key after `g` is `g`'s, known or not: no page sees it.
      e.preventDefault();
      e.stopImmediatePropagation();
      const to = targets[e.key];
      if (to) go(to);
      return;
    }
    at = e.key === "g" ? now() : 0;
  };
}
