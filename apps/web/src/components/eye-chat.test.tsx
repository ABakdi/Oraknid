import type { Event, EyeMessage, EyeThought, JobView, SessionLogEntry } from "@oraknid/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// M13.25: The Eye's conversation as a transcript; its thinking shown, and stopped or redone.

const PROJECT = "01J9Z3K8W2Q4V6X8Y0A1B2C3P0";
const JOB = "01J9Z3K8W2Q4V6X8Y0A1B2C3J0";

let messages: EyeMessage[] = [];
let thoughts: EyeThought[] = [];
let log: SessionLogEntry[] = [];
const talk = vi.fn(async (_x: { id: string; text: string; mode?: string }) => ({
  id: "m",
  jobId: JOB,
}));
const stopThinking = vi.fn(async (_x: { id: string }) => ({ stopped: 1 }));
const cancel = vi.fn(async (_x: { id: string; reason?: string }) => undefined);

vi.mock("@/lib/api", () => ({
  api: {
    projects: {
      conversation: async () => messages,
      thinking: async () => thoughts,
      talk: (x: { id: string; text: string; mode?: string }) => talk(x),
      stopThinking: (x: { id: string }) => stopThinking(x),
      answer: async () => ({ id: "a", jobId: JOB }),
    },
    jobs: { cancel: (x: { id: string; reason?: string }) => cancel(x) },
    sessions: {
      log: async ({ after }: { after: number }) =>
        after === 0
          ? { entries: log, next: 1, live: false }
          : { entries: [], next: 1, live: false },
      list: async () => [],
    },
  },
  message: (e: unknown) => String(e),
}));

const { EyeChat, transcript } = await import("./eye-chat");
const { live } = await import("@/lib/live");

const listeners = new Set<(e: Event) => void>();
const emit = (type: string, payload: unknown = {}) =>
  act(() => {
    for (const l of listeners)
      l({ seq: 1, at: 0, type, topic: `job:${JOB}`, jobId: JOB, payload, actor: "eye" });
  });

beforeEach(() => {
  vi.spyOn(live, "on").mockImplementation((l) => {
    listeners.add(l);
    return () => listeners.delete(l);
  });
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  listeners.clear();
  vi.clearAllMocks();
  messages = [];
  thoughts = [];
  log = [];
});

const msg = (id: string, author: "owner" | "eye", text: string, at: number): EyeMessage => ({
  id,
  jobId: JOB,
  projectId: PROJECT,
  author,
  text,
  action:
    author === "eye"
      ? { intent: "task", did: ["Added a task"], silkIds: [], taskIds: [], jobId: null }
      : null,
  questions: null,
  itemId: null,
  answers: null,
  replyTo: null,
  createdAt: at,
});

const thought = (o: Partial<EyeThought> = {}): EyeThought => ({
  id: "S1",
  jobId: JOB,
  call: "plan",
  purpose: "Planning the work",
  model: "Claude · Opus",
  startedAt: 2_000,
  endedAt: 43_000,
  outcome: "done",
  summary: "Planned 9 tasks",
  again: false,
  interruptible: true,
  ...o,
});

const job = {
  id: JOB,
  projectId: PROJECT,
  title: "Notes app",
  state: "running",
  tasks: [],
} as unknown as JobView;

const show = () => render(<EyeChat projectId={PROJECT} jobs={[job]} />);

