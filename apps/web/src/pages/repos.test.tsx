import type { GitHubFileChange, GitHubRepoDetail, GitHubRepoSummary } from "@oraknid/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Route, Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

// Repos (ADR-040): the list, a repository's tabs in the address, a diff.

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const repo = (fullName: string, more: Partial<GitHubRepoSummary> = {}): GitHubRepoSummary => {
  const [owner = "", name = ""] = fullName.split("/");
  return {
    account: "me",
    owner,
    name,
    fullName,
    visibility: "public",
    defaultBranch: "main",
    pushedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    description: null,
    archived: false,
    fork: false,
    url: `https://github.com/${fullName}`,
    project: null,
    ...more,
  };
};

const REPOS = [
  repo("me/piano", {
    description: "A small piano in the browser",
    project: { id: "P1", name: "Piano" },
  }),
  repo("acme/site", { account: "work", visibility: "private", defaultBranch: "trunk" }),
  repo("me/empty", { visibility: "private", pushedAt: null }),
];

const PIANO: GitHubRepoDetail = {
  ...(REPOS[0] as GitHubRepoSummary),
  stars: 7,
  openIssues: 1,
  empty: false,
};

const PATCH = `@@ -1,3 +1,4 @@
 import { tune } from "./tune";
-export function play(notes) {
+export function play(notes: string[]) {
+  // A beat each.
   tune(notes);`;

const calls: string[] = [];
const fn =
  <T,>(name: string, value: (x: Record<string, unknown>) => T) =>
  async (x: Record<string, unknown> = {}) => {
    calls.push(`${name} ${JSON.stringify(x)}`);
    return value(x);
  };

vi.mock("@/lib/api", () => ({
  api: {
    github: {
      accounts: fn("accounts", () => [
        { login: "me", error: null },
        { login: "work", error: null },
      ]),
      limits: fn("limits", () => []),
      repoList: fn("repoList", (x) => ({
        repos: x.account ? REPOS.filter((r) => r.account === x.account) : REPOS,
        errors: [],
        truncated: false,
      })),
      repoInfo: fn("repoInfo", () => PIANO),
      branches: fn("branches", () => ({
        items: [
          { name: "main", sha: "a", protected: true },
          { name: "feature/keys", sha: "b", protected: false },
        ],
        page: 1,
        next: false,
      })),
      tree: fn("tree", () => ({
        ref: "main",
        path: "",
        truncated: false,
        entries: [
          { name: "src", path: "src", type: "dir", size: null },
          { name: "README.md", path: "README.md", type: "file", size: 40 },
        ],
      })),
      readme: fn("readme", () => ({
        path: "README.md",
        ref: "main",
        size: 40,
        text: "# Piano\n\nA small piano.",
        binary: false,
        tooLarge: false,
        url: "https://github.com/me/piano/blob/main/README.md",
      })),
      commits: fn("commits", (x) => ({
        items: [
          {
            sha: "c0ffee1234567",
            title: `Play a scale on ${String(x.branch)}`,
            author: { name: "Me", login: "me" },
            date: new Date().toISOString(),
            url: "https://github.com/me/piano/commit/c0ffee1234567",
          },
        ],
        page: 1,
        next: true,
      })),
      pulls: fn("pulls", () => ({ items: [], page: 1, next: false })),
    },
    projects: { list: fn("projects", () => []) },
  },
  message: (e: unknown) => String(e),
}));

const { ReposPage, parseRest, repoHref } = await import("./repos");
const { FileDiff, parsePatch } = await import("@/components/diff-view");
const { highlightLines, languageOf } = await import("@/lib/highlight");
const { SHORTCUTS } = await import("@/components/shell");

afterEach(() => {
  cleanup();
  calls.length = 0;
});

function at(path: string) {
  const mem = memoryLocation({ path, record: true });
  render(
    <Router hook={mem.hook}>
      <Route path="/repos/:owner?/:name?/:tab?/*?">
        {(p) => <ReposPage owner={p.owner} name={p.name} tab={p.tab} rest={p["*"]} />}
      </Route>
    </Router>,
  );
  return mem;
}

describe("Repos' addresses (ADR-040)", () => {
  it("keeps the tab and what is open in it in the address, a branch with a slash as one part", () => {
    const code = repoHref.code("me", "piano", "feature/keys", "blob", "src/my app.ts");
    expect(code).toBe("/repos/me/piano/code/feature%2Fkeys/blob/src/my%20app.ts");
    // wouter hands the rest over decoded with decodeURI: %2F stays.
    expect(parseRest("code", "feature%2Fkeys/blob/src/my app.ts")).toEqual({
      ref: "feature/keys",
      kind: "blob",
      path: "src/my app.ts",
    });
    expect(parseRest("code", "main")).toEqual({ ref: "main", kind: "tree", path: "" });
    expect(repoHref.commits("me", "piano", "dev", "abc123")).toBe(
      "/repos/me/piano/commits/dev/abc123",
    );
    expect(parseRest("commits", "dev/abc123")).toEqual({ branch: "dev", sha: "abc123" });
    expect(repoHref.pulls("me", "piano", "closed", 2)).toBe("/repos/me/piano/pulls/closed/2");
    expect(parseRest("pulls", "closed/2")).toEqual({ state: "closed", number: 2 });
    expect(parseRest("pulls", undefined)).toEqual({ state: "open", number: undefined });
  });

  it("goes to Repos with g r", () => {
    expect(SHORTCUTS).toContainEqual({ keys: "g r", does: "Repos" });
  });
});

