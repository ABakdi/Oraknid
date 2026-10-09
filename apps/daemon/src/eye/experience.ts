import { Experience, experienceDevices, experienceMarkdown } from "@oraknid/contracts";
import type { Db } from "../db/open.ts";
import { readSetting, writeSetting } from "../settings.ts";
import type { SilkStore } from "../silk/store.ts";

// Experience in the spec (ADR-064 §4): when the work has a UI, the
// interview asks for an experience section (or proposes one from the goal).
// The latest one is kept on the job, for the visual check's criteria (§5),
// and in Silk as "Experience", which the plan reads with the other
// decisions: its experience acceptance criteria become the UI tasks'.

export const EXPERIENCE_TITLE = "Experience";
export const experienceKey = (jobId: string) => `job.experience.${jobId}`;

/** What the interview asks of work with a UI. */
export const EXPERIENCE_ASK = `# The experience section (this work has a UI)
The spec needs an experience section: how it should feel to use, the layout on each device it targets (phone portrait or landscape, tablet, laptop, desktop), the kinds of controls (an instrument has knobs, faders and pads, not number fields and dropdowns), and references (products or styles to look at). Where the owner hasn't said and it changes the design, ask it among this round's questions (one or two at most, with options); propose the rest yourself from the goal, as assumptions. In every round, give "experience" as it stands: "feel", "layouts" (one {"device", "layout"} per device), "controls", "references", and "criteria": 3 to 8 experience acceptance criteria, each one a thing a person can see in a screenshot on a named device ("On the phone, the keyboard spans the width and every knob is at least 44 px"). They are checked by looking at the design and the built app.`;

/** The job's experience section, or null when its work has none (yet). */
export function readExperience(db: Db, jobId: string): Experience | null {
  return readSetting(db, experienceKey(jobId), Experience.nullable(), null);
}

/**
 * Keeps the experience a round gave: on the job, and in Silk (a new
 * version supersedes the last), with what the plan must do with it.
 * Nothing when it is empty or unchanged.
 */
export function keepExperience(
  db: Db,
  silk: SilkStore,
  jobId: string,
  given: Experience | null | undefined,
): boolean {
  if (!given) return false;
  const e = Experience.parse(given);
  if (!e.feel && !e.layouts.length && !e.controls.length && !e.criteria.length) return false;
  const before = readExperience(db, jobId);
  if (before && JSON.stringify(before) === JSON.stringify(e)) return false;
  writeSetting(db, experienceKey(jobId), Experience.nullable(), e);
  const last = silk
    .current(jobId)
    .filter((x) => x.kind === "decision" && x.title === EXPERIENCE_TITLE && x.authoredBy === "eye")
    .at(-1);
  const devices = experienceDevices(e).join(",");
  silk.add({
    jobId,
    kind: "decision",
    title: EXPERIENCE_TITLE,
    body: `${experienceMarkdown(e)}\n\n**For the plan:** the spec's experience section is this one. Work I will see starts with a design (the ui-design skill) built to it, and every task that builds a screen includes in its acceptance criteria the experience criteria it touches; its checks may add Oraknid's visual check, \`oraknid visual-check --target design --devices ${devices}\` (or \`--target app --url http://localhost:<port>/\` once the app runs), which looks at it on these devices against these criteria.`,
    authoredBy: "eye",
    ...(last ? { supersedes: last.id } : {}),
  });
  return true;
}
