import { describe, expect, it } from "vitest";
import {
  completeAnswers,
  normalizeQuestions,
  renderAnswers,
  renderQuestions,
} from "./questions.ts";

// ADR-037: questions asked with options, answered one at a time.

const qs = normalizeQuestions([
  {
    id: "repo",
    shape: "single",
    prompt: "Which repository?",
    options: [
      { id: "new", label: "Create a new repo" },
      { id: "e1", label: "me/old-site" },
    ],
    recommended: "new",
  },
  {
    id: "extras",
    shape: "multi",
    prompt: "Which extras?",
    options: [
      { id: "ci", label: "CI" },
      { id: "pages", label: "Pages" },
    ],
  },
  { id: "go", shape: "confirm", prompt: "Push now?", recommended: "yes" },
  { id: "notes", shape: "text", prompt: "Anything else?", options: [{ id: "x", label: "x" }] },
  { id: "repo", shape: "single", prompt: "Empty choice", options: [] },
]);

describe("questions with options (ADR-037)", () => {
  it("gives a confirm question Yes and No, strips a text question's options, keeps ids unique", () => {
    expect(qs.map((q) => q.id)).toEqual(["repo", "extras", "go", "notes", "repo-5"]);
    expect(qs[2]?.options.map((o) => o.id)).toEqual(["yes", "no"]);
    expect(qs[2]?.recommended).toBe("yes");
    expect(qs[3]?.options).toEqual([]);
    // A choice with nothing to choose from is a free answer.
    expect(qs[4]?.shape).toBe("text");
  });

  it("drops a recommendation that names no option", () => {
    const [q] = normalizeQuestions([
      {
        id: "a",
        shape: "single",
        prompt: "?",
        options: [{ id: "x", label: "X" }],
        recommended: "y",
      },
    ]);
    expect(q?.recommended).toBeNull();
  });

  it("fills the recommended option where I said nothing, keeps the rest unanswered", () => {
    const answers = completeAnswers(qs, [
      { questionId: "extras", options: ["ci", "pages", "ci", "nope"], text: "" },
      { questionId: "notes", options: [], text: "  keep it small  " },
    ]);
    expect(answers).toEqual([
      { questionId: "repo", options: ["new"], text: "" },
      { questionId: "extras", options: ["ci", "pages"], text: "" },
      { questionId: "go", options: ["yes"], text: "" },
      { questionId: "notes", options: [], text: "keep it small" },
      { questionId: "repo-5", options: [], text: "" },
    ]);
    expect(renderAnswers(qs, answers)).toBe(
      [
        "- Which repository? — Create a new repo",
        "- Which extras? — CI, Pages",
        "- Push now? — Yes",
        "- Anything else? — keep it small",
        "- Empty choice — (unanswered)",
      ].join("\n"),
    );
  });

  it("keeps one option in a single choice, and a typed answer as Other", () => {
    const [a] = completeAnswers(qs, [
      { questionId: "repo", options: ["e1", "new"], text: "me/piano" },
    ]);
    expect(a).toEqual({ questionId: "repo", options: ["e1"], text: "me/piano" });
    expect(renderAnswers(qs.slice(0, 1), [a as never])).toBe(
      "- Which repository? — me/old-site, Other: me/piano",
    );
  });

  it("says the questions in words for a reader without the component", () => {
    expect(renderQuestions(qs.slice(0, 1))).toBe(
      "1. Which repository?\n   Create a new repo (recommended) · me/old-site",
    );
  });
});
