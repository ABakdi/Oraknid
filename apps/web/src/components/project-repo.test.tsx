import type { GitHubLink, ProjectRepo, ProjectView, ServerView } from "@oraknid/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

// ADR-042: a project of several repos on its Repo tab, and its servers with their roles.

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const link = (name: string, ready = true): GitHubLink => ({
  account: "me",
  owner: "me",
  name,
  visibility: "private",
  origin: "existing",
  ready,
  linkedAt: 1,
});

const repo = (name: string, github: GitHubLink | null): ProjectRepo => ({
  name,
  folder: name,
  releaseBranch: "main",
  workBranch: "dev",
  github,
});

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
  skillIds: [],
  serverIds: ["S1", "S2"],
  serverRoles: {
    S1: { role: "staging", production: null },
    S2: { role: "production", production: null },
  },
  repos: [repo("api", link("site-api", false)), repo("web", link("site"))],
  github: null,
  serverId: null,
  jobCount: 0,
};

const server = (id: string, name: string): ServerView =>
  ({
    id,
    name,
    host: `${name}.example.com`,
    port: 22,
    user: "deploy",
    setup: "ready",
    busy: null,
  }) as unknown as ServerView;

const addRepo = vi.fn(async (x: { source: { folder: string } }) => ({
  ...SITE,
  repos: [...SITE.repos, repo(x.source.folder, null)],
}));
const detectRepos = vi.fn(async () => [...SITE.repos, repo("admin", null)]);
const removeRepo = vi.fn(async () => SITE);
const updateRepo = vi.fn(async (_: unknown) => SITE);
const setGitHub = vi.fn(async () => {});
const setServerRole = vi.fn(async (_: unknown) => {});
const repoInfo = vi.fn(async (x: { owner: string; name: string }) => ({
  account: "me",
  owner: x.owner,
  name: x.name,
  fullName: `${x.owner}/${x.name}`,
  visibility: "private",
  defaultBranch: "main",
  pushedAt: null,
  description: null,
  url: `https://github.com/${x.owner}/${x.name}`,
  empty: false,
}));

vi.mock("@/lib/api", () => ({
  api: {
    github: {
      accounts: async () => [{ login: "me", error: null }],
      repoInfo: (x: { owner: string; name: string }) => repoInfo(x),
      commits: async () => ({ items: [], page: 1, next: false }),
      branches: async () => ({ items: [{ name: "main" }], page: 1, next: false }),
      pulls: async () => ({ items: [], page: 1, next: false }),
    },
    projects: {
      list: async () => [SITE],
      addRepo: (x: { source: { folder: string } }) => addRepo(x),
      detectRepos: () => detectRepos(),
      removeRepo: () => removeRepo(),
      updateRepo: (x: unknown) => updateRepo(x),
      setGitHub: () => setGitHub(),
      setServers: async () => {},
      setServerRole: (x: unknown) => setServerRole(x),
    },
    servers: {
      list: async () => [server("S1", "vps-1"), server("S2", "vps-2"), server("S3", "box")],
    },
  },
  message: (e: unknown) => String(e),
}));

const { ProjectRepoTab } = await import("./project-repo");
const { ProjectServersCard } = await import("./project-servers");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const inRouter = (node: React.ReactNode) => {
  const { hook } = memoryLocation({ path: "/projects/P1/repo" });
  return render(<Router hook={hook}>{node}</Router>);
};

