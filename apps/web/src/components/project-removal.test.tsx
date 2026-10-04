import type { ProjectView, RemovalPreview, RemovalResult } from "@oraknid/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

// Archiving and deleting a project with my choices (Web-UI → Projects):
// the dialogs' checkboxes, the typed confirmation, the result step by step,
// and the Archived projects section of the list.

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const SITE: ProjectView = {
  id: "P1",
  name: "Site",
  workspacePath: "/home/me/site",
  isGitRepo: true,
  shadow: false,
  releaseBranch: "main",
  workBranch: "dev",
  createdAt: 1,
  archivedAt: null,
  archivedWith: null,
  skillIds: [],
  serverIds: [],
  serverRoles: {},
  repos: [
    {
      name: "site",
      folder: "",
      releaseBranch: "main",
      workBranch: "dev",
      github: {
        account: "me",
        owner: "me",
        name: "site",
        visibility: "private",
        origin: "existing",
        ready: true,
        linkedAt: 1,
      },
    },
  ],
  github: null,
  jobCount: 3,
};

const clean = {
  uncommitted: [],
  uncommittedCount: 0,
  unpushed: [],
  stashes: 0,
  error: null,
};

const preview = (over: Partial<RemovalPreview> = {}): RemovalPreview => ({
  id: "P1",
  name: "Site",
  folder: {
    path: "/home/me/site",
    exists: true,
    bytes: 3 * 1024 * 1024,
    files: 120,
    partial: false,
    refused: null,
  },
  runningJobs: [],
  repos: [
    {
      name: "site",
      folder: "",
      path: "/home/me/site",
      github: {
        fullName: "me/site",
        account: "me",
        url: "https://github.com/me/site",
        ready: true,
        owned: true,
        archived: false,
        scopes: ["repo"],
        canDelete: false,
        error: null,
      },
      loss: clean,
    },
  ],
  outside: [],
  archiveFolder: { allowed: true, reasons: [] },
  archivedWith: null,
  ...over,
});

let next = preview();
const removalPreview = vi.fn(async () => next);
const remove = vi.fn(
  async (_: unknown): Promise<RemovalResult> => ({
    steps: [
      {
        kind: "github-delete",
        target: "me/site",
        status: "failed",
        message: "GitHub refused to delete me/site: the token of me hasn't the permission.",
      },
      {
        kind: "folder",
        target: "/home/me/site",
        status: "skipped",
        message: "Not done: a step on GitHub failed.",
      },
      { kind: "records", target: "Site", status: "skipped", message: "Not done either." },
    ],
    kept: true,
    jobs: 0,
    folder: "/home/me/site",
  }),
);
const archive = vi.fn(
  async (_: unknown): Promise<RemovalResult> => ({
    steps: [{ kind: "archive", target: "Site", status: "done", message: "In Archived projects." }],
    kept: true,
    jobs: 0,
    folder: "/home/me/site",
  }),
);

vi.mock("@/lib/api", () => ({
  api: {
    projects: {
      removalPreview: () => removalPreview(),
      delete: (x: unknown) => remove(x),
      archive: (x: unknown) => archive(x),
    },
  },
  message: (e: unknown) => String(e),
}));

vi.mock("@/lib/live", () => ({ useEvents: () => [] }));

const { ProjectRemovalDialog, confirmWord } = await import("./project-removal");
const { ProjectList } = await import("./project-list");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  next = preview();
});

const open = (kind: "archive" | "delete", project = SITE) => {
  const { hook } = memoryLocation({ path: "/projects/P1" });
  return render(
    <Router hook={hook}>
      <ProjectRemovalDialog project={project} kind={kind} onOpenChange={() => {}} />
    </Router>,
  );
};

