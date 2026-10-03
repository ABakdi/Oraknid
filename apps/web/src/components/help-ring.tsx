import { useEffect, useState, useSyncExternalStore } from "react";
import { useLocation } from "wouter";
import { rings } from "@/lib/helper-show";

/**
 * The ring the helper draws around a control it points at (ADR-041): it
 * follows the control as the page scrolls, pulses (still, when I prefer
 * less motion), carries a short note, and is gone once I click anywhere,
 * press Esc or move to another page.
 */
export function HelpRing() {
  const ring = useSyncExternalStore(rings.subscribe, rings.get, rings.get);
  const [location] = useLocation();
  const [box, setBox] = useState<DOMRect | null>(null);

  useEffect(() => {
    if (ring && location !== ring.at) rings.set(null);
  }, [location, ring]);

  useEffect(() => {
    if (!ring) {
      setBox(null);
      return;
    }
    let frame = 0;
    const follow = () => {
      if (!ring.el.isConnected) {
        rings.set(null);
        return;
      }
      const r = ring.el.getBoundingClientRect();
      setBox((b) =>
        b && b.x === r.x && b.y === r.y && b.width === r.width && b.height === r.height ? b : r,
      );
      frame = requestAnimationFrame(follow);
    };
    follow();
    // The control still gets my click: the ring only listens, and goes.
    const gone = () => rings.set(null);
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") gone();
    };
    // Later than the click that showed it.
    const t = setTimeout(() => {
      window.addEventListener("pointerdown", gone, true);
      window.addEventListener("keydown", key);
    }, 0);
    return () => {
      clearTimeout(t);
      cancelAnimationFrame(frame);
      window.removeEventListener("pointerdown", gone, true);
      window.removeEventListener("keydown", key);
    };
  }, [ring]);

  if (!ring || !box) return null;
  const pad = 6;
  const below = box.bottom + 64 < window.innerHeight;
  return (
    <div aria-live="polite" className="pointer-events-none fixed inset-0 z-[60]">
      <div
        data-help-ring
        className="absolute rounded-lg outline-[3px] outline-eye outline-solid shadow-[0_0_0_9999px_color-mix(in_srgb,black_22%,transparent)] motion-safe:animate-[help-pulse_1.4s_ease-in-out_infinite]"
        style={{
          left: box.left - pad,
          top: box.top - pad,
          width: box.width + pad * 2,
          height: box.height + pad * 2,
        }}
      />
      {ring.note ? (
        <div
          role="status"
          className="absolute max-w-72 rounded-md border bg-popover px-2.5 py-1.5 text-sm text-popover-foreground shadow-lg"
          style={{
            left: Math.max(8, Math.min(box.left, window.innerWidth - 296)),
            ...(below
              ? { top: box.bottom + pad + 8 }
              : { bottom: window.innerHeight - box.top + pad + 8 }),
          }}
        >
          {ring.note}
        </div>
      ) : null}
    </div>
  );
}
