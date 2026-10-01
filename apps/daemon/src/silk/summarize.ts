import type { SilkEntry, SilkKind } from "@oraknid/contracts";
import type { EyeBrain } from "../eye/brain.ts";
import type { SilkStore } from "./store.ts";

// Shortened entries are summarised (Silk → Context pack): when a context
// pack has to cut entries to their titles, a cheap Leg writes one entry
// per kind that replaces them, so the next pack has room for the whole
// meaning again. My entries are never summarised, nor handoffs or my
// interview answers.

const SUMMARISABLE = new Set<SilkKind>(["decision", "architecture", "progress", "issue", "fact"]);
const inFlight = new Set<string>();

export async function summarizeShortened(
  d: { silk: SilkStore; brain?: EyeBrain },
  jobId: string,
  cwd: string,
  shortened: string[],
): Promise<SilkEntry[]> {
  if (!d.brain || shortened.length < 2) return [];
  const live = new Set(d.silk.current(jobId).map((e) => e.id));
  const groups = new Map<SilkKind, SilkEntry[]>();
  for (const id of shortened) {
    const e = d.silk.get(id);
    if (!e || !live.has(id) || e.authoredBy === "owner" || !SUMMARISABLE.has(e.kind)) continue;
    groups.set(e.kind, [...(groups.get(e.kind) ?? []), e]);
  }
  const made: SilkEntry[] = [];
  for (const [kind, entries] of groups) {
    if (entries.length < 2) continue;
    const key = `${jobId}:${kind}`;
    if (inFlight.has(key)) continue;
    inFlight.add(key);
    try {
      const summary = await d.brain.summarize({ jobId, cwd, entries });
      // Some may have been replaced while the summary was written.
      const still = new Set(d.silk.current(jobId).map((e) => e.id));
      const covers = entries.map((e) => e.id).filter((id) => still.has(id));
      if (covers.length < 2) continue;
      made.push(
        d.silk.add({
          jobId,
          kind,
          title: summary.title,
          body: `${summary.body.trim()}\n\n_Summary of ${covers.length} entries._`,
          authoredBy: "eye",
          covers,
        }),
      );
    } catch (error) {
      // A failed summary only means the pack stays shortened.
      console.error("silk summary failed", error);
    } finally {
      inFlight.delete(key);
    }
  }
  return made;
}
