import { z } from "zod";

// The visual check's judge (ADR-064 §5): a vision-capable model looks at
// the screenshots of a design or the running app, per device, and says of
// each experience criterion whether it holds, and why. Its prompt and its
// answer, shared by the Leg that reads the images and the local model.

/** One screenshot, as the judge is shown it. */
export interface ShotForJudge {
  device: string;
  page: string;
  /** Relative to the judge's working directory. */
  path: string;
  width: number;
  height: number;
  /** The page is wider than the device: it scrolls sideways. */
  overflow: boolean;
  /** Errors the page threw while it rendered. */
  errors: string[];
}

export const VisualVerdict = z.object({
  criterion: z.string().min(1),
  pass: z.boolean(),
  /** One sentence: what the screenshots show, naming the device when it differs. */
  reason: z.string().min(1),
});
export type VisualVerdict = z.infer<typeof VisualVerdict>;

export const VisualVerdicts = z.object({ verdicts: z.array(VisualVerdict).min(1) });
export type VisualVerdicts = z.infer<typeof VisualVerdicts>;

/** What every visual check asks when the spec gives no experience criteria. */
export const BASE_CRITERIA = [
  "Every screen renders real content: not blank, not an error page, nothing broken or overlapping.",
  "The layout fits each device: nothing is cut off or needs scrolling sideways, text is legible at that size.",
  "Controls are visible and large enough to use on each device (touch-sized on a phone).",
];

export interface VisualJudgeInput {
  jobId: string;
  cwd: string;
  /** What is being looked at: "the design" or "the running app". */
  target: string;
  criteria: string[];
  /** The spec's experience section, for context. */
  experience: string;
  shots: ShotForJudge[];
}

export function visualPrompt(i: VisualJudgeInput, attached: boolean): string {
  const shots = i.shots
    .map(
      (s, n) =>
        `${n + 1}. ${s.device} (${s.width}×${s.height}), ${s.page}${attached ? "" : `: \`${s.path}\``}${
          s.overflow ? " — the page is wider than the screen (it scrolls sideways)" : ""
        }${s.errors.length ? ` — errors while rendering: ${s.errors.slice(0, 3).join("; ").slice(0, 400)}` : ""}`,
    )
    .join("\n");
  return `You are checking ${i.target} of a product by looking at it, the way its owner will. ${
    attached
      ? "The screenshots are attached, in this order:"
      : "Open each screenshot below with your file-reading tool (they are PNG images in the workspace) and look at it carefully before answering:"
  }

${shots}
${i.experience ? `\n# The experience the owner asked for\n${i.experience.slice(0, 6000)}\n` : ""}
# The criteria
${i.criteria.map((c, n) => `${n + 1}. ${c}`).join("\n")}

For each criterion, in order, say whether the screenshots show it holds ("pass": true) or not, with one sentence of what you see, naming the device when it differs between them. Judge only what is visible; a criterion about sound or behaviour that a screenshot can't show passes when what it shows is consistent with it. Answer with "verdicts": one object per criterion, "criterion" copied word for word.`;
}

/** The judge's answer covers every criterion: problems in words, empty when it does. */
export function verdictProblems(criteria: string[], v: VisualVerdicts): string[] {
  const named = new Set(v.verdicts.map((x) => x.criterion.trim()));
  const missing = criteria.filter((c) => !named.has(c.trim()));
  return missing.length
    ? [`Give a verdict for every criterion, word for word; missing: ${missing.join(" | ")}`]
    : [];
}
