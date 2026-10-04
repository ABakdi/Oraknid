import type { CloudKind, CloudPlacement } from "@oraknid/contracts";

// Where an upload goes in the pool (ADR-046): one provider, never split.
// Automatic placement uses only providers that can say how much room they
// have (their own figure, a limit I set, or pay as you go); one that
// can't is used only when I pick it.

export interface PlaceCandidate {
  id: string;
  name: string;
  kind: CloudKind;
  /** Object storage (buckets): what "by size" sends large files to; s3 when not said. */
  object?: boolean;
  /** Bytes free; null: unknown; Infinity: pay as you go. */
  free: number | null;
  priority: number;
  /** The last check failed: not a place for new files until it answers again. */
  broken?: boolean;
}

export type Placed = { ok: true; id: string } | { ok: false; reason: string };

/** Bytes in words, as the pages show them. */
export function bytesText(n: number): string {
  if (!Number.isFinite(n)) return "no limit";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let v = n;
  let u = 0;
  while (v >= 1000 && u < units.length - 1) {
    v /= 1000;
    u++;
  }
  return `${u === 0 ? v : v.toFixed(v >= 10 ? 0 : 1)} ${units[u]}`;
}

const isObject = (c: PlaceCandidate) => c.object ?? c.kind === "s3";

/** Most free first, then the priority order. */
const byFree = (a: PlaceCandidate, b: PlaceCandidate) =>
  (b.free ?? 0) - (a.free ?? 0) || a.priority - b.priority;
const byPriority = (a: PlaceCandidate, b: PlaceCandidate) => a.priority - b.priority;

export function choosePlace(
  candidates: PlaceCandidate[],
  size: number,
  placement: CloudPlacement,
  /** A provider picked for this one file, over the setting. */
  pick?: string | null,
): Placed {
  if (candidates.length === 0)
    return { ok: false, reason: "There is no cloud storage yet: add a provider first." };
  const picked = pick ?? (placement.mode === "provider" ? placement.providerId : null);
  if (picked) {
    const c = candidates.find((x) => x.id === picked);
    if (!c) return { ok: false, reason: "That provider isn't here any more." };
    if (c.free !== null && c.free < size)
      return {
        ok: false,
        reason: `It doesn't fit in ${c.name}: ${bytesText(size)}, ${bytesText(c.free)} free.`,
      };
    return { ok: true, id: c.id };
  }
  const known = candidates.filter((c) => c.free !== null && !c.broken);
  if (known.length === 0)
    return {
      ok: false,
      reason:
        "No provider can say how much room it has: pick one for this file, or give object storage a space limit.",
    };
  const fits = known.filter((c) => (c.free as number) >= size);
  if (fits.length === 0) {
    const best = [...known].sort(byFree)[0] as PlaceCandidate;
    return {
      ok: false,
      reason: `Too big for any one place: ${bytesText(size)}, and the most room is ${bytesText(best.free as number)} in ${best.name}. A file is never split across providers.`,
    };
  }
  let order: PlaceCandidate[];
  if (placement.rule === "priority") order = [...fits].sort(byPriority);
  else if (placement.rule === "size") {
    const large = size >= placement.largeFromBytes;
    const first = fits.filter((c) => isObject(c) === large).sort(byFree);
    const then = fits.filter((c) => isObject(c) !== large).sort(byFree);
    order = [...first, ...then];
  } else order = [...fits].sort(byFree);
  return { ok: true, id: (order[0] as PlaceCandidate).id };
}
