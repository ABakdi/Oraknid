import { z } from "zod";
import { Id, Timestamp } from "./common.ts";

// The Oraknid helper (docs/01-Specification/Chats-and-Helper.md, ADR-024).

export const HelperAction = z.object({
  /** An action of the helper's catalogue, e.g. "create_project". */
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
  /** In my words: what it does. */
  summary: z.string(),
  state: z.enum(["done", "failed", "proposed", "cancelled"]),
  /** What came of it: an error, or a short result. */
  result: z.string().nullable(),
  /** Where to see it, e.g. "/new/01…". */
  link: z.string().nullable(),
});
export type HelperAction = z.infer<typeof HelperAction>;

export const HelperMessage = z.object({
  id: Id,
  author: z.enum(["owner", "helper"]),
  text: z.string(),
  actions: z.array(HelperAction),
  at: Timestamp,
});
export type HelperMessage = z.infer<typeof HelperMessage>;

/**
 * Actions the web app runs in my browser once the reply arrives, not the
 * daemon (ADR-041): open a page, point at a control, put a value in a field.
 */
export const HELPER_CLIENT_ACTIONS = ["navigate", "highlight", "fill"] as const;

/** A page of the guide, as the web app sends it with my question. */
export const HelperGuidePage = z.object({
  slug: z.string().min(1).max(100),
  title: z.string().max(200),
  text: z.string().max(40_000),
});
export type HelperGuidePage = z.infer<typeof HelperGuidePage>;

/**
 * What the web app knows and sends with my message (ADR-041): where I am,
 * the guide's pages most related to it, the map of the screens, and the
 * guide page I asked from. Oraknid's own text, not something a stranger wrote.
 */
export const HelperContext = z.object({
  route: z.string().max(500).optional(),
  guide: z.array(HelperGuidePage).max(20).default([]),
  screens: z.string().max(80_000).optional(),
  /** "Ask the helper about this" on a guide page: its slug. */
  about: z.string().max(100).optional(),
});
export type HelperContext = z.input<typeof HelperContext>;
