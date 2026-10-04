import type { FolderList } from "@oraknid/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The folder picker (Web-UI → The folder picker): the daemon's listing,
// breadcrumbs, up and home, a repo marked, a folder it may not open, a
// typed path, a new folder, and the folder chosen.

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const FOLDERS: Record<string, { name: string; git?: boolean; locked?: boolean }[]> = {
  "/home/me": [{ name: "code" }, { name: "private", locked: true }],
  "/home/me/code": [{ name: "app" }, { name: "piano", git: true }],
  "/home/me/code/app": [],
  "/home/me/code/piano": [],
};
const asked: (string | undefined)[] = [];
const listing = (path = "/home/me"): FolderList => {
  const entries = FOLDERS[path];
  if (!entries) throw new Error(`${path} doesn't exist.`);
  return {
    path,
    parent: path.split("/").slice(0, -1).join("/") || "/",
    home: "/home/me",
    isGitRepo: path.endsWith("piano"),
    writable: true,
    entries: entries.map((e) => ({
      name: e.name,
      path: `${path}/${e.name}`,
      isGitRepo: !!e.git,
      symlink: false,
      readable: !e.locked,
    })),
    hidden: 2,
    truncated: false,
  };
};
const makeFolder = vi.fn(async ({ parent, name }: { parent: string; name: string }) => {
  const path = `${parent}/${name}`;
  FOLDERS[parent]?.push({ name });
  FOLDERS[path] = [];
  return { path };
});

vi.mock("@/lib/api", () => ({
  api: {
    files: {
      folders: async (i: { path?: string }) => {
        asked.push(i.path);
        return listing(i.path);
      },
      makeFolder: (i: { parent: string; name: string }) => makeFolder(i),
    },
  },
  message: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

const { FolderPicker, crumbs } = await import("./folder-picker");

afterEach(() => {
  cleanup();
  asked.length = 0;
});

const picker = (start?: string) => {
  const onChoose = vi.fn();
  render(<FolderPicker open onOpenChange={() => {}} start={start} onChoose={onChoose} />);
  return onChoose;
};

describe("the folder picker", () => {
  it("opens at my home, walks into folders, marks a repo, and chooses one", async () => {
    const onChoose = picker();
    fireEvent.click(await screen.findByRole("button", { name: /^code/ }));
    const piano = await screen.findByRole("button", { name: /^piano/ });
    expect(within(piano).getByText("git")).toBeTruthy();
    expect(within(screen.getByRole("button", { name: /^app/ })).queryByText("git")).toBeNull();
    // The breadcrumbs say where I am, each a way back.
    const crumbsNav = screen.getByRole("navigation", { name: "Where you are" });
    expect(within(crumbsNav).getByRole("button", { name: "code" })).toBeTruthy();
    fireEvent.click(piano);
    await screen.findByText("No folders in here.");
    fireEvent.click(screen.getByRole("button", { name: /Choose this folder/ }));
    expect(onChoose).toHaveBeenCalledWith("/home/me/code/piano", expect.anything());
  });

  it("goes up and home", async () => {
    picker("/home/me/code/app");
    await screen.findByText("No folders in here.");
    fireEvent.click(screen.getByRole("button", { name: "Up" }));
    await screen.findByRole("button", { name: /^piano/ });
    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    await screen.findByRole("button", { name: /^private/ });
    expect(asked.at(-1)).toBeUndefined();
  });

  it("lists a folder it may not open without opening it", async () => {
    picker();
    const locked = await screen.findByRole("button", { name: /^private/ });
    expect(locked).toHaveProperty("disabled", true);
    expect(locked.getAttribute("title")).toMatch(/isn't allowed to look in/);
  });

  it("opens at home, saying why, when where it starts isn't there", async () => {
    picker("/home/me/gone");
    expect((await screen.findByRole("alert")).textContent).toBe("/home/me/gone doesn't exist.");
    await screen.findByRole("button", { name: /^code/ });
  });

  it("takes a typed path, and says one that isn't there", async () => {
    picker();
    await screen.findByRole("button", { name: /^code/ });
    const typed = screen.getByLabelText("Or type a path");
    fireEvent.change(typed, { target: { value: "/nowhere" } });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect((await screen.findByRole("alert")).textContent).toBe("/nowhere doesn't exist.");
    fireEvent.change(typed, { target: { value: "/home/me/code" } });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    await screen.findByRole("button", { name: /^piano/ });
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("makes a new folder where I am, and opens it", async () => {
    picker("/home/me/code");
    await screen.findByRole("button", { name: /^piano/ });
    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    fireEvent.change(screen.getByLabelText("New folder's name"), { target: { value: "my site" } });
    fireEvent.click(screen.getByRole("button", { name: "Make it" }));
    await waitFor(() =>
      expect(makeFolder).toHaveBeenCalledWith({ parent: "/home/me/code", name: "my-site" }),
    );
    await screen.findByText("No folders in here.");
    expect(screen.getByText("/home/me/code/my-site")).toBeTruthy();
  });

  it("splits a path into breadcrumbs", () => {
    expect(crumbs("/home/me")).toEqual([
      { name: "/", path: "/" },
      { name: "home", path: "/home" },
      { name: "me", path: "/home/me" },
    ]);
    expect(crumbs("/")).toEqual([{ name: "/", path: "/" }]);
  });
});
