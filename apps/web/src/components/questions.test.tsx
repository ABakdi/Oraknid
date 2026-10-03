import { normalizeQuestions, type QuestionAnswer } from "@oraknid/contracts";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuestionsForm } from "./questions";

// ADR-037: questions in tabs, a summary last, answered by keyboard or touch.

afterEach(cleanup);

const questions = normalizeQuestions([
  {
    id: "repo",
    shape: "single",
    prompt: "Which repository?",
    options: [
      { id: "new", label: "Create a new repo", detail: "Oraknid creates it" },
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
      { id: "wiki", label: "Wiki" },
    ],
  },
  { id: "notes", shape: "text", prompt: "Anything else?" },
]);

function setup() {
  const sent: QuestionAnswer[][] = [];
  render(<QuestionsForm questions={questions} onSubmit={(a) => void sent.push(a)} />);
  const form = screen.getByTestId("questions");
  const key = (key: string, o: { shiftKey?: boolean } = {}) =>
    act(() => {
      fireEvent.keyDown(document.activeElement ?? form, { key, ...o });
    });
  const tab = (name: RegExp) => screen.getByRole("tab", { name });
  return { sent, form, key, tab };
}

describe("questions with options (ADR-037)", () => {
  it("marks the recommended option and selects it first", () => {
    setup();
    const rec = screen.getByRole("radio", { name: /Create a new repo/ });
    expect(rec.getAttribute("aria-checked")).toBe("true");
    expect(rec.textContent).toContain("Recommended");
    expect(screen.getByRole("radio", { name: /me\/old-site/ }).getAttribute("aria-checked")).toBe(
      "false",
    );
    // A Tab into the form lands on it.
    expect(rec.getAttribute("tabindex")).toBe("0");
  });

  it("moves with ↑/↓, selects with Space, and goes on with Enter", () => {
    const { key, tab } = setup();
    act(() => screen.getByRole("radio", { name: /Create a new repo/ }).focus());
    key("ArrowDown");
    const old = screen.getByRole("radio", { name: /me\/old-site/ });
    expect(document.activeElement).toBe(old);
    key(" ");
    expect(old.getAttribute("aria-checked")).toBe("true");
    expect(
      screen.getByRole("radio", { name: /Create a new repo/ }).getAttribute("aria-checked"),
    ).toBe("false");
    // ↓ past the last option reaches "Other", then wraps to the first.
    key("ArrowDown");
    expect(document.activeElement).toBe(screen.getByLabelText("Other answer"));
    key("ArrowDown");
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: /Create a new repo/ }));
    key("ArrowUp");
    key("ArrowUp");
    key("Enter");
    expect(tab(/Which extras/).getAttribute("aria-selected")).toBe("true");
    expect(tab(/Which repository/).textContent).toMatch(/^1/);
  });

  it("toggles in a multi with Space and the numbers, and moves between questions with ←/→ and Tab", () => {
    const { key, tab } = setup();
    act(() => screen.getByRole("radio", { name: /Create a new repo/ }).focus());
    key("ArrowRight");
    expect(tab(/Which extras/).getAttribute("aria-selected")).toBe("true");
    key("1");
    key("3");
    expect(screen.getByRole("checkbox", { name: /CI/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("checkbox", { name: /Wiki/ }).getAttribute("aria-checked")).toBe(
      "true",
    );
    key(" "); // on Wiki, where 3 put the focus: toggled off
    expect(screen.getByRole("checkbox", { name: /Wiki/ }).getAttribute("aria-checked")).toBe(
      "false",
    );
    key("ArrowLeft");
    expect(tab(/Which repository/).getAttribute("aria-selected")).toBe("true");
    key("Tab");
    expect(tab(/Which extras/).getAttribute("aria-selected")).toBe("true");
    key("Tab", { shiftKey: true });
    expect(tab(/Which repository/).getAttribute("aria-selected")).toBe("true");
  });

  it("writes a free answer with Shift+Enter for a new line, and sends everything from the summary", () => {
    const { key, tab, sent } = setup();
    act(() => tab(/Anything else/).click());
    const box = screen.getByRole("textbox", { name: "Anything else?" });
    expect(document.activeElement).toBe(box);
    fireEvent.change(box, { target: { value: "keep it small" } });
    key("Enter", { shiftKey: true });
    expect(tab(/Anything else/).getAttribute("aria-selected")).toBe("true");
    key("Enter");
    expect(tab(/Summary/).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Create a new repo")).toBeTruthy();
    expect(screen.getByText("(unanswered)")).toBeTruthy();
    key("Enter");
    // The recommended option where I chose nothing, the multi left unanswered, my words.
    expect(sent).toEqual([
      [
        { questionId: "repo", options: ["new"], text: "" },
        { questionId: "extras", options: [], text: "" },
        { questionId: "notes", options: [], text: "keep it small" },
      ],
    ]);
  });

  it("takes a typed answer as Other instead of an option, and keeps its keys from the page", () => {
    const { key, sent } = setup();
    const page = vi.fn();
    window.addEventListener("keydown", page);
    try {
      act(() => screen.getByRole("radio", { name: /Create a new repo/ }).focus());
      key("2");
      key("ArrowRight");
      key("ArrowLeft");
      // Number and arrow keys answer the questions; the page's own shortcuts never see them.
      expect(page).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", page);
    }
    const other = screen.getByLabelText("Other answer");
    act(() => other.focus());
    fireEvent.change(other, { target: { value: "me/piano" } });
    expect(screen.getByRole("radio", { name: /me\/old-site/ }).getAttribute("aria-checked")).toBe(
      "false",
    );
    act(() => screen.getByRole("button", { name: "Submit" }).click());
    expect(sent[0]?.[0]).toEqual({ questionId: "repo", options: [], text: "me/piano" });
  });

  it("has rows big enough for a thumb", () => {
    setup();
    for (const r of screen.getAllByRole("radio")) expect(r.className).toContain("min-h-11");
    expect(screen.getByRole("tab", { name: /Summary/ }).className).toContain(
      "pointer-coarse:min-h-11",
    );
  });
});
