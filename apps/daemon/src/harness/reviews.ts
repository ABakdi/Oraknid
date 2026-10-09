import type { EvaluationKind } from "@oraknid/contracts";
import type { EventBus } from "../events/bus.ts";
import type { InboxStore } from "../inbox/store.ts";

// The seam between an evaluation step (ADR-064 §1, M16.2) and the review
// page (M16.1). The job's program opens a review through a `ReviewPort`,
// waits on it, and turns what comes back into work; it knows nothing of
// the page. Three calls:
//
//   open(request)            → { reviewId, url }: a review of the design (a
//                              folder) or the running app (a local port),
//                              one round; a new round is a new open.
//   outcome(reviewId)        → what I said, or null while I haven't.
//   waitForOutcome(id, sig)  → resolves with it as soon as I say it.
//
// The real port is the review page's API (`reviews.open`, its events
// `review.notes-sent {reviewId, notes}` and `review.approved {reviewId}`).
// Whatever implements this must publish those events on the bus with the
// job's id (topic `job:<id>`): a job waiting on a review is resumed by them
// (daemon.ts). The daemon's default is the review page's (reviews/port.ts);
// without the daemon's, the program falls back to `inboxReviews`: the
// review is a question in the inbox (Approve, or my notes in words).
// Tests use `standInReviews`.

/** Where the review looks: the design's folder, or the app running on a local port. */
export type ReviewTarget = { kind: "folder"; path: string } | { kind: "port"; port: number };

export interface ReviewRequest {
  jobId: string;
  /** The evaluation step's task. */
  stepTaskId: string;
  projectId: string;
  kind: "design" | "app";
  target: ReviewTarget;
  /** Round 1, 2…: one more each time my notes came back as work. */
  round: number;
  /** One line: what it is and why (the plan's). */
  title: string;
}

/** One note of mine on a review (ADR-064 §2): keep, change, problem, or a general note. */
export interface ReviewNote {
  kind: "keep" | "change" | "problem" | "general";
  text: string;
  /** The device it was written on ("phone", "1280×800"), when the page says. */
  device?: string | null;
  /** The part of the page it is about: its element and text, when I pointed at one. */
  element?: string | null;
}

export type ReviewOutcome = { kind: "approved" } | { kind: "notes"; notes: ReviewNote[] };

export interface ReviewPort {
  open(request: ReviewRequest): Promise<{ reviewId: string; url: string }>;
  outcome(reviewId: string): ReviewOutcome | null;
  waitForOutcome(reviewId: string, signal: AbortSignal): Promise<ReviewOutcome>;
}

/** What makes the port: the daemon's parts it may use. */
export interface ReviewPortDeps {
  bus: EventBus;
  inbox: InboxStore;
}
export type ReviewPortFactory = (d: ReviewPortDeps) => ReviewPort;

export const REVIEW_EVENTS = new Set(["review.notes-sent", "review.approved"]);

const KIND_OF = /^\s*(keep|change|problem)\s*[:—-]\s*/i;

/** My notes in words, one per line: "keep: …", "change: …", "problem: …", else general. */
export function notesFromText(text: string): ReviewNote[] {
  return text
    .split(/\n+/)
    .map((l) => l.replace(/^\s*[-*•]\s*/, "").trim())
    .filter(Boolean)
    .map((l) => {
      const m = l.match(KIND_OF);
      return m
        ? {
            kind: (m[1] as string).toLowerCase() as ReviewNote["kind"],
            text: l.slice(m[0].length).trim(),
          }
        : { kind: "general" as const, text: l };
    });
}

