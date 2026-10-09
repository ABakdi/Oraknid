import { z } from "zod";

// Experience in the spec (ADR-064 §4): when the work has a UI, how it
// should feel, the layout on each device, its controls and references,
// and the experience acceptance criteria the visual check judges against
// (§5). Kept on the job; the spec's experience section is written from it.

/** The devices a design and the visual check know (ADR-064 §2). */
export const DeviceName = z.enum([
  "phone",
  "phone-landscape",
  "tablet",
  "tablet-landscape",
  "laptop",
  "desktop",
]);
export type DeviceName = z.infer<typeof DeviceName>;

/** Each device's viewport, CSS pixels (width × height). */
export const DEVICE_SIZES: Record<DeviceName, { width: number; height: number }> = {
  phone: { width: 390, height: 844 },
  "phone-landscape": { width: 844, height: 390 },
  tablet: { width: 820, height: 1180 },
  "tablet-landscape": { width: 1180, height: 820 },
  laptop: { width: 1366, height: 768 },
  desktop: { width: 1440, height: 900 },
};

export const Experience = z.object({
  /** How it should feel to use, in a sentence or two. */
  feel: z.string().max(2000).default(""),
  /** The layout on each device the work targets. */
  layouts: z
    .array(z.object({ device: z.string().min(1).max(40), layout: z.string().max(2000) }))
    .max(8)
    .default([]),
  /** The kinds of controls ("knobs and sliders, not number fields"). */
  controls: z.array(z.string().max(400)).max(20).default([]),
  /** Products, sites or styles to look at. */
  references: z.array(z.string().max(400)).max(20).default([]),
  /** Experience acceptance criteria: each one a thing a person can see in a screenshot. */
  criteria: z.array(z.string().min(1).max(400)).max(20).default([]),
});
export type Experience = z.infer<typeof Experience>;

/** The devices an experience names, known ones only, in order; none: phone and desktop. */
export function experienceDevices(e: Experience | null | undefined): DeviceName[] {
  const out: DeviceName[] = [];
  for (const l of e?.layouts ?? []) {
    const d = deviceOf(l.device);
    if (d && !out.includes(d)) out.push(d);
  }
  return out.length ? out : ["phone", "desktop"];
}

/** A device as people write it ("Phone (portrait)", "iPad", "desktop"), or null. */
export function deviceOf(words: string): DeviceName | null {
  const w = words.toLowerCase();
  const landscape = /landscape/.test(w);
  if (/phone|mobile|iphone|android/.test(w)) return landscape ? "phone-landscape" : "phone";
  if (/tablet|ipad/.test(w)) return landscape ? "tablet-landscape" : "tablet";
  if (/laptop|notebook/.test(w)) return "laptop";
  if (/desktop|computer|monitor|wide/.test(w)) return "desktop";
  return null;
}

/** The experience section as the spec and Silk show it. */
export function experienceMarkdown(e: Experience): string {
  const list = (xs: string[]) => xs.map((x) => `- ${x}`).join("\n");
  return [
    e.feel ? `**Feel**\n${e.feel}` : "",
    e.layouts.length
      ? `**Layout per device**\n${e.layouts.map((l) => `- ${l.device}: ${l.layout}`).join("\n")}`
      : "",
    e.controls.length ? `**Controls**\n${list(e.controls)}` : "",
    e.references.length ? `**References**\n${list(e.references)}` : "",
    e.criteria.length ? `**Experience acceptance criteria**\n${list(e.criteria)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
