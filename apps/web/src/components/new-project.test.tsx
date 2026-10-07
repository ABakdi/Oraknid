import type { FolderList } from "@oraknid/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A new project that says what it does (M13.19): its name first, then New
// (the default), a folder I have, or GitHub; the sentence saying what will
// happen; the right createFrom call. And a new GitHub repo's account (ADR-038).

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
let CONNECTED = true;
const REPOS = [
  {
    account: "ABakdi",
    owner: "ABakdi",
    name: "piano",
    fullName: "ABakdi/piano",
    visibility: "private",
    defaultBranch: "main",
    pushedAt: null,
    description: "A piano app",
    archived: false,
    fork: false,
    url: "https://github.com/ABakdi/piano",
    project: null,
  },
  {
    account: "work",
    owner: "acme",
    name: "site",
    fullName: "acme/site",
    visibility: "public",
    defaultBranch: "main",
    pushedAt: null,
    description: null,
    archived: false,
    fork: false,
    url: "https://github.com/acme/site",
    project: null,
  },
];

const FOLDERS: Record<string, string[]> = {
  "/home/me": ["code"],
  "/home/me/code": ["app", "piano"],
  "/home/me/code/app": [],
  "/home/me/code/piano": [],
};
const listing = (path = "/home/me"): FolderList => {
  const names = FOLDERS[path];
  if (!names) throw new Error(`${path} doesn't exist.`);
  return {
    path,
    parent: path === "/" ? null : path.split("/").slice(0, -1).join("/") || "/",
    home: "/home/me",
    isGitRepo: path.endsWith("piano"),
    writable: true,
    entries: names.map((n) => ({
      name: n,
      path: `${path}/${n}`,
      isGitRepo: n === "piano",
      symlink: false,
      readable: true,
    })),
    hidden: 0,
    truncated: false,
  };
};

