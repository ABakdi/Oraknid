import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LegAvatar, LegHandoff, legLook } from "./leg-avatar";
import { HANDOFF_MS, nextHandoffs, useHandoffs } from "./web-graph";

// A Leg's avatar on its task, and the handoff when a task moves to another Leg (Web-UI → Job).

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("a Leg's avatar", () => {
  it("takes two initials from the Leg's name", () => {
    expect(legLook({ name: "Work", kind: "claude-code" }).initials).toBe("WO");
    expect(legLook({ name: "Claude Max", kind: "claude-code" }).initials).toBe("CM");
    expect(legLook({ name: "local-qwen", kind: "openai-compatible" }).initials).toBe("LQ");
    expect(legLook({ name: "é", kind: "opencode" }).initials).toBe("É");
    expect(legLook({ name: "··", kind: "opencode" }).initials).toBe("?");
  });

  it("has the same colour wherever the Leg shows, near its kind's own colour", () => {
    const a = legLook({ name: "Work", kind: "claude-code" });
    expect(legLook({ name: "Work", kind: "claude-code" })).toEqual(a);
    const near = (hue: number, base: number) =>
      Math.min(Math.abs(hue - base), 360 - Math.abs(hue - base)) <= 40;
    expect(near(a.hue, 40)).toBe(true);
    const local = legLook({ name: "Work", kind: "openai-compatible" });
    expect(near(local.hue, 310)).toBe(true);
    expect(local.hue).not.toBe(a.hue);
    // Two Legs of one kind are told apart.
    expect(legLook({ name: "Home", kind: "claude-code" }).hue).not.toBe(a.hue);
  });

  it("is named for screen readers and the pointer", () => {
    render(<LegAvatar leg={{ name: "Claude Max", kind: "claude-code" }} />);
    const img = screen.getByRole("img", { name: "Claude Max" });
    expect(img.textContent).toBe("CM");
    expect(img.getAttribute("title")).toBe("Claude Max (claude-code)");
    expect(img.style.backgroundColor).toContain("oklch");
  });
});

describe("a handoff between two Legs", () => {
  const work = { name: "Work", kind: "claude-code" };
  const ollama = { name: "Ollama", kind: "openai-compatible" };

  it("is found when a task's Leg changes, not on the first look nor while it waits", () => {
    const seen = new Map<string, string>();
    expect(nextHandoffs(seen, [{ id: "t1", assignedLegId: "L1" }])).toEqual([]);
    expect(nextHandoffs(seen, [{ id: "t1", assignedLegId: "L1" }])).toEqual([]);
    // Back to ready between attempts: the Leg it had is kept.
    expect(nextHandoffs(seen, [{ id: "t1", assignedLegId: null }])).toEqual([]);
    expect(
      nextHandoffs(seen, [
        { id: "t1", assignedLegId: "L2" },
        { id: "t2", assignedLegId: "L1" },
      ]),
    ).toEqual([{ taskId: "t1", from: "L1", to: "L2" }]);
  });

  it("shows on its task as the tasks change, then goes", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ tasks }) => useHandoffs(tasks), {
      initialProps: { tasks: [{ id: "t1", assignedLegId: "L1" as string | null }] },
    });
    expect(result.current.size).toBe(0);
    rerender({ tasks: [{ id: "t1", assignedLegId: "L2" }] });
    expect(result.current.get("t1")).toEqual({ taskId: "t1", from: "L1", to: "L2" });
    act(() => vi.advanceTimersByTime(HANDOFF_MS + 10));
    expect(result.current.size).toBe(0);
  });

  it("draws a dot travelling from one avatar to the other, still under reduced motion", () => {
    render(<LegHandoff from={work} to={ollama} />);
    const h = screen.getByTestId("leg-handoff");
    expect(h.getAttribute("title")).toBe("Handed from Work to Ollama");
    expect(screen.getAllByRole("img").map((x) => x.textContent)).toEqual(["WO", "OL"]);
    const dot = h.querySelector("[data-handoff-dot]");
    // Only with motion allowed: the animation (and the dot) are motion-safe.
    expect(dot?.className).toContain("motion-safe:animate-[leg-handoff");
    expect(dot?.className).toContain("hidden");
  });
});
