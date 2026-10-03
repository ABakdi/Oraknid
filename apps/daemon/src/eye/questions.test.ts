import { choiceQuestion, chosenOption, completeAnswers } from "@oraknid/contracts";
import { describe, expect, it } from "vitest";
import { keepsGoingWrong, readKeepsGoingWrong } from "./questions.ts";

// ADR-045: every question says what each answer does.

const asked = (o: { others?: { id: string; name: string }[]; dropped?: string[] } = {}) =>
  keepsGoingWrong({
    task: "Write hello.sh",
    leg: "Claude A · opus",
    evidence: "changed files outside its scope",
    escalations: ["D1:correct"],
    others: o.others ?? [],
    dropped: o.dropped ?? [],
    folder: "/p/.oraknid/worktrees/j",
    branch: "oraknid/hello-abc123",
  });

describe("“keeps going wrong”, in plain words", () => {
  it("offers what each answer does, the dependent tasks listed, another Leg only when there is one", () => {
    const one = asked({ dropped: ["Test hello.sh", "Ship it"] });
    const what = one.questions[0];
    expect(what?.options.map((o) => o.label)).toEqual([
      "Try again with my advice",
      "I'll do it myself",
      "Leave it out",
      "Stop the job",
    ]);
    expect(what?.options.every((o) => o.detail)).toBe(true);
    expect(what?.options.find((o) => o.id === "leave-out")?.detail).toBe(
      "The task is dropped and the job goes on without it. The tasks that need it are left out too: “Test hello.sh”, “Ship it”.",
    );
    expect(what?.options.find((o) => o.id === "mine")?.detail).toContain("/p/.oraknid/worktrees/j");
    expect(what?.options.find((o) => o.id === "stop")?.detail).toContain(
      "stays on its branch oraknid/hello-abc123",
    );
    expect(one.questions.map((q) => q.id)).toEqual(["what", "advice"]);
    const two = asked({ others: [{ id: "leg-b", name: "Claude B" }] });
    expect(two.questions.map((q) => q.id)).toEqual(["what", "advice", "leg"]);
    expect(two.questions[0]?.options.map((o) => o.id)).toContain("another-leg");
    // No "take it over", "skip" or "cancel" left alone in the words.
    expect(JSON.stringify(two)).not.toMatch(/Take it over|Skip it|Cancel the job/);
  });

  it("maps my answers to what Oraknid does, and keeps the old answers working", () => {
    const qs = asked({ others: [{ id: "leg-b", name: "Claude B" }] }).questions;
    const a = (
      what: string,
      more: { questionId: string; options?: string[]; text?: string }[] = [],
    ) =>
      completeAnswers(qs, [
        { questionId: "what", options: [what], text: "" },
        ...more.map((m) => ({ options: [], text: "", ...m })),
      ]);
    expect(
      readKeepsGoingWrong("", a("advice", [{ questionId: "advice", text: "use printf" }])),
    ).toEqual({ kind: "advice", advice: "use printf" });
    expect(
      readKeepsGoingWrong("", a("another-leg", [{ questionId: "leg", options: ["leg-b"] }])),
    ).toEqual({ kind: "another-leg", legId: "leg-b", advice: "" });
    expect(readKeepsGoingWrong("", a("another-leg"))).toEqual({
      kind: "another-leg",
      legId: null,
      advice: "",
    });
    expect(readKeepsGoingWrong("", a("mine"))).toEqual({ kind: "mine" });
    expect(readKeepsGoingWrong("", a("leave-out"))).toEqual({
      kind: "leave-out",
      dependents: true,
    });
    expect(readKeepsGoingWrong("", a("stop"))).toEqual({ kind: "stop" });
    // Nothing chosen: the recommended answer, try again.
    expect(readKeepsGoingWrong("", completeAnswers(qs, []))).toEqual({
      kind: "advice",
      advice: "",
    });
    // An item asked before ADR-045, answered with its old words.
    expect(readKeepsGoingWrong("Retry", null)).toEqual({ kind: "advice", advice: "" });
    expect(readKeepsGoingWrong("Take it over", null)).toEqual({ kind: "mine" });
    expect(readKeepsGoingWrong("Skip it", null)).toEqual({ kind: "leave-out", dependents: false });
    expect(readKeepsGoingWrong("Cancel the job", null)).toEqual({ kind: "stop" });
    expect(readKeepsGoingWrong("try a smaller step", null)).toEqual({
      kind: "advice",
      advice: "try a smaller step",
    });
  });

  it("answers an item's own option through the question that says what each does", () => {
    const q = choiceQuestion("Send it?", [
      { label: "Send", detail: "It is sent now." },
      { label: "Don't send", detail: "It isn't sent." },
    ]);
    const options = ["Send", "Don't send"];
    expect(chosenOption([q], [{ questionId: "choice", options: ["o2"], text: "" }], options)).toBe(
      "Don't send",
    );
    // Not the item's own options: answered as questions, as before.
    expect(
      chosenOption([q], [{ questionId: "choice", options: ["o2"], text: "" }], ["Approve"]),
    ).toBe(null);
  });
});