const createFrom = vi.fn();
vi.mock("@/lib/api", () => ({
  api: {
    github: {
      accounts: async () => ACCOUNTS,
      status: async () => ({ connected: CONNECTED, login: CONNECTED ? "me" : null, error: null }),
      repoList: async () => ({ repos: CONNECTED ? REPOS : [], errors: [], truncated: false }),
    },
    // No GitLab, Gitea or Forgejo account here: every host's list is GitHub's (ADR-062).
    hosts: {
      accounts: async () => [],
      repoList: async () => ({ repos: CONNECTED ? REPOS : [], errors: [], truncated: false }),
    },
    files: { folders: async (i: { path?: string }) => listing(i.path) },
    projects: { createFrom: (i: unknown) => createFrom(i) },
  },
  message: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

const { GitHubAccountPicker, NewProjectDialog, newDraft, projectSource, slugify, whatHappens } =
  await import("./new-project");

const project = (repos = 1) => ({
  id: "P1",
  repos: Array.from({ length: repos }, (_, i) => ({ name: `r${i}` })),
});

beforeEach(() => {
  localStorage.setItem("oraknid.newwork.parent", "/home/me/code");
  createFrom.mockReset();
  createFrom.mockResolvedValue(project());
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  CONNECTED = true;
  ACCOUNTS = [
    { login: "me", error: null },
    { login: "work", error: null },
  ];
});

const said = () => screen.getByRole("status").textContent ?? "";
const open = () => render(<NewProjectDialog open onOpenChange={() => {}} />);

describe("New project", () => {
  it("asks the name first, and New is the default, in the last parent used", async () => {
    open();
    const boxes = screen.getAllByRole("textbox");
    expect(boxes[0]).toBe(screen.getByLabelText("Name"));
    expect(screen.getByRole("radio", { name: /^New/ }).getAttribute("aria-checked")).toBe("true");
    expect((screen.getByLabelText("Where it goes") as HTMLInputElement).value).toBe(
      "/home/me/code",
    );
    expect(said()).toMatch(/Give it a name/);
    expect(screen.getByRole("button", { name: "Create project" })).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "My Piano" } });
    expect(said()).toBe("Creates /home/me/code/my-piano and makes it a git repo.");
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    await waitFor(() =>
      expect(createFrom).toHaveBeenCalledWith({
        name: "My Piano",
        source: { kind: "new-folder", parent: "/home/me/code", name: "my-piano" },
      }),
    );
  });

  it("makes a new GitHub repo too when asked, private by default, and says so", async () => {
    open();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "piano" } });
    fireEvent.click(await screen.findByLabelText("Also a new GitHub repo"));
    expect(said()).toBe(
      "Creates a new private GitHub repo, me/piano, clones it into /home/me/code/piano and links the project to it.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    await waitFor(() =>
      expect(createFrom).toHaveBeenCalledWith({
        name: "piano",
        source: {
          kind: "github-new",
          parent: "/home/me/code",
          name: "piano",
          private: true,
          description: "",
        },
      }),
    );
  });

  it("uses a folder I have, chosen with the picker, and asks when it isn't a repo", async () => {
    open();
    fireEvent.click(screen.getByRole("radio", { name: /A folder on this computer/ }));
    fireEvent.click(screen.getByRole("button", { name: /Choose the project's folder/ }));
    const picker = await screen.findByRole("dialog", { name: "The project's folder" });
    fireEvent.click(await within(picker).findByRole("button", { name: /^code/ }));
    fireEvent.click(await within(picker).findByRole("button", { name: /^app/ }));
    await within(picker).findByText("No folders in here.");
    fireEvent.click(within(picker).getByRole("button", { name: /Choose this folder/ }));
    await waitFor(() =>
      expect(said()).toBe(
        "Uses /home/me/code/app as the project. Nothing in it changes until a job runs, and then only in a worktree.",
      ),
    );
    createFrom.mockRejectedValueOnce(new Error("/home/me/code/app is not a git repo: choose"));
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    expect(createFrom).toHaveBeenLastCalledWith({
      source: { kind: "folder", path: "/home/me/code/app" },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Make it a git repo" }));
    await waitFor(() =>
      expect(createFrom).toHaveBeenLastCalledWith({
        source: { kind: "folder", path: "/home/me/code/app", initGit: true },
      }),
    );
  });

  it("clones one of my GitHub repos, picked from a searchable list, through its account", async () => {
    open();
    fireEvent.click(screen.getByRole("radio", { name: /From GitHub/ }));
    fireEvent.change(await screen.findByPlaceholderText("Search your repos"), {
      target: { value: "pia" },
    });
    const list = await screen.findByRole("listbox", { name: "Your repos" });
    await waitFor(() => expect(within(list).queryByText("acme/site")).toBeNull());
    fireEvent.click(within(list).getByRole("option", { name: /ABakdi\/piano/ }));
    expect(said()).toBe(
      "Clones ABakdi/piano into /home/me/code/piano and links the project to it.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    await waitFor(() =>
      expect(createFrom).toHaveBeenCalledWith({
        name: "piano",
        source: {
          kind: "github-clone",
          parent: "/home/me/code",
          fullName: "ABakdi/piano",
          account: "ABakdi",
        },
      }),
    );
  });

  it("clones a link, saying only a public repo works without a GitHub account", async () => {
    CONNECTED = false;
    open();
    fireEvent.click(screen.getByRole("radio", { name: /From GitHub/ }));
    const url = await screen.findByLabelText("The repo's link");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(
      screen.getAllByText(/Without a GitHub account, only a public repo can be cloned/).length,
    ).toBeGreaterThan(0);
    fireEvent.change(url, { target: { value: "https://github.com/ABakdi/piano.git" } });
    await waitFor(() =>
      expect(said()).toBe(
        "Clones https://github.com/ABakdi/piano.git into /home/me/code/piano. Without a GitHub account, only a public repo can be cloned.",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    await waitFor(() =>
      expect(createFrom).toHaveBeenCalledWith({
        source: {
          kind: "git-url",
          parent: "/home/me/code",
          url: "https://github.com/ABakdi/piano.git",
        },
      }),
    );
  });
});

describe("the form's pieces", () => {
  it("names a folder from the project's name", () => {
    expect(slugify("  My Piano App! ")).toBe("my-piano-app");
    expect(slugify("Café déjà vu")).toBe("cafe-deja-vu");
    expect(slugify("...")).toBe("");
  });

  it("says nothing will happen while something is missing", () => {
    expect(projectSource(newDraft({ parent: "", name: "x" }))).toBeNull();
    expect(whatHappens(newDraft({ origin: "folder" }), { github: true })).toBeNull();
  });
});

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
    const d = newDraft({
      name: "site",
      parent: " /home/me/Dev ",
      onGitHub: true,
      isPrivate: false,
    });
    expect(projectSource({ ...d, account: "work" })).toEqual({
      kind: "github-new",
      account: "work",
      parent: "/home/me/Dev",
      name: "site",
      private: false,
      description: "",
    });
    expect(projectSource(d)).not.toHaveProperty("account");
    // A clone from Repos keeps the account that reads it.
    expect(
      projectSource({ ...d, origin: "github", via: "mine", repo: "acme/x", repoAccount: "work" }),
    ).toEqual({
      kind: "github-clone",
      parent: "/home/me/Dev",
      fullName: "acme/x",
      account: "work",
    });
  });
});
