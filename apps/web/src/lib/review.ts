import type { Event, ReviewDevice, ReviewNote, ReviewNoteKind } from "@oraknid/contracts";
import { useEffect } from "react";
import { toast } from "sonner";
import { t } from "./i18n";
import { live } from "./live";
import { remote } from "./remote";
import { store } from "./store";

// The review page's pieces that aren't drawn (ADR-064, Web-UI → The review
// page): the devices, how the frame fits, the pins, and opening a review
// in a new tab when the daemon says one is ready.

/** The devices to look at it on; each turns to landscape and back. */
export const DEVICES: ReviewDevice[] = [
  { name: "Phone", width: 390, height: 844, orientation: "portrait" },
  { name: "Phone", width: 844, height: 390, orientation: "landscape" },
  { name: "Tablet", width: 820, height: 1180, orientation: "portrait" },
  { name: "Tablet", width: 1180, height: 820, orientation: "landscape" },
  { name: "Laptop", width: 1440, height: 900, orientation: "landscape" },
  { name: "Desktop", width: 1920, height: 1080, orientation: "landscape" },
];

/** A device's label: "Phone landscape 844×390". */
export function deviceLabel(d: ReviewDevice): string {
  const turned =
    (d.name === "Phone" || d.name === "Tablet") && d.orientation === "landscape"
      ? " landscape"
      : "";
  return `${t(d.name)}${turned} ${d.width}×${d.height}`;
}

/** The same device turned. */
export function turn(d: ReviewDevice): ReviewDevice {
  return {
    ...d,
    width: d.height,
    height: d.width,
    orientation: d.orientation === "portrait" ? "landscape" : "portrait",
  };
}

/** A size of my own; null when it isn't one a frame can take. */
export function customDevice(width: number, height: number): ReviewDevice | null {
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  if (width < 120 || height < 120 || width > 8000 || height > 8000) return null;
  return {
    name: "Custom",
    width,
    height,
    orientation: width > height ? "landscape" : "portrait",
  };
}

export const sameDevice = (a: ReviewDevice | null, b: ReviewDevice | null) =>
  !!a && !!b && a.name === b.name && a.width === b.width && a.height === b.height;

/** The device a review opens on: a phone on a phone, a laptop elsewhere. */
export function firstDevice(screenWidth: number): ReviewDevice {
  // biome-ignore lint/style/noNonNullAssertion: the list is fixed
  return screenWidth < 768 ? DEVICES[0]! : DEVICES[4]!;
}

/**
 * How much the frame is scaled to fit the stage (never above 1): the
 * device's whole size seen at once, less a margin.
 */
export function fitScale(
  device: Pick<ReviewDevice, "width" | "height">,
  stage: { width: number; height: number },
  margin = 24,
): number {
  if (stage.width <= 0 || stage.height <= 0) return 1;
  const s = Math.min(
    (stage.width - margin) / device.width,
    (stage.height - margin) / device.height,
    1,
  );
  return Math.max(0.05, Math.round(s * 1000) / 1000);
}

export interface Pin {
  id: string;
  n: number;
  selector: string;
  kind: ReviewNoteKind;
  text: string;
  active: boolean;
}

/**
 * The pins on the frame: the current round's notes on an element, written
 * on this device and this page, numbered as the notes list numbers them.
 */
export function pinsFor(
  notes: ReviewNote[],
  round: number,
  device: ReviewDevice,
  page: string | null,
  active: string | null,
): Pin[] {
  const current = notes.filter((n) => n.round === round);
  return current.flatMap((n, i) =>
    n.element && sameDevice(n.device, device) && (page === null || (n.page ?? "/") === page)
      ? [
          {
            id: n.id,
            n: i + 1,
            selector: n.element.selector,
            kind: n.kind,
            text: n.text.slice(0, 200),
            active: n.id === active,
          },
        ]
      : [],
  );
}

/** The notes grouped by the device they were written on (general ones last). */
export function byDevice(notes: ReviewNote[]): { label: string; notes: ReviewNote[] }[] {
  const groups = new Map<string, ReviewNote[]>();
  for (const n of notes) {
    const label = n.device ? deviceLabel(n.device) : t("Any device");
    groups.set(label, [...(groups.get(label) ?? []), n]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) =>
      a === t("Any device") ? 1 : b === t("Any device") ? -1 : a.localeCompare(b),
    )
    .map(([label, list]) => ({ label, notes: list }));
}

/** The message namespace the overlay speaks (apps/daemon/src/reviews/overlay.ts). */
export const OVERLAY_NS = "oraknid-review";

/** How recent a `review.opened` must be to open a tab: one replayed after a reconnect doesn't. */
const FRESH_MS = 60_000;

/** The review's page, as a link in this UI. */
export const reviewHref = (id: string) => `/review/${id}`;

/**
 * When a review opens (ADR-064 §2), this page opens it in a new tab: once
 * across my open tabs, only while it is fresh. A browser blocks a tab not
 * opened by a click: then a toast offers it, as the project's work bar and
 * the inbox do.
 */
export function useReviewOpener() {
  useEffect(() => {
    const off = live.subscribe(["inbox"]);
    const offEvents = live.on((e: Event) => {
      if (e.type !== "review.opened") return;
      const p = e.payload as { id?: string; kind?: string; url?: string } | null;
      if (!p?.id || Date.now() - e.at > FRESH_MS) return;
      const key = `review-opened.${p.id}.${e.seq}`;
      if (store.get(key)) return;
      store.set(key, "1");
      const href = reviewHref(p.id);
      const title =
        p.kind === "app"
          ? t("The app is ready for your review")
          : t("A design is ready for your review");
      // Away from home the UI is the loader's frame: the review opens in it, on a click.
      const tab = remote() ? null : window.open(href, `review-${p.id}`);
      if (tab) {
        toast.success(title, { description: t("Opened in a new tab.") });
        return;
      }
      toast(title, {
        duration: 30_000,
        action: {
          label: t("Open"),
          onClick: () => {
            if (remote()) location.hash = `#${href}`;
            else window.open(href, `review-${p.id}`);
          },
        },
      });
    });
    return () => {
      off();
      offEvents();
    };
  }, []);
}
