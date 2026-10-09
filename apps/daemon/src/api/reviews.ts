import {
  Id,
  ReviewDetail,
  ReviewFramePage,
  ReviewNote,
  ReviewNoteAdd,
  ReviewNoteEdit,
  ReviewOpen,
  ReviewOpened,
  ReviewState,
  ReviewView,
} from "@oraknid/contracts";
import { ORPCError, os } from "@orpc/server";
import { z } from "zod";
import { ReviewError, type Reviews } from "../reviews/service.ts";
import { framePage } from "../reviews/snapshot.ts";

// Reviews (ADR-064, M16.1; API-Contract → reviews). Reading works anywhere;
// opening, notes, Send notes, Approve and the frame away from home need a
// device at home or one with full rights (lock.ts → HOME_ONLY).

const base = os.$context<{ reviews: Reviews; remote: boolean; device: string | null }>();

async function guard<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ORPCError) throw error;
    if (error instanceof ReviewError) throw new ORPCError(error.code, { message: error.message });
    console.error("request failed", error);
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "Something went wrong inside Oraknid; the details are in its log (oraknid logs).",
    });
  }
}

const ById = z.object({ id: Id });

export const reviewsRouter = {
  /** By the harness at an evaluation step (or the CLI): opens it, or its next round. */
  open: base
    .input(ReviewOpen)
    .output(ReviewOpened)
    .handler(({ context: c, input }) => guard(() => c.reviews.open(input))),
  get: base
    .input(ById)
    .output(ReviewDetail)
    .handler(({ context: c, input }) => guard(() => c.reviews.get(input.id, c.remote))),
  list: base
    .input(
      z
        .object({ projectId: Id.optional(), jobId: Id.optional(), state: ReviewState.optional() })
        .optional(),
    )
    .output(z.array(ReviewView))
    .handler(({ context: c, input }) => guard(() => c.reviews.list(input ?? {}, c.remote))),
  notes: {
    add: base
      .input(ReviewNoteAdd)
      .output(ReviewNote)
      .handler(({ context: c, input }) =>
        guard(() => c.reviews.addNote(input, { deviceId: c.device })),
      ),
    edit: base
      .input(ReviewNoteEdit)
      .output(ReviewNote)
      .handler(({ context: c, input }) => guard(() => c.reviews.editNote(input))),
    delete: base
      .input(ById)
      .output(z.object({ ok: z.literal(true) }))
      .handler(({ context: c, input }) =>
        guard(() => {
          c.reviews.deleteNote(input.id);
          return { ok: true as const };
        }),
      ),
    /** A note's screenshot, as a data URL (null without one). */
    screenshot: base
      .input(ById)
      .output(z.object({ dataUrl: z.string().nullable() }))
      .handler(({ context: c, input }) =>
        guard(() => ({ dataUrl: c.reviews.screenshot(input.id) })),
      ),
  },
  /** Ends the round: the notes go to The Eye (`review.notes-sent`). */
  sendNotes: base
    .input(ById)
    .output(z.object({ round: z.number().int(), notes: z.number().int() }))
    .handler(({ context: c, input }) => guard(() => c.reviews.sendNotes(input.id))),
  /** Ends the step (`review.approved`). */
  approve: base
    .input(ById)
    .output(z.object({ ok: z.literal(true) }))
    .handler(({ context: c, input }) =>
      guard(() => {
        c.reviews.approve(input.id);
        return { ok: true as const };
      }),
    ),
  withdraw: base
    .input(ById)
    .output(z.object({ ok: z.literal(true) }))
    .handler(({ context: c, input }) =>
      guard(() => {
        c.reviews.withdraw(input.id);
        return { ok: true as const };
      }),
    ),
  /** A page of what is reviewed, inlined with the overlay: the frame away from home. */
  frame: base
    .input(z.object({ id: Id, path: z.string().max(2000).optional() }))
    .output(ReviewFramePage)
    .handler(({ context: c, input }) =>
      guard(() => {
        const row = c.reviews.row(input.id);
        if (row.state === "withdrawn")
          throw new ReviewError("This review was withdrawn.", "CONFLICT");
        return framePage(c.reviews, row, input.path ?? row.entry);
      }),
    ),
};
