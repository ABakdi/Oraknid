import type { EyeMessage, InboxItem, JobView, ServerView } from "@oraknid/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Route, Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

// A server's Chat and Jobs tabs (ADR-049): The Eye answers about the
// server or sends an agent into it; the jobs that worked there.

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView ??= () => {};
globalThis.IntersectionObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
} as unknown as typeof IntersectionObserver;

const now = Date.now();
const SERVER: ServerView = {
  id: "S1",
  name: "vps",
  host: "203.0.113.9",
  port: 22,
  user: "deploy",
  description: "My sites.",
  auth: "oraknid-key",
  setup: "ready",
  hostKey: "SHA256:x",
  hostKeyOffered: null,
  lastSeenAt: now,
  error: null,
  stale: false,
  busy: null,
  stateVersion: 2,
  latest: null,
  projectIds: [],
  projectId: "P9",
  production: true,
  productionIn: [],
  createdAt: now,
};

const JOB = {
  id: "J1",
  projectId: "P9",
  title: "Install fail2ban",
  description: null,
  state: "running",
  tasks: [],
  tokens: { input: 0, output: 0 },
  startedAt: now,
  branch: null,
  blockedReason: null,
  pauseReason: null,
  queuedAt: null,
} as unknown as JobView;

const message = (m: Partial<EyeMessage>): EyeMessage => ({
  id: "M",
  jobId: null,
  projectId: "P9",
  author: "eye",
  text: "",
  action: null,
  questions: null,
  itemId: null,
  answers: null,
  replyTo: null,
  createdAt: now,
  ...m,
});

const MESSAGES: EyeMessage[] = [
  message({ id: "M1", author: "owner", text: "What runs on it?" }),
  message({
    id: "M2",
    text: "Nginx and two Node apps.",
    action: {
      intent: "question",
      did: ["Answered from the state document"],
      silkIds: [],
      taskIds: [],
      jobId: null,
    },
  }),
  message({ id: "M3", author: "owner", text: "install fail2ban", jobId: "J1" }),
  message({
    id: "M4",
    jobId: "J1",
    text: "I started a job on vps for it, “Install fail2ban”.",
    action: {
      intent: "task",
      did: ["Started a job on the server"],
      silkIds: [],
      taskIds: [],
      jobId: "J1",
    },
  }),
];

const ITEM = {
  id: "I1",
  kind: "approval",
  jobId: "J1",
  projectId: "P9",
  projectName: "vps",
  jobTitle: "Install fail2ban",
  taskId: null,
  taskTitle: null,
  title: "Approve what will change on vps",
  detail: "- **Install fail2ban**",
  options: ["Approve", "Deny"],
  defaultOption: null,
  questions: null,
  state: "open",
  answer: null,
  answers: null,
  createdAt: now,
} as unknown as InboxItem;

const talked: unknown[] = [];
const cancelled: unknown[] = [];

vi.mock("@/lib/api", () => ({
  message: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  api: {
    servers: {
      list: async () => [SERVER],
      samples: async () => [],
      history: async () => [],
      state: async () => ({
        version: 2,
        body: "# vps",
        source: "eye",
        jobId: null,
        createdAt: now,
      }),
      conversation: async () => MESSAGES,
      talk: async (x: unknown) => {
        talked.push(x);
        return { id: "M5", jobId: null, projectId: "P9" };
      },
      setProduction: async () => SERVER,
    },
    projects: { thinking: async () => [], stopThinking: async () => ({ stopped: 0 }) },
    sessions: { list: async () => [], log: async () => [] },
    jobs: {
      list: async () => [JOB],
      cancel: async (x: unknown) => {
        cancelled.push(x);
      },
    },
    inbox: { list: async () => [ITEM], answer: async () => ({}) },
    settings: { terminal: async () => false },
    lock: { status: async () => ({ full: false }) },
  },
}));

afterEach(() => {
  cleanup();
  talked.length = 0;
});

async function open(path: string) {
  const { ServersPage } = await import("@/pages/servers");
  const { hook } = memoryLocation({ path });
  render(
    <Router hook={hook}>
      <Route path="/servers/:id?/:tab?">{(p) => <ServersPage id={p.id} tab={p.tab} />}</Route>
    </Router>,
  );
}

describe("a server's Chat and Jobs (ADR-049)", { timeout: 30_000 }, () => {
  it("puts Chat right after Overview, and says the server is production", async () => {
    await open("/servers/S1");
    const tabs = await screen.findAllByRole("tab");
    expect(tabs.slice(0, 3).map((x) => x.textContent)).toEqual(["Overview", "Chat", "Jobs"]);
    expect(screen.getByText("production")).toBeTruthy();
    expect(
      (screen.getByRole("switch", { name: "Production" }) as HTMLElement).getAttribute(
        "aria-checked",
      ),
    ).toBe("true");
  });

  it("shows the conversation, a question answered with no job, and sends my message to the server", async () => {
    await open("/servers/S1/chat");
    expect(await screen.findByText("Nginx and two Node apps.")).toBeTruthy();
    expect(screen.getByText("· Answered from the state document")).toBeTruthy();
    // The job a message started is linked; the answer with no job isn't.
    expect(screen.getAllByRole("link", { name: "Install fail2ban" }).length).toBeGreaterThan(0);
    const box = screen.getByRole("textbox", { name: "Message to The Eye" });
    fireEvent.change(box, { target: { value: "rotate the logs of app y" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(talked).toEqual([{ id: "S1", text: "rotate the logs of app y" }]));
  });

  it("cancels the server job from its chat, without answering its approval", async () => {
    await open("/servers/S1/chat");
    await screen.findByText("Nginx and two Node apps.");
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Cancel “Install fail2ban”?");
    fireEvent.click(screen.getByRole("button", { name: "Cancel the job" }));
    await waitFor(() =>
      expect(cancelled).toEqual([{ id: "J1", reason: "Cancelled from the chat." }]),
    );
  });

  it("lists the server's jobs and what they wait on", async () => {
    await open("/servers/S1/jobs");
    expect(await screen.findByText("Jobs on vps")).toBeTruthy();
    expect(screen.getAllByText("Install fail2ban").length).toBeGreaterThan(0);
    expect(screen.getByText("Waiting for you")).toBeTruthy();
    expect(screen.getByText("Approve what will change on vps")).toBeTruthy();
  });
});
