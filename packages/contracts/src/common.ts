import { z } from "zod";

/** ULIDs: sortable by creation time. */
export const Id = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, "must be a ULID");
export type Id = z.infer<typeof Id>;

/** Milliseconds since the Unix epoch. */
export const Timestamp = z.number().int().nonnegative();
export type Timestamp = z.infer<typeof Timestamp>;

export const Markdown = z.string();