describe("the list of repositories", () => {
  it("shows each with its visibility, default branch, last push and linking project, and searches", async () => {
    at("/repos");
    const list = await screen.findByRole("region", { name: "Repositories" });
    await waitFor(() => expect(within(list).getAllByTestId("repo-row")).toHaveLength(3));
    const piano = within(list).getAllByTestId("repo-row")[0] as HTMLElement;
    expect(piano.textContent).toContain("me/piano");
    expect(piano.textContent).toContain("Public");
    expect(piano.textContent).toContain("main");
    expect(piano.textContent).toContain("pushed 2 d ago");
    expect(piano.textContent).toContain("Piano");
    const site = within(list).getAllByTestId("repo-row")[1] as HTMLElement;
    expect(site.textContent).toContain("Private");
    expect(site.textContent).toContain("trunk");
    expect(site.textContent).toContain("work");
    expect((within(list).getAllByTestId("repo-row")[2] as HTMLElement).textContent).toContain(
      "empty",
    );
    // Search by name, description or project.
    fireEvent.change(screen.getByLabelText("Search repositories"), {
      target: { value: "browser" },
    });
    expect(within(list).getAllByTestId("repo-row")).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Search repositories"), {
      target: { value: "nothing like it" },
    });
    expect(within(list).queryAllByTestId("repo-row")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Clear the filters" }));
    expect(within(list).getAllByTestId("repo-row")).toHaveLength(3);
    // The accounts, as in Settings, beside the list on a computer.
    expect(await screen.findByText("GitHub")).toBeTruthy();
  });

  it("opens a repository at its address", async () => {
    const mem = at("/repos");
    const list = await screen.findByRole("region", { name: "Repositories" });
    await waitFor(() => expect(within(list).getAllByTestId("repo-row")).toHaveLength(3));
    fireEvent.click(within(list).getAllByTestId("repo-row")[0] as HTMLElement);
    expect(mem.history?.at(-1)).toBe("/repos/me/piano");
  });
});

describe("a repository in tabs", () => {
  it("opens Code by default: the tree at the default branch and the README", async () => {
    at("/repos/me/piano");
    expect((await screen.findByRole("tab", { name: /Code/ })).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(await screen.findByRole("link", { name: /src/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /README\.md/ }).getAttribute("href")).toBe(
      "/repos/me/piano/code/main/blob/README.md",
    );
    expect(await screen.findByRole("heading", { name: "Piano" })).toBeTruthy();
    expect(calls).toContain(
      'tree {"owner":"me","name":"piano","account":"me","ref":"main","path":""}',
    );
  });

  it("reads the tab and the branch from the address, and changing tabs changes it", async () => {
    const mem = at("/repos/me/piano/commits/feature%2Fkeys");
    expect(
      (await screen.findByRole("tab", { name: /Commits/ })).getAttribute("aria-selected"),
    ).toBe("true");
    expect(await screen.findByText("Play a scale on feature/keys")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Play a scale/ }).getAttribute("href")).toBe(
      "/repos/me/piano/commits/feature%2Fkeys/c0ffee1234567",
    );
    expect(screen.getByRole("button", { name: "Older commits" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /Pull requests/ }));
    expect(mem.history?.at(-1)).toBe("/repos/me/piano/pulls");
  });
});

describe("a diff", () => {
  const file: GitHubFileChange = {
    path: "src/app.ts",
    previousPath: null,
    status: "modified",
    additions: 2,
    deletions: 1,
    patch: PATCH,
  };

  it("numbers each line from its hunk", () => {
    expect(parsePatch(PATCH).map((l) => [l.kind, l.old, l.new])).toEqual([
      ["hunk", null, null],
      ["same", 1, 1],
      ["del", 2, null],
      ["add", null, 2],
      ["add", null, 3],
      ["same", 3, 4],
    ]);
  });

  it("shows a file's diff in its own block, added and removed lines marked and coloured", () => {
    render(<FileDiff file={file} />);
    expect(screen.getByText("src/app.ts")).toBeTruthy();
    expect(screen.getByText("+2")).toBeTruthy();
    expect(screen.getByText("−1")).toBeTruthy();
    const block = screen.getByTestId("file-diff").querySelector(".overflow-auto");
    expect(block?.className).toContain("max-h-[60vh]");
    const added = [...document.querySelectorAll('tr[data-kind="add"]')];
    const removed = [...document.querySelectorAll('tr[data-kind="del"]')];
    expect(added).toHaveLength(2);
    expect(removed).toHaveLength(1);
    expect(added[0]?.className).toContain("bg-success");
    expect(removed[0]?.className).toContain("bg-destructive");
    expect(added[0]?.textContent).toContain("+export function play(notes: string[]) {".slice(1));
    expect(removed[0]?.textContent).toContain("−");
    // Folds away.
    fireEvent.click(screen.getByRole("button", { expanded: true }));
    expect(document.querySelectorAll("tr")).toHaveLength(0);
  });

  it("says when a file has no diff to show", () => {
    render(<FileDiff file={{ ...file, path: "logo.png", patch: null }} />);
    expect(screen.getByText(/No diff to show/)).toBeTruthy();
  });
});

describe("syntax colouring", () => {
  it("knows a file's language by its name", () => {
    expect(languageOf("src/app.ts")).toBe("typescript");
    expect(languageOf("Dockerfile")).toBe("bash");
    expect(languageOf("notes.txt")).toBeNull();
  });

  it("gives one line of HTML per line, a comment across lines coloured on each, the text escaped", () => {
    const lines = highlightLines("/* a\n<b> */\nconst x = 1;\n", "typescript");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^<span class="hljs-comment">\/\* a<\/span>$/);
    expect(lines[1]).toBe('<span class="hljs-comment">&lt;b&gt; */</span>');
    expect(lines[2]).toContain('<span class="hljs-keyword">const</span>');
    expect(highlightLines("<script>", null)).toEqual(["&lt;script&gt;"]);
  });
});
