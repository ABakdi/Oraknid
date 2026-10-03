import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Router } from "wouter";
import { BackButton } from "@/components/common";
import { canGoBack } from "./nav";

const settle = () => new Promise((r) => setTimeout(r, 20));

describe("going back (Web-UI → Going back)", () => {
  it("counts in-app steps: a push is one, a replace keeps it, back reads it again", async () => {
    expect(canGoBack()).toBe(false);
    history.pushState(null, "", "/jobs");
    expect(canGoBack()).toBe(true);
    history.replaceState(null, "", "/jobs/x/web");
    expect(canGoBack()).toBe(true);
    // What a page put in its entry stays there.
    history.replaceState({ from: "page" }, "", "/jobs/x/eye");
    expect((history.state as { from: string }).from).toBe("page");
    history.back();
    await settle();
    expect(canGoBack()).toBe(false);
  });

  it("falls back to the parent when I arrived directly", async () => {
    history.replaceState(null, "", "/servers/abc");
    render(
      <Router>
        <BackButton fallback="/servers" label="All servers" />
      </Router>,
    );
    fireEvent.click(screen.getByRole("button", { name: "All servers" }));
    await settle();
    expect(location.pathname).toBe("/servers");
  });
});
