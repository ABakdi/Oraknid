import type { InboxItem, JobView } from "@oraknid/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

// The command palette (Web-UI → Layout): jump to anything, run any control,
// fuzzy, with recent items; cancelling asks a second time.

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
HTMLElement.prototype.scrollIntoView = () => {};

const calls: string[] = [];
vi.mock("@/lib/api", () => ({
  api: {
    jobs: {
      pause: async (x: { id: string }) => calls.push(`pause ${x.id}`),
      resume: async (x: { id: string }) => calls.push(`resume ${x.id}`),
      cancel: async (x: { id: string }) => calls.push(`cancel ${x.id}`),
    },
    inbox: {
      answer: async (x: { id: string; answer: string }) => calls.push(`answer ${x.id} ${x.answer}`),
    },
    updates: {
      check: async () => {
        calls.push("check");
        return { error: null, available: false, version: "0.3.1", target: null };
      },
    },
  },
  message: (e: unknown) => String(e),
}));

const { CommandPalette, paletteEntries, NO_DATA, GROUPS } = await import("./command-palette");

const job = (id: string, title: string, state: string, more: Partial<JobView> = {}) =>
  ({ id, title, state, projectId: "P1", description: null, ...more }) as unknown as JobView;
const approval = {
  id: "I1",
  kind: "approval",
  state: "open",
  title: "Run npm install",
  options: ["Approve", "Deny"],
  projectName: "Piano",
  jobTitle: "Build the piano",
} as unknown as InboxItem;

const DATA = {
  ...NO_DATA,
  jobs: [
    job("J1", "Build the piano", "running", { description: "A small piano in the browser" }),
    job("J2", "Fix the site", "paused"),
  ],
  projects: [{ id: "P1", name: "Piano", workspacePath: "/home/me/Dev/piano" }],
  servers: [{ id: "S1", name: "Staging", host: "10.0.0.2" }],
  legs: [{ id: "L1", name: "Claude", kind: "claude-code" }],
  chats: [{ id: "C1", title: "Rust lifetimes", modelLabel: "Claude · opus" }],
  skills: [{ id: "K1", name: "Write a website", description: "A static site" }],
  inbox: [approval],
  models: [{ id: "M1", name: "qwen3-8b", repo: "Qwen/Qwen3-8B-GGUF" }],
  repos: [{ owner: "me", name: "piano", fullName: "me/piano", description: null }],
} as never;
const PAGES = [
  { href: "/", label: "Overview" },
  { href: "/settings", label: "Settings" },
];

beforeEach(() => {
  calls.length = 0;
  localStorage.clear();
});
afterEach(cleanup);

describe("what the palette offers", () => {
  it("has every kind of place and the controls", () => {
    const entries = paletteEntries(DATA, PAGES);
    const groups = new Set(entries.map((e) => e.group));
    for (const g of GROUPS.filter((g) => g !== "Recent")) expect(groups).toContain(g);
    const labels = entries.filter((e) => e.group === "Controls").map((e) => e.label);
    expect(labels).toEqual(
      expect.arrayContaining([
        "New work",
        "New chat",
        "Open the terminal",
        "Check for updates",
        "Pause “Build the piano”",
        "Cancel “Build the piano”",
        "Resume “Fix the site”",
        "Cancel “Fix the site”",
        "Approve: Run npm install",
        "Deny: Run npm install",
      ]),
    );
    const href = (key: string) => entries.find((e) => e.key === key)?.href;
    expect(href("job:J1")).toBe("/projects/P1/work/J1");
    expect(href("server:S1")).toBe("/servers/S1");
    expect(href("chat:C1")).toBe("/chats/C1");
    expect(href("leg:L1")).toBe("/legs/L1");
    expect(href("skill:K1")).toBe("/skills/K1");
    expect(href("inbox:I1")).toBe("/inbox/I1");
    expect(href("model:M1")).toBe("/models");
    expect(href("repo:me/piano")).toBe("/repos/me/piano");
    expect(href("guide:getting-started")).toBe("/docs/getting-started");
    // An ended job has nothing to pause or cancel.
    const ended = paletteEntries({ ...NO_DATA, jobs: [job("J3", "Old", "completed")] }, []);
    expect(ended.filter((e) => e.group === "Controls").map((e) => e.key)).not.toContain(
      "cancel:J3",
    );
  });
});

function open(load = async () => DATA) {
  const { hook, history } = memoryLocation({ path: "/", record: true });
  const onOpenChange = vi.fn();
  render(
    <Router hook={hook}>
      <CommandPalette open onOpenChange={onOpenChange} pages={PAGES} load={load} />
    </Router>,
  );
  return { history, onOpenChange, input: screen.getByRole("combobox") };
}

describe("the palette", () => {
  it("finds a job by a fuzzy query, by its description too, and goes to it", async () => {
    const { history, input } = open();
    fireEvent.change(input, { target: { value: "bld pno" } });
    const item = await screen.findByText("Build the piano", { selector: "span" });
    fireEvent.click(item);
    expect(history.at(-1)).toBe("/projects/P1/work/J1");
    cleanup();
    open();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "browser" } });
    expect(await screen.findByText("A small piano in the browser · running")).toBeTruthy();
  });

  it("lists what I opened lately when nothing is typed", async () => {
    const first = open();
    fireEvent.change(first.input, { target: { value: "staging" } });
    fireEvent.click(await screen.findByText("Staging"));
    cleanup();
    open();
    const recent = await screen.findByText("Recent");
    expect(recent).toBeTruthy();
    expect(screen.getByText("Staging")).toBeTruthy();
  });

  it("runs a control: pausing a job, answering an approval, checking for updates", async () => {
    const { input } = open();
    fireEvent.change(input, { target: { value: "pause build" } });
    fireEvent.click(await screen.findByText("Pause “Build the piano”"));
    fireEvent.change(input, { target: { value: "deny npm" } });
    fireEvent.click(await screen.findByText("Deny: Run npm install"));
    fireEvent.change(input, { target: { value: "updates" } });
    fireEvent.click(await screen.findByText("Check for updates"));
    await waitFor(() => expect(calls).toEqual(["pause J1", "answer I1 Deny", "check"]));
  });

  it("asks a second time before cancelling a job", async () => {
    const { input, onOpenChange } = open();
    fireEvent.change(input, { target: { value: "cancel fix" } });
    fireEvent.click(await screen.findByText("Cancel “Fix the site”"));
    expect(calls).toEqual([]);
    expect(
      screen.getByText(
        "Cancel “Fix the site”? Its running tasks stop and it can't be started again.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByText("No, go back"));
    expect(calls).toEqual([]);
    fireEvent.click(await screen.findByText("Cancel “Fix the site”"));
    fireEvent.click(screen.getByText("Yes, Cancel “Fix the site”"));
    await waitFor(() => expect(calls).toEqual(["cancel J2"]));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
