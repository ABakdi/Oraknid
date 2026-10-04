import { describe, expect, it } from "vitest";
import { endsInterview, freshQuestions, sameMeaning } from "./likeness.ts";

// The piano job's interview (2026-10-04): what it asked again, in its own words.
describe("telling the same question from a new one", () => {
  it("catches a question asked again in other words, and keeps a new one", () => {
    expect(
      sameMeaning(
        "To guide the design skill further for a 'Modern electro' music app (dark default, light available, not default shadcn), are there any specific mood words, colors, vibe, or inspiration you'd like to pass along? If not, just type 'none'.",
        "To guide the design skill (Modern electro, music app, dark default, light available, not default shadcn, lively and vibrant), what mood words, colors, vibe, or inspiration should we pass? If none, type 'none'.",
      ),
    ).toBe(true);
    expect(
      sameMeaning(
        "Is the build order you described correct for MVP: phase 1 = keyboard + presets + oscilloscope (with volume/phase), phase 2 = sound synthesis, phase 3 = recording (notes+timing) + saving local presets?",
        "Recording is specified as notes and timing. Is there anything else you want captured in MVP recording?",
      ),
    ).toBe(false);
    expect(
      sameMeaning(
        "Who is this for — only you, or other people too?",
        "Where do the sounds come from, and how do people get them?",
      ),
    ).toBe(false);
  });

  it("drops what was asked, by meaning or by a telling id, and keeps at most five", () => {
    const asked = [
      {
        id: "q1",
        prompt: "Any specific open-source sample packs you'd like as the bundled starter set?",
      },
      { id: "audio_impl", prompt: "How should audio be implemented?" },
    ];
    const next = [
      {
        id: "q2",
        prompt:
          "For the bundled starter sound set, are there any specific open-source sample packs you'd like?",
      },
      { id: "audio_impl", prompt: "Which direction for the audio research?" },
      { id: "q1", prompt: "How many keys on a phone?" },
      { id: "q4", prompt: "How many keys should the keyboard show on a phone?" },
      ...["Which licence?", "Which logo?", "Which font?", "Which hosting?", "Which domain?"].map(
        (prompt, i) => ({ id: `x${i}`, prompt }),
      ),
    ];
    const { fresh, dropped } = freshQuestions(next, asked, 5);
    expect(fresh.map((q) => q.prompt)).toEqual([
      "How many keys on a phone?",
      "Which licence?",
      "Which logo?",
      "Which font?",
      "Which hosting?",
    ]);
    expect(dropped.map((q) => q.id)).toEqual(["q2", "audio_impl", "q4", "x4"]);
  });
});

describe("ending the interview in my words", () => {
  it("hears 'enough', 'start now', 'that's all', and not a long answer that says 'start'", () => {
    for (const yes of [
      "Enough, start",
      "start now interview is over",
      "I have already answered all your questions interview is over start now",
      "That's all",
      "enough",
      "no more questions, just build it",
    ])
      expect(endsInterview(yes), yes).toBe(true);
    for (const no of [
      "they open the app and can start playing at once by tapping the keyboard",
      "Me, by hand.",
      "use the skill, but mention it's a music app",
      "Yes",
    ])
      expect(endsInterview(no), no).toBe(false);
  });
});
