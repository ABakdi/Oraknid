import type { ReviewDetail, ReviewNote } from "@oraknid/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

// The review page (ADR-064, Web-UI → The review page): the frame at a
// device's size, select → composer → a saved note with its selector,
// pins sent to the overlay, Send notes and Approve.

const R = "01J00000000000000000000001";
const J = "01J00000000000000000000002";
const P = "01J00000000000000000000003";

const note = (over: Partial<ReviewNote>): ReviewNote => ({
  id: "01J00000000000000000000010",
  reviewId: R,
  round: 1,
  kind: "change",
  text: "Bigger knobs",
  device: { name: "Laptop", width: 1440, height: 900, orientation: "landscape" },
  element: {
    selector: "#knob",
    text: "Cutoff",
    tag: "div",
    box: { x: 1, y: 2, width: 3, height: 4 },
  },
  page: "/",
  hasScreenshot: false,
  console: [],
  requests: [],
  source: "page",
  createdAt: 1,
  editedAt: null,
  ...over,
});

let review: ReviewDetail;
const fresh = (notes: ReviewNote[] = []): ReviewDetail => ({
  id: R,
  jobId: J,
  taskId: null,
  projectId: P,
  projectName: "Keys",
  jobTitle: "A synth",
  title: "The design",
  kind: "design",
  target: "/home/me/keys/design",
  entry: "/",
  round: 1,
  state: "open",
  frameUrl: "http://rv-abc.localhost:7517/",
  noteCount: notes.length,
  createdAt: 1,
  updatedAt: 1,
  endedAt: null,
  notes,
});

const add = vi.fn(async (x: { text: string }) =>
  note({ id: "01J00000000000000000000011", text: x.text }),
);
const sendNotes = vi.fn(async (_: unknown) => ({ round: 1, notes: 1 }));
const approve = vi.fn(async (_: unknown) => ({ ok: true }));

vi.mock("@/lib/api", () => ({
  api: {
    reviews: {
      get: async () => review,
      frame: async () => ({ path: "/", html: "<p>x</p>", missing: [] }),
      notes: {
        add: (x: { text: string }) => add(x),
        edit: async () => ({}),
        delete: async () => ({ ok: true }),
        screenshot: async () => ({ dataUrl: null }),
      },
      sendNotes: (x: unknown) => sendNotes(x),
      approve: (x: unknown) => approve(x),
    },
  },
  auth: { token: () => null },
  message: (e: unknown) => String(e),
}));

const { ReviewPage } = await import("./review");

beforeAll(() => {
  // jsdom has neither: the stage measures nothing, and this is a wide screen.
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;
  window.matchMedia ??= ((q: string) => ({
    matches: false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
  Object.defineProperty(window, "innerWidth", { value: 1600, configurable: true });
  Element.prototype.scrollIntoView ??= () => {};
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function draw() {
  const { hook } = memoryLocation({ path: `/review/${R}` });
  return render(
    <Router hook={hook}>
      <ReviewPage id={R} />
    </Router>,
  );
}

const frame = () => screen.getByTitle("What is reviewed") as HTMLIFrameElement;
const box = () => screen.getByTestId("review-frame");

/** A message from the overlay inside the frame. */
function fromFrame(data: Record<string, unknown>) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { ns: "oraknid-review", ...data },
        source: frame().contentWindow,
      }),
    );
  });
}

