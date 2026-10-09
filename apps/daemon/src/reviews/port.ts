import type {
  ReviewNote as PortNote,
  ReviewOutcome,
  ReviewPort,
  ReviewPortDeps,
} from "../harness/reviews.ts";
import type { Reviews } from "./service.ts";

// The evaluation steps' port (harness/reviews.ts) over the review page
// (ADR-064, M16.1). A step's rounds are one review on the page, so the
// port's id names the round too: `<review id>:<round>`. A round whose
// notes were sent has the outcome "notes" for good, even once the next
// round is open. The page's own events (`review.notes-sent`,
// `review.approved`, on `job:<id>`) are what resume a waiting job.

const idOf = (reviewId: string, round: number) => `${reviewId}:${round}`;

function parse(portId: string): { id: string; round: number } | null {
  const m = /^([0-9A-HJKMNP-TV-Z]{26}):(\d+)$/.exec(portId);
  return m ? { id: m[1] as string, round: Number(m[2]) } : null;
}

/** A note of the page as the program reads it: its words, its device, its part. */
function asPortNote(n: ReturnType<Reviews["notes"]>[number]): PortNote {
  const problems = [
    ...n.console.slice(-3).map((c) => `${c.level}: ${c.text.slice(0, 300)}`),
    ...n.requests
      .slice(-3)
      .map((r) => `${r.method} ${r.url.slice(0, 200)} → ${r.status ?? r.error ?? "failed"}`),
  ];
  return {
    kind: n.kind,
    text: problems.length ? `${n.text}\n(The app said meanwhile: ${problems.join("; ")})` : n.text,
    device: n.device ? `${n.device.name} ${n.device.width}×${n.device.height}` : null,
    element: n.element
      ? `<${n.element.tag}> ${n.element.text.slice(0, 120)} (${n.element.selector})${n.page && n.page !== "/" ? ` on ${n.page}` : ""}`
      : null,
  };
}

export function pageReviews(page: Reviews, d: ReviewPortDeps): ReviewPort {
  const outcome = (portId: string): ReviewOutcome | null => {
    const at = parse(portId);
    if (!at) return { kind: "approved" };
    let row: ReturnType<Reviews["row"]>;
    try {
      row = page.row(at.id);
    } catch {
      // Gone with its job: nothing waits for it.
      return { kind: "approved" };
    }
    if (row.round > at.round || (row.round === at.round && row.state === "notes-sent"))
      return { kind: "notes", notes: page.notes(at.id, at.round).map(asPortNote) };
    if (row.round < at.round || row.state === "open") return null;
    // Approved, or withdrawn (the step was dropped, the job ended): the work goes on.
    return { kind: "approved" };
  };
  return {
    async open(r) {
      const opened = page.open({
        jobId: r.jobId,
        taskId: r.stepTaskId,
        kind: r.kind,
        target: r.target.kind === "port" ? r.target.port : r.target.path,
        title: r.title,
      });
      return { reviewId: idOf(opened.id, opened.round), url: opened.url };
    },
    outcome,
    waitForOutcome: (portId, signal) =>
      new Promise<ReviewOutcome>((resolve, reject) => {
        const now = outcome(portId);
        if (now) return resolve(now);
        if (signal.aborted) return reject(signal.reason);
        const id = parse(portId)?.id;
        const stop = d.bus.subscribe((e) => {
          if (!e.type.startsWith("review.")) return;
          if ((e.payload as { reviewId?: string } | null)?.reviewId !== id) return;
          const got = outcome(portId);
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
      }),
  };
}