describe("The Eye's conversation as a transcript (M13.25)", () => {
  it("renders my prompts, The Eye's thinking and its replies in order, in one column", async () => {
    messages = [
      msg("A", "owner", "Build a notes app with tags", 1_000),
      msg("B", "eye", "I planned it: **9 tasks**.", 50_000),
    ];
    thoughts = [thought()];
    show();
    const box = await screen.findByTestId("transcript");
    await waitFor(() => expect(box.querySelector("[data-testid=reply]")).toBeTruthy());
    const order = [...box.querySelectorAll("[data-testid]")]
      .map((e) => e.getAttribute("data-testid"))
      .filter((x) => ["prompt", "thought", "reply"].includes(x ?? ""));
    expect(order).toEqual(["prompt", "thought", "reply"]);
    // My prompt marked like a terminal's; the reply's markdown rendered.
    const prompt = screen.getByTestId("prompt");
    expect(prompt.textContent).toContain("›");
    expect(prompt.textContent).toContain("Build a notes app with tags");
    expect(box.querySelector("[data-testid=reply] strong")?.textContent).toBe("9 tasks");
    // Folded: what came of it, its time and model.
    expect(screen.getByTestId("thought-line").textContent).toBe("Planned 9 tasks in 41 s");
    expect(screen.getByTestId("thought").textContent).toContain("Claude · Opus");
    expect(screen.queryByTestId("thought-log")).toBeNull();
  });

  it("folds three thoughts in a row that ended in passing into one line", () => {
    const quick = (id: string, at: number) =>
      thought({ id, call: "classify", interruptible: false, startedAt: at, endedAt: at + 1000 });
    const items = transcript(
      [msg("A", "owner", "go", 0)],
      [quick("c1", 10), quick("c2", 20), quick("c3", 30), thought({ startedAt: 40 })],
    );
    expect(items.map((x) => x.kind)).toEqual(["message", "thoughts", "thought"]);
  });

  it("lists my prompts in a rail by their first words, and jumps to one", async () => {
    messages = [
      msg("A", "owner", "Build a notes app with tags and full text search please", 1_000),
      msg("B", "eye", "On it.", 2_000),
      msg("C", "owner", "no, use Postgres", 3_000),
    ];
    show();
    const rail = await screen.findByTestId("prompt-rail");
    const buttons = [...rail.querySelectorAll("button")];
    expect(buttons.map((b) => b.textContent)).toEqual([
      "Build a notes app with tags…",
      "no, use Postgres",
    ]);
    // The newest prompt is the one in view at first.
    expect(buttons[1]?.getAttribute("aria-current")).toBe("true");
    fireEvent.click(buttons[0] as HTMLElement);
    const first = document.getElementById("prompt-A") as HTMLElement;
    expect(first.scrollIntoView).toHaveBeenCalledWith({ block: "start", behavior: "smooth" });
    expect(buttons[0]?.getAttribute("aria-current")).toBe("true");
    // On a phone, the same list behind a small button.
    expect(screen.getByRole("button", { name: "Jump to a prompt" }).textContent).toContain(
      "2 prompts",
    );
  });

  it("shows a thought live, what it thinks as it comes, then folds it when it ends", async () => {
    messages = [msg("A", "owner", "Build a notes app", 1_000)];
    thoughts = [thought({ outcome: "thinking", endedAt: null, summary: null })];
    log = [
      { at: 1, kind: "thinking", text: "Storage first, then the editor." },
      { at: 2, kind: "tool", tool: "Read", text: "package.json" },
      { at: 3, kind: "text", text: '```json\n{"summary":' },
    ];
    show();
    expect((await screen.findByTestId("thought-line")).textContent).toBe("Planning the work…");
    const open = await screen.findByTestId("thought-log");
    await waitFor(() => expect(open.textContent).toContain("Storage first, then the editor."));
    expect(open.textContent).toContain("→ Read package.json");
    expect(screen.getByRole("button", { expanded: true })).toBeTruthy();

    thoughts = [thought()];
    emit("eye.thinking.ended", thoughts[0]);
    await waitFor(() =>
      expect(screen.getByTestId("thought-line").textContent).toBe("Planned 9 tasks in 41 s"),
    );
    expect(screen.queryByTestId("thought-log")).toBeNull();
    // Opened again on demand.
    fireEvent.click(screen.getByRole("button", { name: /Planned 9 tasks/ }));
    await waitFor(() =>
      expect(screen.getByTestId("thought-log").textContent).toContain("Storage first"),
    );
  });

  it("while it thinks: Stop, and a message that redoes it or is added as context", async () => {
    messages = [msg("A", "owner", "Build a notes app", 1_000)];
    thoughts = [thought({ outcome: "thinking", endedAt: null, summary: null })];
    show();
    const bar = await screen.findByTestId("thinking-bar");
    expect(bar.textContent).toContain("The Eye is planning the work…");
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(stopThinking).toHaveBeenCalledWith({ id: PROJECT }));

    // A correction: stop and redo, by default.
    const box = screen.getByLabelText("Message to The Eye");
    fireEvent.change(box, { target: { value: "no, use Postgres" } });
    const redo = () => screen.getByRole("radio", { name: "Stop and redo with this" });
    expect((redo() as HTMLInputElement).checked).toBe(true);
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() =>
      expect(talk).toHaveBeenLastCalledWith({
        id: PROJECT,
        text: "no, use Postgres",
        mode: "redo",
      }),
    );

    // Anything else is added as context, by default; I can choose the other.
    fireEvent.change(box, { target: { value: "also add dark mode" } });
    expect(
      (screen.getByRole("radio", { name: "Add as context" }) as HTMLInputElement).checked,
    ).toBe(true);
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() =>
      expect(talk).toHaveBeenLastCalledWith({
        id: PROJECT,
        text: "also add dark mode",
        mode: "context",
      }),
    );
    fireEvent.change(box, { target: { value: "make it a CLI" } });
    fireEvent.click(redo());
    fireEvent.click(screen.getByRole("button", { name: "Stop and redo with this" }));
    await waitFor(() =>
      expect(talk).toHaveBeenLastCalledWith({ id: PROJECT, text: "make it a CLI", mode: "redo" }),
    );
  });

  it("with nothing thinking, sends as before and shows no Stop", async () => {
    messages = [msg("A", "owner", "Build a notes app", 1_000), msg("B", "eye", "Done.", 2_000)];
    show();
    await screen.findByTestId("transcript");
    expect(screen.queryByTestId("thinking-bar")).toBeNull();
    const box = screen.getByLabelText("Message to The Eye");
    fireEvent.change(box, { target: { value: "no, use Postgres" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(talk).toHaveBeenLastCalledWith({
        id: PROJECT,
        text: "no, use Postgres",
        mode: "auto",
      }),
    );
  });
});

