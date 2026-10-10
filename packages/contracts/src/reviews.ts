import { z } from "zod";
import { Id, Timestamp } from "./common.ts";

// Reviews (ADR-064 §2–3, M16.1): a design or the running app opened in a
// tab for me to point at and annotate, per device, in rounds.

/** A clickable design (a folder served as it is) or the job's running app (its local port). */
export const ReviewKind = z.enum(["design", "app"]);
export type ReviewKind = z.infer<typeof ReviewKind>;

/** Open: waiting for me. Notes sent: a round ended, the next opens when the work is ready. */
export const ReviewState = z.enum(["open", "notes-sent", "approved", "withdrawn"]);
export type ReviewState = z.infer<typeof ReviewState>;

/** Keep ("I like this"), change (a suggestion), problem, or a general note on no element. */
export const ReviewNoteKind = z.enum(["keep", "change", "problem", "general"]);
export type ReviewNoteKind = z.infer<typeof ReviewNoteKind>;

/** The device a note was written on: a preset or my own size. */
export const ReviewDevice = z.object({
  name: z.string().min(1).max(60),
  width: z.number().int().min(120).max(8000),
  height: z.number().int().min(120).max(8000),
  orientation: z.enum(["portrait", "landscape"]),
});
export type ReviewDevice = z.infer<typeof ReviewDevice>;

/** Where an element was, in the frame's page (CSS pixels, from its top left). */
export const ReviewBox = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().nonnegative(),
  height: z.number().finite().nonnegative(),
});
export type ReviewBox = z.infer<typeof ReviewBox>;

/** The part of the page I pointed at: a selector that finds it again, its text and tag. */
export const ReviewElement = z.object({
  selector: z.string().min(1).max(2000),
  text: z.string().max(2000),
  tag: z.string().min(1).max(40),
  box: ReviewBox,
});
export type ReviewElement = z.infer<typeof ReviewElement>;

/** What the running app said in its console around a note (ADR-064 §3). */
export const ReviewConsoleLine = z.object({
  level: z.enum(["error", "warn"]),
  text: z.string().max(2000),
  at: Timestamp,
});
export type ReviewConsoleLine = z.infer<typeof ReviewConsoleLine>;

/** A request of the running app that failed (an error status, or no answer). */
export const ReviewFailedRequest = z.object({
  method: z.string().max(10),
  url: z.string().max(2000),
  status: z.number().int().nullable(),
  error: z.string().max(500).nullable(),
  at: Timestamp,
});
export type ReviewFailedRequest = z.infer<typeof ReviewFailedRequest>;

export const ReviewNote = z.object({
  id: Id,
  reviewId: Id,
  round: z.number().int().min(1),
  kind: ReviewNoteKind,
  text: z.string(),
  /** Null for a note written in the chat or the inbox, not on the page. */
  device: ReviewDevice.nullable(),
  element: ReviewElement.nullable(),
  /** The page of the design or app it was written on ("/settings"). */
  page: z.string().nullable(),
  hasScreenshot: z.boolean(),
  console: z.array(ReviewConsoleLine),
  requests: z.array(ReviewFailedRequest),
  /** "owner" on the page; "chat" when it came from a message in the project's conversation. */
  source: z.enum(["page", "chat"]),
  createdAt: Timestamp,
  editedAt: Timestamp.nullable(),
});
export type ReviewNote = z.infer<typeof ReviewNote>;

