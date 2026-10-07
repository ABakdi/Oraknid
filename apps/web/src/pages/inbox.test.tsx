import type { InboxItem } from "@oraknid/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

// The inbox's filters (Web-UI → Inbox): project, job, kind, state, and a
// search over the text.

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const item = (id: string, more: Partial<InboxItem>): InboxItem =>
  ({
    id,
    kind: "question",
    state: "open",
    title: `Item ${id}`,
    detail: "",
    options: [],
    questions: null,
    answer: null,
    jobId: "J1",
    jobTitle: "Build the piano",
    projectId: "P1",
    projectName: "Piano",
    taskTitle: null,
    createdAt: 1,
    ...more,
  }) as unknown as InboxItem;

const ITEMS = [
  item("A", { kind: "approval", title: "Run npm install", options: ["Approve", "Deny"] }),
  item("B", { title: "Which colour?", detail: "The keys: ivory or white" }),
  item("C", { state: "answered", title: "Which font?", answer: "Plex" }),
  item("D", { state: "withdrawn", title: "Deploy now?", jobId: "J2", jobTitle: "Ship the site" }),
  item("E", { state: "expired", title: "Old question", projectId: "P2", projectName: "Site" }),
];

vi.mock("@/lib/api", () => ({
  api: { inbox: { list: async () => ITEMS } },
  message: (e: unknown) => String(e),
}));
vi.mock("@/lib/live", () => ({
  useLive: () => ({ data: ITEMS, loading: false, error: null, reload: () => {} }),
}));

const { filterInbox, InboxPage, NO_FILTERS } = await import("./inbox");

afterEach(cleanup);

const ids = (f: Partial<typeof NO_FILTERS>, focus?: string) =>
  filterInbox(ITEMS, { ...NO_FILTERS, ...f }, focus).map((i) => i.id);

describe("filtering the inbox", () => {
  it("keeps open items by default, and each state when asked", () => {
    expect(ids({})).toEqual(["A", "B"]);
    expect(ids({ state: "answered" })).toEqual(["C"]);
    expect(ids({ state: "withdrawn" })).toEqual(["D"]);
    expect(ids({ state: "expired" })).toEqual(["E"]);
    expect(ids({ state: "all" })).toEqual(["A", "B", "C", "D", "E"]);
  });

  it("by project, job, kind and words in the text", () => {
    expect(ids({ state: "all", project: "P2" })).toEqual(["E"]);
    expect(ids({ state: "all", job: "J2" })).toEqual(["D"]);
    expect(ids({ kind: "approval" })).toEqual(["A"]);
    expect(ids({ q: "ivory" })).toEqual(["B"]);
    expect(ids({ state: "all", q: "plex font" })).toEqual(["C"]);
  });

  it("always keeps the item I came to see", () => {
    expect(ids({ kind: "approval" }, "C")).toEqual(["A", "C"]);
  });
});

describe("the inbox page", () => {
  it("has a state filter beside project, job and kind, and offers the answered ones", () => {
    const { hook } = memoryLocation({ path: "/inbox" });
    render(
      <Router hook={hook}>
        <InboxPage />
      </Router>,
    );
    for (const name of ["Project", "Job", "Kind", "State"])
      expect(screen.getByRole("combobox", { name })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "State" }).textContent).toContain("Open");
    expect(screen.getByText("Run npm install")).toBeTruthy();
    expect(screen.queryByText("Which font?")).toBeNull();
    expect(screen.getByRole("button", { name: "Show answered (3)" })).toBeTruthy();
  });
});
