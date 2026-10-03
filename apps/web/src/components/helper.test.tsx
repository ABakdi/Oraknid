import type { HelperMessage } from "@oraknid/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route, Router, Switch } from "wouter";

// The floating helper sends what the app knows, and shows me what it answers (ADR-041).

let talk: HelperMessage[] = [];
const sent: { text: string; context?: Record<string, unknown> }[] = [];
let reply: HelperMessage | null = null;
const reported: Record<string, unknown>[] = [];
vi.mock("@/lib/api", () => ({
  api: {
    helper: {
      conversation: async () => talk,
      thinking: async () => false,
      send: async (x: { text: string; context?: Record<string, unknown> }) => {
        sent.push(x);
        talk = [
          ...talk,
          { id: `o${talk.length}`, author: "owner", text: x.text, actions: [], at: 1 },
          ...(reply ? [reply] : []),
        ];
      },
      decide: async () => ({}),
      shown: async (x: Record<string, unknown>) => {
        reported.push(x);
        return {};
      },
      clear: async () => {},
    },
  },
  message: (e: unknown) => String(e),
}));

const { HelperButton } = await import("./helper");
const { askHelper, rings } = await import("@/lib/helper-show");

const highlight = (id: string, note: string): HelperMessage => ({
  id: "h1",
  author: "helper",
  text: "Here it is.",
  actions: [
    {
      name: "highlight",
      input: { id, note },
      summary: "The switch",
      state: "done",
      result: "Shown on your screen.",
      link: null,
    },
  ],
  at: 2,
});

/** A modal dialog as ours are (the same slot as components/ui/dialog.tsx), with a close. */
function Modal() {
  const [open, setOpen] = useState(true);
  return open ? (
    <div role="dialog" data-slot="dialog-content">
      <p data-help="settings.terminal-switch">Terminal</p>
      <button type="button" onClick={() => setOpen(false)}>
        Close the dialog
      </button>
    </div>
  ) : null;
}

function App() {
  return (
    <Router>
      <Switch>
        <Route path="/settings/security">
          <p data-help="settings.terminal-switch">Terminal</p>
        </Route>
        <Route path="/settings/dialog">
          <Modal />
        </Route>
        <Route>
          <p>elsewhere</p>
        </Route>
      </Switch>
      <HelperButton />
    </Router>
  );
}

let narrow = false;
beforeEach(() => {
  history.replaceState(null, "", "/docs/security");
  talk = [];
  sent.length = 0;
  reply = null;
  reported.length = 0;
  narrow = false;
  rings.set(null);
  HTMLElement.prototype.scrollIntoView = () => {};
  HTMLElement.prototype.scrollTo = () => {};
  window.matchMedia = ((q: string) => ({
    matches: q.includes("max-width") ? narrow : false,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

const ask = async (text: string) => {
  fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
};

describe("the helper panel (ADR-041)", () => {
  it("sends where I am, the related guide pages and the screens, and the page I asked from", async () => {
    render(<App />);
    act(() => askHelper({ about: "security", title: "Security" }));
    expect(await screen.findByText("About “Security” in the guide")).toBeTruthy();
    await ask("How do I add an IMAP mail account?");
    await waitFor(() => expect(sent).toHaveLength(1));
    const c = sent[0]?.context as {
      route: string;
      about: string;
      guide: { slug: string }[];
      screens: string;
    };
    expect(c.route).toBe("/docs/security");
    expect(c.about).toBe("security");
    expect(c.guide.map((p) => p.slug).slice(0, 2)).toEqual(["security", "mail"]);
    expect(c.screens).toContain("settings.terminal-switch");
  });

  it("runs what the reply shows me, once: the page opens and the control is ringed", async () => {
    // What was said before I came is not shown again.
    talk = [highlight("settings.terminal-switch", "Old")];
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Ask the Oraknid helper" }));
    await screen.findByText("Here it is.");
    expect(location.pathname).toBe("/docs/security");
    reply = { ...highlight("settings.terminal-switch", "Turn it on here"), id: "h2" };
    await ask("Where do I turn the terminal on?");
    await waitFor(() => expect(location.pathname).toBe("/settings/security"));
    await waitFor(() => expect(rings.get()?.note).toBe("Turn it on here"));
    // "Show me again" points again.
    rings.set(null);
    fireEvent.click(screen.getAllByRole("button", { name: "Show me again" })[1] as HTMLElement);
    await waitFor(() => expect(rings.get()?.note).toBe("Turn it on here"));
  });

  it("steps aside on a phone while it shows me, and comes back with a tap", async () => {
    narrow = true;
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Ask the Oraknid helper" }));
    reply = highlight("settings.terminal-switch", "Here");
    await ask("Where is the terminal switch?");
    await waitFor(() => expect(rings.get()?.note).toBe("Here"));
    expect(screen.queryByRole("region", { name: "Oraknid helper" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to the helper" }));
    expect(screen.getByRole("region", { name: "Oraknid helper" })).toBeTruthy();
  });

  it("tells the helper when a highlight can't be shown, and says why under it", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Ask the Oraknid helper" }));
    reply = { ...highlight("nowhere.at-all", "Here"), id: "h3" };
    await ask("Where is it?");
    await waitFor(() =>
      expect(reported).toEqual([
        {
          messageId: "h3",
          index: 0,
          ok: false,
          why: 'Nothing on the screens is called "nowhere.at-all".',
        },
      ]),
    );
    expect(rings.get()).toBeNull();
    // A highlight shown fine tells nothing.
    reported.length = 0;
    reply = { ...highlight("settings.terminal-switch", "There"), id: "h4" };
    await ask("And the terminal?");
    await waitFor(() => expect(rings.get()?.note).toBe("There"));
    expect(reported).toEqual([]);
  });

  it("steps aside for a control in a dialog, says so on the ring, and comes back when it closes", async () => {
    history.replaceState(null, "", "/settings/dialog");
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Ask the Oraknid helper" }));
    reply = highlight("settings.terminal-switch", "Turn it on");
    await ask("Where is the terminal switch?");
    await waitFor(() =>
      expect(rings.get()?.note).toBe("Turn it on Close this dialog to get back to the helper."),
    );
    // The panel can't be used while the dialog holds the page: it waits.
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Oraknid helper" })).toBeNull(),
    );
    expect(screen.getByRole("button", { name: "Back to the helper" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close the dialog" }));
    expect(
      await screen.findByRole("region", { name: "Oraknid helper" }, { timeout: 2000 }),
    ).toBeTruthy();
  });
});