export const ReviewView = z.object({
  id: Id,
  jobId: Id,
  /** The evaluation step (a task of the plan) it belongs to, when the plan has one. */
  taskId: Id.nullable(),
  projectId: Id,
  projectName: z.string(),
  jobTitle: z.string(),
  /** What is reviewed, in words ("The design", or the step's title). */
  title: z.string(),
  kind: ReviewKind,
  /** The design's folder, or the app's local address (http://127.0.0.1:<port>). */
  target: z.string(),
  /** The page opened first ("/" or "/index.html"). */
  entry: z.string(),
  round: z.number().int().min(1),
  state: ReviewState,
  /** Where the frame loads it, at home: its own origin under this Oraknid; null away from home. */
  frameUrl: z.string().nullable(),
  /** The current round's notes, not deleted. */
  noteCount: z.number().int().nonnegative(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  endedAt: Timestamp.nullable(),
});
export type ReviewView = z.infer<typeof ReviewView>;

/** A review with every round's notes (deleted ones left out), oldest first. */
export const ReviewDetail = ReviewView.extend({ notes: z.array(ReviewNote) });
export type ReviewDetail = z.infer<typeof ReviewDetail>;

/** Opening a review (the harness, at an evaluation step): the job, its step, and what to show. */
export const ReviewOpen = z.object({
  jobId: Id,
  taskId: Id.nullable().optional(),
  kind: ReviewKind,
  /** A design's folder (absolute, or relative to the job's worktree) or the app's port or local URL. */
  target: z.union([z.string().min(1).max(4096), z.number().int().min(1).max(65535)]),
  /** The page to open first; "/" by default. */
  entry: z.string().max(500).optional(),
  title: z.string().min(1).max(200).optional(),
});
export type ReviewOpen = z.infer<typeof ReviewOpen>;

export const ReviewOpened = z.object({
  id: Id,
  /** The review page in the web UI: `/review/<id>`. */
  url: z.string(),
  round: z.number().int().min(1),
});
export type ReviewOpened = z.infer<typeof ReviewOpened>;

/** The largest screenshot a note keeps, as a data URL (about 3 MB of JPEG or PNG). */
export const REVIEW_SHOT_MAX = 4_000_000;

export const ReviewNoteAdd = z.object({
  reviewId: Id,
  kind: ReviewNoteKind,
  text: z.string().trim().min(1).max(4000),
  device: ReviewDevice.nullable(),
  element: ReviewElement.nullable(),
  page: z.string().max(500).nullable().optional(),
  /** The selected region, as a data:image/jpeg or data:image/png URL. */
  screenshot: z
    .string()
    .max(REVIEW_SHOT_MAX)
    .regex(/^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/)
    .nullable()
    .optional(),
  console: z.array(ReviewConsoleLine).max(50).optional(),
  requests: z.array(ReviewFailedRequest).max(50).optional(),
});
export type ReviewNoteAdd = z.infer<typeof ReviewNoteAdd>;

export const ReviewNoteEdit = z.object({
  id: Id,
  text: z.string().trim().min(1).max(4000).optional(),
  kind: ReviewNoteKind.optional(),
});
export type ReviewNoteEdit = z.infer<typeof ReviewNoteEdit>;

/** A page of the review's target for a frame away from home: its files inlined, the overlay in it. */
export const ReviewFramePage = z.object({
  path: z.string(),
  html: z.string(),
  /** What could not be inlined (a module script, a file too big), said once. */
  missing: z.array(z.string()),
});
export type ReviewFramePage = z.infer<typeof ReviewFramePage>;

/** The device a screen of a design is drawn for, guessed from its name; "other" for none. */
export const ReviewScreenProfile = z.enum([
  "phone-portrait",
  "phone-landscape",
  "phone",
  "tablet-portrait",
  "tablet-landscape",
  "tablet",
  "laptop",
  "desktop",
  "other",
]);
export type ReviewScreenProfile = z.infer<typeof ReviewScreenProfile>;

/** A page of what is reviewed the review page can show: "/phone-portrait.html", "/brand/". */
export const ReviewScreen = z.object({
  path: z.string(),
  /** Its name in words ("phone portrait"). */
  name: z.string(),
  profile: ReviewScreenProfile,
});
export type ReviewScreen = z.infer<typeof ReviewScreen>;

/**
 * A review's screens (2026-10-10): a design's pages at its top (its
 * index.html as "/"), each with the device its name speaks of; an app is
 * one screen, its entry. `index`: the design has an index.html (an app: true).
 */
export const ReviewScreens = z.object({
  index: z.boolean(),
  screens: z.array(ReviewScreen),
});
export type ReviewScreens = z.infer<typeof ReviewScreens>;
