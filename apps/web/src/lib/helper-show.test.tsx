import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route, Router, Switch, useLocation } from "wouter";
import { HelpRing } from "@/components/help-ring";
import { PageTabs } from "@/components/page-tabs";
import { findHelp, rings, show } from "./helper-show";

// What the helper shows me, here in the browser (ADR-041).

let go: (to: string) => void = () => {};
function Probe() {
  const [, nav] = useLocation();
  go = nav;
  return null;
}

/** A menu that opens on the pointer going down, as Radix's do, holding a dialog with the option. */
function AccountMenu() {
  const [menu, setMenu] = useState(false);
  const [dialog, setDialog] = useState(false);
  return (
    <div>
      <button type="button" data-help="mail.account-menu" onPointerDown={() => setMenu(true)}>
        …
      </button>
      {menu ? (
        <div role="menu">
          <button
            type="button"
            data-help="mail.account-settings"
            onClick={() => {
              setMenu(false);
              setDialog(true);
            }}
          >
            Account settings…
          </button>
        </div>
      ) : null}
      {dialog ? (
        <div role="dialog">
          <label data-help="mail.account.auto">
            <input type="checkbox" /> Auto-send
          </label>
        </div>
      ) : null}
    </div>
  );
}

function Goal() {
  const [goal, setGoal] = useState("");
  return (
    <>
      <textarea data-help="work.goal" value={goal} onChange={(e) => setGoal(e.target.value)} />
      <output>{goal ? `goal: ${goal}` : "no goal"}</output>
      <details>
        <summary>Checks and inputs</summary>
        <div data-help="work.checks">
          <textarea aria-label="checks" />
        </div>
      </details>
    </>
  );
}

function App() {
  return (
    <Router>
      <Probe />
      <Switch>
        <Route path="/settings/:tab">
          {(p) => (
            <PageTabs
              base="/settings"
              tab={p.tab}
              tabs={[
                { id: "general", label: "General", content: () => <p>general</p> },
                {
                  id: "security",
                  label: "Security",
                  content: () => (
                    <label data-help="settings.terminal-switch">
                      <input type="checkbox" /> Terminal
                    </label>
                  ),
                },
              ]}
            />
          )}
        </Route>
        <Route path="/new">
          <Goal />
        </Route>
        <Route path="/mail">
          <AccountMenu />
        </Route>
        <Route>
          <p>overview</p>
        </Route>
      </Switch>
      <HelpRing />
    </Router>
  );
}

const deps = () => ({
  location: () => location.pathname,
  go: (to: string) => go(to),
  timeoutMs: 1500,
});
const scrolled = vi.fn();
let reduce = false;

beforeEach(() => {
  history.replaceState(null, "", "/");
  rings.set(null);
  scrolled.mockReset();
  reduce = false;
  HTMLElement.prototype.scrollIntoView = scrolled;
  window.matchMedia = ((q: string) => ({
    matches: q.includes("reduce") ? reduce : false,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

describe("the helper shows me (ADR-041)", () => {
  it("navigate opens a page, with its item and tab", async () => {
    render(<App />);
    await act(() =>
      show({ name: "navigate", input: { page: "settings", tab: "security" } }, deps()),
    );
    expect(location.pathname).toBe("/settings/security");
    expect(findHelp("settings.terminal-switch")).not.toBeNull();
    const r = await act(() => show({ name: "navigate", input: { page: "nowhere" } }, deps()));
    expect(r).toEqual({ ok: false, why: 'There is no page "nowhere".' });
  });

  it("highlight opens the control's page and tab, scrolls to it and rings it until I click", async () => {
    render(<App />);
    const r = await act(() =>
      show({ name: "highlight", input: { id: "settings.terminal-switch", note: "Here" } }, deps()),
    );
    expect(r).toEqual({ ok: true });
    expect(location.pathname).toBe("/settings/security");
    expect(scrolled).toHaveBeenCalledWith(expect.objectContaining({ behavior: "smooth" }));
    expect(rings.get()?.el.getAttribute("data-help")).toBe("settings.terminal-switch");
    expect(await screen.findByRole("status")).toHaveProperty("textContent", "Here");
    expect(document.querySelector("[data-help-ring]")).not.toBeNull();
    // A click anywhere (the control too) and it is gone.
    await act(() => new Promise((r) => setTimeout(r, 5)));
    fireEvent.pointerDown(document.body);
    expect(rings.get()).toBeNull();
    expect(document.querySelector("[data-help-ring]")).toBeNull();
  });

  it("points at a tab, and goes away when I move to another page", async () => {
    history.replaceState(null, "", "/settings/general");
    render(<App />);
    reduce = true;
    await act(() => show({ name: "highlight", input: { id: "settings.tab.security" } }, deps()));
    // Already on its page: it stays there, and points without moving (less motion).
    expect(location.pathname).toBe("/settings/general");
    expect(rings.get()?.el.getAttribute("role")).toBe("tab");
    expect(scrolled).toHaveBeenCalledWith(expect.objectContaining({ behavior: "auto" }));
    await act(async () => go("/new"));
    expect(rings.get()).toBeNull();
  });

  it("opens the menu and the dialog that hold a control", async () => {
    render(<App />);
    const r = await act(() =>
      show({ name: "highlight", input: { id: "mail.account.auto" } }, deps()),
    );
    expect(r.ok).toBe(true);
    expect(location.pathname).toBe("/mail");
    expect(screen.getByRole("dialog").textContent).toContain("Auto-send");
    expect(rings.get()?.el.getAttribute("data-help")).toBe("mail.account.auto");
  });

  it("fill puts a value in a field, as if typed, without saving; a folded field is unfolded", async () => {
    render(<App />);
    await act(() =>
      show({ name: "fill", input: { id: "work.goal", value: "Set up Astro" } }, deps()),
    );
    expect(location.pathname).toBe("/new");
    expect(screen.getByText("goal: Set up Astro")).toBeTruthy();
    await act(() =>
      show({ name: "fill", input: { id: "work.checks", value: "pnpm test" } }, deps()),
    );
    expect((screen.getByLabelText("checks") as HTMLTextAreaElement).value).toBe("pnpm test");
    expect(document.querySelector("details")?.open).toBe(true);
    const bad = await act(() =>
      show({ name: "fill", input: { id: "settings.tab.general", value: "x" } }, deps()),
    );
    expect(bad).toEqual({ ok: false, why: '"Settings → General" isn\'t a field.' });
  });

  it("says why when it can't", async () => {
    render(<App />);
    expect(await act(() => show({ name: "highlight", input: { id: "no.such" } }, deps()))).toEqual({
      ok: false,
      why: 'Nothing on the screens is called "no.such".',
    });
    expect(
      await act(() => show({ name: "highlight", input: { id: "project.archive" } }, deps())),
    ).toEqual({ ok: false, why: "Open the projects first: which one?" });
    // Its page shows nothing by that id (not drawn here): it gives up in time.
    expect(await act(() => show({ name: "highlight", input: { id: "legs.add" } }, deps()))).toEqual(
      { ok: false, why: '"Add a Leg" isn\'t on the screen now.' },
    );
  });
});