describe("deleting a project", () => {
  it("is a plain confirm with only Oraknid's records", async () => {
    open("delete");
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Delete “Site”?")).toBeTruthy();
    expect(within(dialog).getByText(/can't be undone/)).toBeTruthy();
    await within(dialog).findByText(/3 job\(s\) leave Oraknid/);
    expect(within(dialog).queryByText(/To confirm, type/)).toBeNull();
    const del = within(dialog).getByRole("button", { name: /^Delete$/ }) as HTMLButtonElement;
    expect(del.disabled).toBe(false);
    fireEvent.click(del);
    await waitFor(() =>
      expect(remove).toHaveBeenCalledWith({
        id: "P1",
        deleteFolder: false,
        deleteRepos: [],
        stopJobs: false,
      }),
    );
  });

  it("asks for the project's name to delete the folder, shows its size, and lists each step after", async () => {
    open("delete");
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      await within(dialog).findByLabelText("Delete the project folder from this computer"),
    );
    expect(within(dialog).getByText(/3 MiB, 120 file\(s\)/)).toBeTruthy();
    const del = within(dialog).getByRole("button", { name: /^Delete$/ }) as HTMLButtonElement;
    expect(del.disabled).toBe(true);
    const input = within(dialog).getByLabelText("Type Site to confirm");
    fireEvent.change(input, { target: { value: "Sit" } });
    expect(del.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "Site" } });
    expect(del.disabled).toBe(false);
    // The GitHub repo too: the project's name still, since the folder goes.
    fireEvent.click(within(dialog).getByLabelText("Delete the GitHub repo me/site"));
    expect(within(dialog).getByText(/hasn't the delete_repo permission/)).toBeTruthy();
    fireEvent.click(del);
    await waitFor(() =>
      expect(remove).toHaveBeenCalledWith({
        id: "P1",
        deleteFolder: true,
        deleteRepos: ["me/site"],
        stopJobs: false,
      }),
    );
    const steps = await screen.findByRole("list", { name: "What was done" });
    expect(
      within(steps)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([
      expect.stringMatching(/^Not done: GitHub refused to delete me\/site/),
      expect.stringMatching(/^Skipped: Not done: a step on GitHub failed/),
      expect.stringMatching(/^Skipped: Not done either/),
    ]);
    expect(screen.getByText("“Site” is still here")).toBeTruthy();
  });

  it("asks for the repo's full name when only a GitHub repo goes", () => {
    expect(confirmWord("Site", false, [])).toBeNull();
    expect(confirmWord("Site", false, ["me/site"])).toBe("me/site");
    expect(confirmWord("Site", true, ["me/site"])).toBe("Site");
    expect(confirmWord("Site", false, ["me/a", "me/b"])).toBe("Site");
  });

  it("refuses a dangerous folder and offers to cancel a running job", async () => {
    next = preview({
      folder: { ...preview().folder, refused: "/home/me is your home folder or holds it." },
      runningJobs: [{ id: "J1", title: "Fix the header" }],
    });
    open("delete");
    const dialog = await screen.findByRole("dialog");
    const box = (await within(dialog).findByLabelText(
      "Delete the project folder from this computer",
    )) as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(within(dialog).getByText(/your home folder/)).toBeTruthy();
    const del = within(dialog).getByRole("button", { name: /^Delete$/ }) as HTMLButtonElement;
    expect(del.disabled).toBe(true);
    expect(within(dialog).getByText(/Still going: Fix the header/)).toBeTruthy();
    fireEvent.click(within(dialog).getByLabelText("Cancel its running jobs first"));
    expect(del.disabled).toBe(false);
  });
});

describe("archiving a project", () => {
  it("offers to archive its GitHub repo and delete its folder, the name typed for the folder", async () => {
    open("archive");
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/moves to Archived projects/)).toBeTruthy();
    fireEvent.click(await within(dialog).findByLabelText("Archive the GitHub repo me/site"));
    fireEvent.click(
      within(dialog).getByLabelText("Delete the project folder from this computer to free space"),
    );
    const go = within(dialog).getByRole("button", { name: /^Archive$/ }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Type Site to confirm"), {
      target: { value: "Site" },
    });
    fireEvent.click(go);
    await waitFor(() =>
      expect(archive).toHaveBeenCalledWith({
        id: "P1",
        archived: true,
        archiveRepos: ["me/site"],
        deleteFolder: true,
        stopJobs: false,
      }),
    );
    expect(await screen.findByText(/In Archived projects/)).toBeTruthy();
  });

  it("disables deleting the folder when something would be lost, and says what", async () => {
    next = preview({
      archiveFolder: {
        allowed: false,
        reasons: ["site: commits not on GitHub, on dev (2)."],
      },
    });
    open("archive");
    const dialog = await screen.findByRole("dialog");
    const box = (await within(dialog).findByLabelText(
      "Delete the project folder from this computer to free space",
    )) as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(within(dialog).getByText("site: commits not on GitHub, on dev (2).")).toBeTruthy();
    // Archiving alone needs no typing.
    expect(
      (within(dialog).getByRole("button", { name: /^Archive$/ }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("unarchives: its GitHub repos offered back, its folder said to come back from GitHub", async () => {
    open("archive", {
      ...SITE,
      archivedAt: 5,
      archivedWith: { githubArchived: ["me/site"], folderDeleted: true },
    });
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Unarchive “Site”?")).toBeTruthy();
    expect(within(dialog).getByText(/cloned back from GitHub into \/home\/me\/site/)).toBeTruthy();
    const box = within(dialog).getByLabelText(
      "Unarchive the GitHub repo me/site",
    ) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    fireEvent.click(within(dialog).getByRole("button", { name: /^Unarchive$/ }));
    await waitFor(() =>
      expect(archive).toHaveBeenCalledWith({ id: "P1", archived: false, unarchiveRepos: [] }),
    );
  });
});

describe("the Archived projects section", () => {
  const OLD: ProjectView = { ...SITE, id: "P2", name: "Old blog", archivedAt: 9 };

  it("lists archived projects in their own section, opened when I ask", () => {
    const onOpen = vi.fn();
    const { hook } = memoryLocation({ path: "/projects" });
    render(
      <Router hook={hook}>
        <ProjectList projects={[SITE, OLD]} onOpen={onOpen} />
      </Router>,
    );
    expect(screen.getByText("Site")).toBeTruthy();
    expect(screen.queryByText("Old blog")).toBeNull();
    const section = screen.getByRole("region", { name: "Archived projects" });
    const toggle = within(section).getByRole("button", { name: /Archived projects \(1\)/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(within(section).getByText("Old blog")).toBeTruthy();
    fireEvent.click(within(section).getByText("Old blog"));
    expect(onOpen).toHaveBeenCalledWith("P2");
    // Each card has its … menu.
    expect(screen.getByRole("button", { name: "Actions for Old blog" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Actions for Site" })).toBeTruthy();
  });

  it("is open when the project shown is archived", () => {
    const { hook } = memoryLocation({ path: "/projects/P2" });
    render(
      <Router hook={hook}>
        <ProjectList projects={[SITE, OLD]} shownId="P2" onOpen={() => {}} />
      </Router>,
    );
    expect(screen.getByText("Old blog")).toBeTruthy();
  });
});