/** Waits for `peek` to say something, looking again whenever the bus says something may have changed. */
function waitOn<T>(
  bus: EventBus,
  peek: () => T | null,
  changed: (type: string, payload: unknown) => boolean,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const now = peek();
    if (now) return resolve(now);
    if (signal.aborted) return reject(signal.reason);
    const stop = bus.subscribe((e) => {
      if (!changed(e.type, e.payload)) return;
      const got = peek();
      if (!got) return;
      stop();
      resolve(got);
    });
    signal.addEventListener(
      "abort",
      () => {
        stop();
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

const APPROVE = "Approve";
const targetText = (t: ReviewTarget) =>
  t.kind === "port" ? `http://127.0.0.1:${t.port}/` : `file://${t.path}/index.html`;

/**
 * The review as a question in the inbox, until the review page is wired
 * (M16.1): Approve, or my notes in words (one per line, "keep:",
 * "change:" or "problem:" first). Answering it resumes the job as any
 * answer does; the review events are published too.
 */
export function inboxReviews(d: ReviewPortDeps): ReviewPort {
  const itemOf = (reviewId: string) => reviewId.replace(/^inbox:/, "");
  const outcome = (reviewId: string): ReviewOutcome | null => {
    const item = d.inbox.get(itemOf(reviewId));
    if (!item) return { kind: "approved" };
    if (item.state === "withdrawn" || item.state === "expired") return { kind: "approved" };
    if (item.state !== "answered") return null;
    const answer = (item.answer ?? "").trim();
    if (!answer || answer === APPROVE) return { kind: "approved" };
    return { kind: "notes", notes: notesFromText(answer) };
  };
  return {
    async open(r) {
      const url = targetText(r.target);
      const what = r.kind === "design" ? "the design" : "the running app";
      const id = d.inbox.open({
        kind: "question",
        jobId: r.jobId,
        taskId: r.stepTaskId,
        raisedBy: "eye",
        title: `Review ${what}${r.round > 1 ? ` (round ${r.round})` : ""}`,
        detail: `${r.title}\n\nOpen it: ${url}\n\nApprove it, or answer with your notes, one per line; start a line with “keep:” for what to keep as it is, “change:” for a change, “problem:” for something wrong. Notes become work, then a new round.`,
        options: [APPROVE],
        defaultOption: null,
      });
      return { reviewId: `inbox:${id}`, url };
    },
    outcome,
    waitForOutcome: (reviewId, signal) =>
      waitOn(
        d.bus,
        () => outcome(reviewId),
        (type, payload) =>
          (type === "inbox.answered" || type === "inbox.withdrawn") &&
          (payload as { id?: string }).id === itemOf(reviewId),
        signal,
      ),
  };
}

/**
 * A stand-in for tests: it opens nothing, remembers each request, and says
 * what the test says (`approve`, `sendNotes`), publishing the review page's
 * events as the real one does.
 */
export function standInReviews() {
  const opened: (ReviewRequest & { reviewId: string; url: string })[] = [];
  const outcomes = new Map<string, ReviewOutcome>();
  let bus: EventBus | null = null;
  const jobOf = (reviewId: string) => opened.find((o) => o.reviewId === reviewId)?.jobId ?? null;
  const say = (reviewId: string, o: ReviewOutcome) => {
    outcomes.set(reviewId, o);
    const jobId = jobOf(reviewId);
    bus?.publish({
      type: o.kind === "approved" ? "review.approved" : "review.notes-sent",
      topic: jobId ? `job:${jobId}` : "overview",
      jobId,
      payload: o.kind === "approved" ? { reviewId } : { reviewId, notes: o.notes },
      actor: "owner",
    });
  };
  const port = (d: ReviewPortDeps): ReviewPort => {
    bus = d.bus;
    return {
      async open(r) {
        const reviewId = `review-${opened.length + 1}`;
        const url = `http://127.0.0.1/review/${reviewId}`;
        opened.push({ ...r, reviewId, url });
        return { reviewId, url };
      },
      outcome: (id) => outcomes.get(id) ?? null,
      waitForOutcome: (id, signal) =>
        waitOn(
          d.bus,
          () => outcomes.get(id) ?? null,
          (type, payload) =>
            REVIEW_EVENTS.has(type) && (payload as { reviewId?: string }).reviewId === id,
          signal,
        ),
    };
  };
  return {
    port,
    opened,
    approve: (reviewId: string) => say(reviewId, { kind: "approved" }),
    sendNotes: (reviewId: string, notes: ReviewNote[]) => say(reviewId, { kind: "notes", notes }),
    /** The latest review opened for a step (or any), once it is. */
    latest: (stepTaskId?: string) =>
      [...opened].reverse().find((o) => !stepTaskId || o.stepTaskId === stepTaskId) ?? null,
  };
}
export type StandInReviews = ReturnType<typeof standInReviews>;

/** What an evaluation kind reviews through the port: a checkpoint is the app when it runs, else the folder. */
export const portKindOf = (kind: EvaluationKind, appRuns: boolean): "design" | "app" =>
  kind === "design" ? "design" : kind === "app" || appRuns ? "app" : "design";
