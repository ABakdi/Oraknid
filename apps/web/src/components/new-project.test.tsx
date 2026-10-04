import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// New work's new GitHub repo, on the account I pick (ADR-038).

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
// Radix's Select asks these of the elements it opens.
HTMLElement.prototype.scrollIntoView = () => {};
HTMLElement.prototype.hasPointerCapture = () => false;
HTMLElement.prototype.releasePointerCapture = () => {};

let ACCOUNTS = [
  { login: "me", error: null },
  { login: "work", error: null },
];

vi.mock("@/lib/api", () => ({
  api: { github: { accounts: async () => ACCOUNTS } },
  message: (e: unknown) => String(e),
}));

const { GitHubAccountPicker, newProjectSource } = await import("./work");

afterEach(() => {
  cleanup();
  ACCOUNTS = [
    { login: "me", error: null },
    { login: "work", error: null },
  ];
});

const base = {
  source: "github-new" as const,
  path: "",
  parent: " /home/me/Dev ",
  name: "site",
  isPrivate: false,
  account: "",
  repo: "",
  url: "",
  repoAccount: "",
};

describe("a new GitHub repo's account (ADR-038)", () => {
  it("offers my accounts, the default first and chosen, and says the one I pick", async () => {
    const onChange = vi.fn();
    render(<GitHubAccountPicker value="" onChange={onChange} />);
    const trigger = await screen.findByRole("combobox", { name: "GitHub account" });
    expect(trigger.textContent).toContain("me");
    expect(trigger.textContent).toContain("default");
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(await screen.findByRole("option", { name: /^work/ }));
    expect(onChange).toHaveBeenCalledWith("work");
  });

  it("shows nothing to pick with one account", async () => {
    ACCOUNTS = [{ login: "me", error: null }];
    const { container } = render(<GitHubAccountPicker value="" onChange={() => {}} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.textContent).toBe("");
  });

  it("sends the account picked with the new repo, and none for the default", () => {
    expect(newProjectSource({ ...base, account: "work" })).toEqual({
      kind: "github-new",
      account: "work",
      parent: "/home/me/Dev",
      name: "site",
      private: false,
      description: "",
    });
    expect(newProjectSource(base)).not.toHaveProperty("account");
    // A clone from Repos keeps the account that reads it.
    expect(
      newProjectSource({ ...base, source: "github-clone", repo: "acme/x", repoAccount: "work" }),
    ).toEqual({
      kind: "github-clone",
      parent: "/home/me/Dev",
      fullName: "acme/x",
      account: "work",
    });
  });
});
