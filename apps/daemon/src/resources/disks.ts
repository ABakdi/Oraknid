import { statfsSync, statSync } from "node:fs";

/**
 * Free space on each place's disk, each disk once (by device), named by
 * the first place on it. A place that can't be read is left out.
 */
export function diskSpace(
  places: { label: string; path: string }[],
): { label: string; freeBytes: number; totalBytes: number }[] {
  const seen = new Set<number>();
  const out: { label: string; freeBytes: number; totalBytes: number }[] = [];
  for (const p of places) {
    try {
      const dev = statSync(p.path).dev;
      if (seen.has(dev)) continue;
      seen.add(dev);
      const fs = statfsSync(p.path);
      out.push({
        label: p.label,
        freeBytes: Number(fs.bavail) * Number(fs.bsize),
        totalBytes: Number(fs.blocks) * Number(fs.bsize),
      });
    } catch {}
  }
  return out;
}