describe("the review page", () => {
  it("shows the target in its own origin's frame at the device's size, and switches device", async () => {
    review = fresh();
    draw();
    await screen.findByText("The design");
    expect(frame().src).toBe("http://rv-abc.localhost:7517/");
    expect(frame().getAttribute("sandbox")).not.toContain("allow-top-navigation");
    expect(box().style.width).toBe("1440px");
    expect(box().style.height).toBe("900px");
    fireEvent.change(screen.getByLabelText("Device"), { target: { value: "0" } });
    expect(box().style.width).toBe("390px");
    expect(box().style.height).toBe("844px");
    fireEvent.click(screen.getByLabelText("Turn"));
    expect(box().style.width).toBe("844px");
    expect(box().style.height).toBe("390px");
    // A size of my own.
    fireEvent.change(screen.getByLabelText("Width"), { target: { value: "1000" } });
    fireEvent.change(screen.getByLabelText("Height"), { target: { value: "700" } });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));
    expect(box().style.width).toBe("1000px");
  });

  it("selects a part, writes the note and saves it with its selector, device and picture", async () => {
    review = fresh();
    draw();
    await screen.findByText("The design");
    const posted = vi.spyOn(frame().contentWindow as Window, "postMessage");
    fireEvent.click(screen.getByRole("button", { name: /Select/ }));
    expect(posted).toHaveBeenCalledWith({ ns: "oraknid-review", op: "select", on: true }, "*");
    fromFrame({
      op: "selected",
      element: {
        selector: "#knob",
        text: "Cutoff",
        tag: "div",
        box: { x: 1, y: 2, width: 30, height: 30 },
      },
      page: "/",
      shot: "data:image/jpeg;base64,AAAA",
      console: [],
      requests: [],
    });
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/<div> Cutoff/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep" }));
    fireEvent.change(within(dialog).getByLabelText("Your note"), {
      target: { value: "Love this knob" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(add).toHaveBeenCalled());
    expect(add.mock.calls[0]?.[0]).toMatchObject({
      reviewId: R,
      kind: "keep",
      text: "Love this knob",
      device: { name: "Laptop", width: 1440, height: 900 },
      element: { selector: "#knob", tag: "div" },
      page: "/",
      screenshot: "data:image/jpeg;base64,AAAA",
    });
  });

  it("sends the overlay the pins of this device's notes, and lists notes by device", async () => {
    review = fresh([
      note({}),
      note({
        id: "01J00000000000000000000012",
        text: "Too cramped on the phone",
        kind: "problem",
        device: { name: "Phone", width: 390, height: 844, orientation: "portrait" },
      }),
    ]);
    draw();
    await screen.findByText("Bigger knobs");
    const posted = vi.spyOn(frame().contentWindow as Window, "postMessage");
    fromFrame({ op: "ready", page: "/", title: "Keys", snapshot: false });
    const pins = posted.mock.calls
      .map((c) => c[0] as { op: string; pins?: { id: string; n: number; selector: string }[] })
      .filter((m) => m.op === "pins")
      .at(-1)?.pins;
    expect(pins).toEqual([
      expect.objectContaining({
        id: "01J00000000000000000000010",
        n: 1,
        selector: "#knob",
        kind: "change",
      }),
    ]);
    expect(screen.getByText("Laptop 1440×900 (1)")).toBeTruthy();
    expect(screen.getByText("Phone 390×844 (1)")).toBeTruthy();
    // A pin clicked in the frame marks its note.
    fromFrame({ op: "pin", id: "01J00000000000000000000010" });
    await waitFor(() =>
      expect(document.getElementById("note-01J00000000000000000000010")?.className).toContain(
        "ring-2",
      ),
    );
    // A note of another device shows that device.
    fireEvent.click(screen.getByText("Too cramped on the phone"));
    expect(box().style.width).toBe("390px");
  });

  it("sends the round's notes, and approves", async () => {
    review = fresh([note({ kind: "keep" })]);
    draw();
    await screen.findByText("Bigger knobs");
    fireEvent.click(screen.getByRole("button", { name: "Send notes (1)" }));
    await waitFor(() => expect(sendNotes).toHaveBeenCalledWith({ id: R }));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    // Only keep-notes: approved without asking.
    await waitFor(() => expect(approve).toHaveBeenCalledWith({ id: R }));
  });

  it("asks before approving with notes that would only be kept", async () => {
    review = fresh([note({ kind: "change" })]);
    draw();
    await screen.findByText("Bigger knobs");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Approve with notes?")).toBeTruthy();
    expect(approve).not.toHaveBeenCalled();
  });

  it("an ended round can't be noted, sent or approved", async () => {
    review = { ...fresh([note({})]), state: "notes-sent" };
    draw();
    await screen.findByText("Notes sent");
    expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole("button", { name: /Send notes/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole("button", { name: /Select/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