describe("cancelling from the chat", () => {
  const second = {
    ...job,
    id: "01J9Z3K8W2Q4V6X8Y0A1B2C3J1",
    title: "Dark mode",
    state: "paused",
  } as JobView;

  it("cancels the job the conversation is about, after a short confirm", async () => {
    messages = [msg("A", "owner", "Build a notes app", 1_000)];
    show();
    await screen.findByTestId("transcript");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Cancel “Notes app”?");
    expect(dialog.textContent).toContain("The work so far stays in its folder");
    // Keep it: nothing happens.
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(cancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel the job" }));
    await waitFor(() =>
      expect(cancel).toHaveBeenCalledWith({ id: JOB, reason: "Cancelled from the chat." }),
    );
  });

  it("with several jobs going, a small menu picks which", async () => {
    messages = [msg("A", "owner", "Build a notes app", 1_000)];
    render(<EyeChat projectId={PROJECT} jobs={[job, second]} />);
    await screen.findByTestId("transcript");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const menu = await screen.findByRole("menu", { name: "Which job to cancel" });
    expect([...menu.querySelectorAll("[role=menuitem]")].map((x) => x.textContent)).toEqual([
      "Notes apprunning",
      "Dark modepaused",
    ]);
    fireEvent.click(screen.getByRole("menuitem", { name: /Dark mode/ }));
    expect((await screen.findByRole("dialog")).textContent).toContain("Cancel “Dark mode”?");
    fireEvent.click(screen.getByRole("button", { name: "Cancel the job" }));
    await waitFor(() =>
      expect(cancel).toHaveBeenCalledWith({ id: second.id, reason: "Cancelled from the chat." }),
    );
  });

  it("shows no Cancel when no job is going, and no form for a question its ended job withdrew", async () => {
    messages = [
      {
        ...msg("A", "eye", "I'm waiting for you: **Approve what will change on vps**", 1_000),
        itemId: "01J9Z3K8W2Q4V6X8Y0A1B2C3I0",
        questions: [
          {
            id: "choice",
            shape: "single",
            prompt: "Approve?",
            options: [
              { id: "o1", label: "Approve" },
              { id: "o2", label: "Deny" },
            ],
            recommended: null,
            allowOther: false,
          },
        ],
      },
    ];
    render(<EyeChat projectId={PROJECT} jobs={[{ ...job, state: "cancelled" } as JobView]} />);
    await screen.findByTestId("transcript");
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(screen.getByText("No longer asked: the job has ended.")).toBeTruthy();
    expect(screen.queryByText("Approve?")).toBeNull();
  });

  it("links where it took my request: the server's chat and the job started there", async () => {
    messages = [
      msg("A", "owner", "remove misahaty", 1_000),
      {
        ...msg("B", "eye", "**misahaty** runs on spinet-staging. I've taken this there.", 2_000),
        action: {
          intent: "task",
          did: ["Taken to spinet-staging's chat"],
          silkIds: [],
          taskIds: [],
          jobId: "01J9Z3K8W2Q4V6X8Y0A1B2C3J9",
          place: { kind: "server", id: "S1", name: "spinet-staging", projectId: "P9" },
        },
      },
    ];
    show();
    const there = await screen.findByRole("link", { name: "spinet-staging's chat" });
    expect(there.getAttribute("href")).toBe("/servers/S1/chat");
    expect(screen.getByRole("link", { name: "Open “the new job”" }).getAttribute("href")).toBe(
      "/jobs/01J9Z3K8W2Q4V6X8Y0A1B2C3J9",
    );
  });
});
