import { control, itemOf, pathOf } from "@/lib/help-map";

/**
 * What the helper shows me, run here in the browser (ADR-041): a page
 * (`navigate`), a control with a pulsing ring and a short note
 * (`highlight`), a value put in a field without saving (`fill`). A control
 * inside a closed menu, dialog, drawer or <details> is opened to first.
 */

export interface Shown {
  ok: boolean;
  /** Why not, in words. */
  why?: string;
  /**
   * The control is in a modal dialog (or a drawer): while it is open, the
   * rest of the page, the helper's panel too, can't be clicked or typed in.
   */
  modal?: boolean;
}

/** A modal dialog or drawer holding the control, if one does. */
export const modalOf = (el: Element): HTMLElement | null =>
  el.closest<HTMLElement>(
    '[data-slot="dialog-content"],[data-slot="sheet-content"],[role="alertdialog"],[role="dialog"][aria-modal="true"]',
  );

/** Whether a modal dialog or drawer is open now. */
export const modalOpen = () =>
  !!document.querySelector(
    '[data-slot="dialog-content"],[data-slot="sheet-content"],[role="alertdialog"],[role="dialog"][aria-modal="true"]',
  );

/** Said under the ring when the helper must wait for a dialog to close. */
export const DIALOG_NOTE = "Close this dialog to get back to the helper.";

export interface ShowDeps {
  /** Where I am now. */
  location: () => string;
  go: (to: string) => void;
  /** How long to wait for a page or a menu to show the control. */
  timeoutMs?: number;
}

// The ring: one at a time, drawn by <HelpRing />, gone on a click or a new page.
export interface Ring {
  el: HTMLElement;
  note: string | null;
  /** The page it was shown on: leaving it removes the ring. */
  at: string;
}
let ring: Ring | null = null;
const listeners = new Set<() => void>();
export const rings = {
  get: () => ring,
  set(r: Ring | null) {
    ring = r;
    for (const l of listeners) l();
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
};

/** "Ask the helper about this" on a guide page: the helper opens with it as context. */
export interface Ask {
  /** The guide page's slug. */
  about: string;
  title: string;
}
const askers = new Set<(a: Ask) => void>();
export const askHelper = (a: Ask) => {
  for (const l of askers) l(a);
};
export const onAsk = (l: (a: Ask) => void) => {
  askers.add(l);
  return () => {
    askers.delete(l);
  };
};

const visible = (el: Element): el is HTMLElement => {
  if (!(el instanceof HTMLElement) || !el.isConnected) return false;
  if (typeof el.checkVisibility === "function") return el.checkVisibility();
  return !el.closest("[hidden]");
};

/** The control on screen now, if it is. */
export function findHelp(id: string): HTMLElement | null {
  // Ids are words, dots and dashes: nothing to escape in the selector.
  if (!/^[\w.-]+$/.test(id)) return null;
  const all = document.querySelectorAll(`[data-help="${id}"]`);
  for (const el of all) if (visible(el)) return el;
  return null;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A click as a hand makes it: menus (Radix) open on the pointer going down. */
function press(el: HTMLElement) {
  const opts = { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" } as const;
  const P = typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
  el.dispatchEvent(new P("pointerdown", opts));
  el.dispatchEvent(new MouseEvent("mousedown", opts));
  el.dispatchEvent(new P("pointerup", opts));
  el.dispatchEvent(new MouseEvent("mouseup", opts));
  el.click();
}

/**
 * Waits for the control to be on screen, opening what holds it on the way:
 * the last step of `via` that is on screen and not yet opened, each tick.
 */
async function reveal(id: string, via: string[], ms: number): Promise<HTMLElement | null> {
  const opened = new Set<string>();
  const end = Date.now() + ms;
  for (;;) {
    const el = findHelp(id);
    if (el) return el;
    if (Date.now() > end) return null;
    let stepped = false;
    for (let i = via.length - 1; i >= 0; i--) {
      const v = via[i] as string;
      if (opened.has(v)) continue;
      const step = findHelp(v);
      if (!step) continue;
      opened.add(v);
      press(step);
      stepped = true;
      break;
    }
    await wait(stepped ? 150 : 60);
  }
}

const reduced = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** A field's value set as if typed, so the page's own state follows. Nothing is saved. */
function setValue(el: HTMLElement, value: string): boolean {
  const field =
    el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
      ? el
      : el.querySelector<HTMLInputElement | HTMLTextAreaElement>(
          "input:not([type=hidden]), textarea",
        );
  if (!field) return false;
  const proto =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
  field.dispatchEvent(new Event("change", { bubbles: true }));
  field.focus({ preventScroll: true });
  return true;
}

export async function show(
  action: { name: string; input: Record<string, unknown> },
  d: ShowDeps,
): Promise<Shown> {
  const str = (k: string) =>
    typeof action.input[k] === "string" ? (action.input[k] as string) : undefined;
  if (action.name === "navigate") {
    const page = str("page") ?? "";
    const path = pathOf(page, str("item"), str("tab"));
    if (!path) return { ok: false, why: `There is no page "${page}".` };
    if (d.location() !== path) d.go(path);
    return { ok: true };
  }
  if (action.name !== "highlight" && action.name !== "fill")
    return { ok: false, why: `"${action.name}" isn't shown here.` };
  const id = str("id") ?? "";
  const c = control(id);
  if (!c) return { ok: false, why: `Nothing on the screens is called "${id}".` };
  // On screen already (Settings → Connections holds the mail options too): point at it here.
  let el = findHelp(id);
  if (!el && c.page) {
    const item = str("item") ?? itemOf(c.page, d.location());
    if (c.needsItem && !item) return { ok: false, why: `Open the ${c.page} first: which one?` };
    const path = pathOf(c.page, item, c.tab);
    if (!path) return { ok: false, why: `There is no page "${c.page}".` };
    const here = d.location();
    if (here !== path && !(c.tab === undefined && here.startsWith(`${path}/`))) d.go(path);
  }
  el ??= await reveal(id, c.via ?? [], d.timeoutMs ?? 5000);
  if (!el) return { ok: false, why: `"${c.name}" isn't on the screen now.` };
  // A control folded away in <details> is unfolded.
  for (let p = el.parentElement; p; p = p.parentElement)
    if (p instanceof HTMLDetailsElement && !p.open) p.open = true;
  el.scrollIntoView?.({
    block: "center",
    inline: "nearest",
    behavior: reduced() ? "auto" : "smooth",
  });
  if (action.name === "fill") {
    const value = str("value") ?? "";
    if (!setValue(el, value)) return { ok: false, why: `"${c.name}" isn't a field.` };
  }
  const modal = !!modalOf(el);
  const note = str("note") ?? (action.name === "fill" ? "Filled in: check it, then save." : c.name);
  rings.set({ el, note: modal ? `${note} ${DIALOG_NOTE}` : note, at: d.location() });
  return modal ? { ok: true, modal } : { ok: true };
}
