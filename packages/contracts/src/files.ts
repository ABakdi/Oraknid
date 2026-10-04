import { z } from "zod";
import { FolderName } from "./jobs.ts";

// The folder picker (Web-UI → The folder picker, 2026-10-04): this
// machine's folders, by name only, so a folder is chosen, not typed, even
// from a phone. No file's name or content is ever listed.

export const FolderListInput = z.object({
  /** A full path, or `~` / `~/…` for my home; my home when left out. */
  path: z.string().optional(),
  /** Folders whose name starts with a dot. */
  showHidden: z.boolean().default(false),
});
export type FolderListInput = z.infer<typeof FolderListInput>;

export const FolderEntry = z.object({
  name: z.string(),
  path: z.string(),
  /** It holds a `.git` (a folder, or the file of a worktree or submodule). */
  isGitRepo: z.boolean(),
  /** A link to a folder elsewhere; `path` is the link's, not its target's. */
  symlink: z.boolean(),
  /** Oraknid may open it; one it can't is listed, not opened. */
  readable: z.boolean(),
});
export type FolderEntry = z.infer<typeof FolderEntry>;

export const FolderList = z.object({
  /** The folder listed, as a full path. */
  path: z.string(),
  /** The folder above, null at `/`. */
  parent: z.string().nullable(),
  /** My home folder, where the picker starts. */
  home: z.string(),
  /** The folder itself is a git repo. */
  isGitRepo: z.boolean(),
  /** A project or a folder can be made in it. */
  writable: z.boolean(),
  /** Its folders, by name. */
  entries: z.array(FolderEntry),
  /** Folders left out because their name starts with a dot. */
  hidden: z.number().int(),
  /** More folders than are listed at once (1,000). */
  truncated: z.boolean(),
});
export type FolderList = z.infer<typeof FolderList>;

/** An empty folder made from the picker, inside one I chose. */
export const NewFolderInput = z.object({ parent: z.string().min(1), name: FolderName });
export type NewFolderInput = z.infer<typeof NewFolderInput>;
