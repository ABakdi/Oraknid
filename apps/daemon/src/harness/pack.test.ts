import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SilkEntry } from "@oraknid/contracts";
import { buildContextPack, guidanceFromOthers, skillExcerpt } from "@oraknid/core";
import { describe, expect, it } from "vitest";
import { contextPackSized, PACK_TOKENS, SKILL_FILE } from "./pack.ts";
import type { AttemptDeps, AttemptJob, AttemptWhere, TaskRow } from "./types.ts";

// The context diet (ADR-066 §4), measured on a job like Keys: a long goal,
// the canon-driven method, an interview, a dozen decisions, facts, issues,
// earlier jobs' Silk and a long handoff from a session that didn't finish.

const SKILL = readFileSync(
  join(import.meta.dirname, "../../../../skills/canon-driven-development.md"),
  "utf8",
);

const GOAL = `Keys: a piano in the browser with a hardware-synth look.
${[
  "- Two octaves of keys you can play with the mouse, touch and the computer keyboard (A to K for the white keys, W E T Y U for the black ones).",
  "- A synth engine on Web Audio: oscillator type, an ADSR envelope, a low-pass filter with cutoff and resonance, a delay, a reverb, each a knob I can hear move.",
  "- Knobs that turn by dragging up and down, by the scroll wheel and by the keyboard, with their value shown while they move.",
  "- A phone layout: the keys fill the width, the knobs go in a drawer, nothing needs zooming.",
  "- Its own logo, drawn as an SVG, used as the favicon and in the header.",
  "- Presets: five sounds to start (piano, organ, pad, pluck, bass) and my own saved in the browser.",
  "- Tests for the engine and the keys, and a build that passes.",
].join("\n")}
The look: dark panel, brushed metal, orange accents, like a Korg or a Moog. It must feel instant: no click delay, no crackle.`;

let n = 0;
const entry = (over: Partial<SilkEntry>): SilkEntry => ({
  id: `01K0000000000000000000${String(n++).padStart(4, "0")}`,
  jobId: "J",
  taskId: null,
  kind: "decision",
  title: "t",
  body: "b",
  supersedes: null,
  covers: [],
  authoredBy: "eye",
  createdAt: n,
  ...over,
});
const para = (topic: string, k = 3) =>
  Array.from(
    { length: k },
    (_, i) =>
      `${topic}: the agent found that ${i === 0 ? "the AudioContext must start on a user gesture" : i === 1 ? "the filter's cutoff sounds best on a log scale from 40 Hz to 18 kHz" : "the knobs keep their value in the preset as a number from 0 to 1"}, and wrote it down with the file it lives in (src/audio/engine.ts, src/ui/knob.tsx).`,
  ).join(" ");

const ENTRIES: SilkEntry[] = [
  ...["audience", "keys", "sounds", "phone", "logo"].map((t) =>
    entry({
      kind: "interview-answer",
      title: `Interview: ${t}`,
      body: `I want ${t} done well: ${para(t, 1)}`,
      authoredBy: "owner",
    }),
  ),
  ...Array.from({ length: 12 }, (_, i) =>
    entry({ kind: "decision", title: `Decision ${i + 1}`, body: para(`decision ${i + 1}`) }),
  ),
  ...Array.from({ length: 5 }, (_, i) =>
    entry({
      kind: "architecture",
      title: `Architecture ${i + 1}`,
      body: para(`module ${i + 1}`, 4),
    }),
  ),
  ...Array.from({ length: 8 }, (_, i) =>
    entry({ kind: "fact", title: `Fact ${i + 1}`, body: para(`fact ${i + 1}`, 2) }),
  ),
  ...Array.from({ length: 4 }, (_, i) =>
    entry({ kind: "issue", title: `Issue ${i + 1}`, body: para(`src/audio issue ${i + 1}`, 2) }),
  ),
  entry({
    kind: "handoff",
    taskId: "T-engine",
    title: "Handoff: Build the synth engine",
    body: `## Goal of the task\nBuild the engine.\n## Done so far\n${para("done", 6)}\n## Current state\n${"Last verification: 3 of 11 tests failing in src/audio/engine.test.ts. ".repeat(40)}\n## Next steps\nFix the envelope's release.\n## Traps\nThe AudioContext needs a gesture.`,
  }),
];
const EARLIER: SilkEntry[] = Array.from({ length: 10 }, (_, i) =>
  entry({
    jobId: "E",
    kind: "decision",
    title: `Earlier ${i + 1}`,
    body: para(`earlier ${i + 1}`),
  }),
);

const TASK = {
  id: "T-engine",
  jobId: "J",
  title: "Build the synth engine",
  kind: "implement",
  instructions: `Build the Web Audio engine in src/audio: oscillators, the ADSR envelope, the filter, the delay and the reverb, each with a parameter a knob drives. Acceptance: the tests in src/audio pass, a note plays within 10 ms of a key press, no clicks at note start or end.`,
  scope: ["src/audio/**"],
  verify: ["pnpm test -- src/audio", "pnpm build"],
} as unknown as TaskRow;

describe("the context diet (ADR-066 §4)", () => {
  it("keeps the pack of a Keys-like task under ~4k tokens, and says where the rest is", () => {
    const cwd = mkdtempSync(join(tmpdir(), "oraknid-pack-"));
    const d = {
      silk: { all: () => ENTRIES, earlier: () => EARLIER },
    } as unknown as AttemptDeps;
    const job = {
      id: "J",
      goal: GOAL,
      skillBody: SKILL,
      otherSkills: [],
      inputs: "",
      serverJob: null,
    } as unknown as AttemptJob;
    const ws = { cwd, tree: { several: false } } as unknown as AttemptWhere;
    const after = contextPackSized(d, job, TASK, {
      contextWindow: 200_000,
      ws,
      toolRows: [],
      serversText: "",
    });
    // Before (v0.6.6): 15% of a 200k window, the skill's excerpt at 4,000 characters, Silk whole.
    const before = buildContextPack({
      task: { ...TASK, scope: TASK.scope, verify: TASK.verify } as never,
      goal: GOAL,
      skill: [
        skillExcerpt(SKILL, `${TASK.title} ${TASK.kind}`),
        guidanceFromOthers(SKILL, [], `${TASK.title} ${TASK.instructions}`),
      ]
        .filter(Boolean)
        .join("\n\n"),
      entries: ENTRIES,
      earlier: EARLIER,
      digest: "",
      capTokens: 30_000,
    });
    expect(after.pack).toBeLessThanOrEqual(PACK_TOKENS);
    expect(after.pack).toBeLessThan(before.tokens / 2);
    expect(after.size.silk).toBeLessThanOrEqual(1600);
    expect(after.size.handoff).toBeLessThanOrEqual(1250);
    // My words and the task stay whole; what was cut is named and readable.
    expect(after.text).toContain("I want logo done well");
    expect(after.text).toContain("Acceptance: the tests in src/audio pass");
    expect(after.text).toContain("are whole in .oraknid/silk/");
    expect(after.text).toContain(`The whole method is in \`${SKILL_FILE}\``);
    expect(existsSync(join(cwd, SKILL_FILE))).toBe(true);
    expect(readFileSync(join(cwd, SKILL_FILE), "utf8")).toBe(SKILL);
  });
});