describe("a project's Repo tab with two repos (ADR-042)", () => {
  it("lists each repo with its folder, branches and link, and shows each one's GitHub", async () => {
    inRouter(<ProjectRepoTab project={SITE} />);
    const card = screen
      .getByText("Its repos")
      .closest("[data-help='project.repos']") as HTMLElement;
    const rows = within(card).getAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringMatching(/^apiapi\/main \/ devme\/site-api/),
      expect.stringMatching(/^webweb\/main \/ devme\/site/),
    ]);
    // One section per repo, each with its own link card.
    const sections = document.querySelectorAll("[data-help='project.repo-each']");
    expect(sections).toHaveLength(2);
    expect(await within(sections[0] as HTMLElement).findByText("GitHub repo of api")).toBeTruthy();
    expect(within(sections[0] as HTMLElement).getByText("Not created yet")).toBeTruthy();
    expect(within(sections[1] as HTMLElement).getByText("GitHub repo of web")).toBeTruthy();
    // What's on web's GitHub repo, read for that repo only.
    await waitFor(() =>
      expect(repoInfo).toHaveBeenCalledWith(expect.objectContaining({ name: "site" })),
    );
    expect(repoInfo).not.toHaveBeenCalledWith(expect.objectContaining({ name: "site-api" }));
    expect(
      (
        await within(sections[1] as HTMLElement).findByRole("link", { name: "Browse the code" })
      ).getAttribute("href"),
    ).toBe("/repos/me/site");
  });

  it("adds a repo (a new one, a clone) and finds repos again", async () => {
    inRouter(<ProjectRepoTab project={SITE} />);
    fireEvent.click(screen.getByRole("button", { name: /Find repos in its folder/ }));
    await waitFor(() => expect(detectRepos).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: /Add a repo/ }));
    fireEvent.change(screen.getByLabelText("Folder in the project"), {
      target: { value: "docs/" },
    });
    fireEvent.change(screen.getByLabelText("Its name in the project"), {
      target: { value: "site-docs" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(addRepo).toHaveBeenCalledWith({
        id: "P1",
        name: "site-docs",
        source: { kind: "folder", folder: "docs" },
      }),
    );
  });

  it("renames a repo and changes its branches, sending only what changed", async () => {
    inRouter(<ProjectRepoTab project={SITE} />);
    fireEvent.click(screen.getByRole("button", { name: "Change api" }));
    const dialog = screen.getByRole("dialog");
    const save = within(dialog).getByRole("button", { name: "Save" }) as HTMLButtonElement;
    // Nothing changed yet: nothing to save.
    expect(save.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Its name in the project"), {
      target: { value: "backend" },
    });
    fireEvent.change(within(dialog).getByLabelText("Work branch"), {
      target: { value: " develop " },
    });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() =>
      expect(updateRepo).toHaveBeenCalledWith({
        id: "P1",
        name: "api",
        rename: "backend",
        workBranch: "develop",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("says why a change is refused and keeps the dialog open", async () => {
    updateRepo.mockRejectedValueOnce(new Error("bad..name isn't a branch name git accepts."));
    inRouter(<ProjectRepoTab project={SITE} />);
    fireEvent.click(screen.getByRole("button", { name: "Change web" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Release branch"), {
      target: { value: "bad..name" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText(/isn't a branch name/)).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("keeps a project of one repo as it was, with its repo below", async () => {
    const one: ProjectView = {
      ...SITE,
      repos: [{ ...repo("piano", link("piano")), folder: "" }],
      github: link("piano"),
    };
    inRouter(<ProjectRepoTab project={one} />);
    expect(document.querySelectorAll("[data-help='project.repo-each']")).toHaveLength(0);
    expect(await screen.findByText("GitHub repo")).toBeTruthy();
    expect(screen.getByText("Its repo")).toBeTruthy();
    expect(screen.getByText("the project's folder")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Take piano out/ })).toBeNull();
    // Its branches can still be changed.
    expect(screen.getByRole("button", { name: "Change piano" })).toBeTruthy();
  });
});

describe("a project's servers with their roles (ADR-042)", () => {
  it("shows each ticked server's role, production marked, and saves a role or a mark", async () => {
    inRouter(<ProjectServersCard projectId="P1" />);
    const staging = (await screen.findByLabelText(
      "Role of vps-1 in this project",
    )) as HTMLInputElement;
    expect(staging.value).toBe("staging");
    const prod = screen.getByLabelText("Role of vps-2 in this project") as HTMLInputElement;
    expect(prod.value).toBe("production");
    // Production by its name: marked, and said.
    const marks = screen.getAllByRole("checkbox", { name: "Production" }) as HTMLInputElement[];
    expect(marks.map((m) => m.checked)).toEqual([false, true]);
    expect(screen.getByText("live")).toBeTruthy();
    // A server not ticked has no role.
    expect(screen.queryByLabelText("Role of box in this project")).toBeNull();
    fireEvent.change(staging, { target: { value: "testing" } });
    fireEvent.blur(staging);
    await waitFor(() =>
      expect(setServerRole).toHaveBeenCalledWith({
        id: "P1",
        serverId: "S1",
        role: { role: "testing", production: null },
      }),
    );
    fireEvent.click(marks[0] as HTMLInputElement);
    await waitFor(() =>
      expect(setServerRole).toHaveBeenCalledWith({
        id: "P1",
        serverId: "S1",
        role: { role: "testing", production: true },
      }),
    );
  });
});
