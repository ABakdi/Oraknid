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
