import { z } from "zod";
import { Id, Timestamp } from "./common.ts";

// Chats with my models (docs/01-Specification/Chats-and-Helper.md, ADR-025).

export const ChatMessage = z.object({
  id: Id,
  author: z.enum(["owner", "model"]),
  text: z.string(),
  model: z.string().nullable(),
  error: z.string().nullable(),
  at: Timestamp,
});
export type ChatMessage = z.infer<typeof ChatMessage>;

export const ChatView = z.object({
  id: Id,
  title: z.string(),
  legId: Id,
  legModelId: Id,
  /** "Leg · model", for the header. */
  modelLabel: z.string(),
  effort: z.string().nullable(),
  projectIds: z.array(Id),
  /** An answer being written now: its text so far. */
  answering: z.string().nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type ChatView = z.infer<typeof ChatView>;

export const NewChat = z.object({
  legModelId: Id,
  effort: z.string().nullable().default(null),
  projectIds: z.array(Id).default([]),
  /** The first message, which also names the chat. */
  text: z.string().min(1).optional(),
});
export type NewChat = z.infer<typeof NewChat>;
