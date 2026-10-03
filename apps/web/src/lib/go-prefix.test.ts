import { afterEach, describe, expect, it, vi } from "vitest";
import { GO_WAIT, goPrefix } from "./go-prefix";

// `g` then a key (Web-UI → Keyboard): the key after `g` is swallowed before
// any page's own shortcuts see it (Mail's `r` reply, `c` write).

const typing = (e: KeyboardEvent) => {
  const el = e.target as HTMLElement | null;
  return !!el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
};

const press = (key: string, target: EventTarget = window, more: KeyboardEventInit = {}) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...more }));

describe("the g prefix", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
    document.body.innerHTML = "";
  });

  /** The shell's listener (capture) and a page's own one (bubble), as Mail adds them. */
  const setup = (now?: () => number) => {
    const go = vi.fn();
    const page = vi.fn();
    const pageOwn = (e: KeyboardEvent) => {
      if (!typing(e)) page(e.key);
    };
    // The page's listener is added first, as a child's effect runs before its parent's.
    window.addEventListener("keydown", pageOwn);
    const on = goPrefix({ r: "/repos", c: "/chats", m: "/mail" }, go, typing, now);
    window.addEventListener("keydown", on, true);
    cleanups.push(() => {
      window.removeEventListener("keydown", pageOwn);
      window.removeEventListener("keydown", on, true);
    });
    return { go, page };
  };

  it("g r goes to Repos and the page never sees r", () => {
    const { go, page } = setup();
    press("g");
    press("r");
    expect(go).toHaveBeenCalledWith("/repos");
    expect(page.mock.calls.map((c) => c[0])).toEqual(["g"]);
  });

  it("g c goes to Chats without the page writing, also from a focused button", () => {
    const { go, page } = setup();
    const button = document.createElement("button");
    document.body.append(button);
    press("g", button);
    press("c", button);
    expect(go).toHaveBeenCalledWith("/chats");
    expect(page.mock.calls.map((c) => c[0])).toEqual(["g"]);
  });

  it("swallows an unknown key after g too, and Shift on the way doesn't end the prefix", () => {
    const { go, page } = setup();
    press("g");
    press("Shift");
    press("x");
    expect(go).not.toHaveBeenCalled();
    expect(page.mock.calls.map((c) => c[0])).toEqual(["g", "Shift"]);
    // The next one is the page's again.
    press("r");
    expect(page.mock.calls.map((c) => c[0])).toEqual(["g", "Shift", "r"]);
  });

  it("lets the key through once g has waited too long", () => {
    let t = 1_000;
    const { go, page } = setup(() => t);
    press("g");
    t += GO_WAIT + 1;
    press("r");
    expect(go).not.toHaveBeenCalled();
    expect(page.mock.calls.map((c) => c[0])).toEqual(["g", "r"]);
  });

  it("does nothing while I type", () => {
    const { go } = setup();
    const input = document.createElement("input");
    document.body.append(input);
    press("g", input);
    press("r", input);
    expect(go).not.toHaveBeenCalled();
  });
});
