import { z } from "zod";
import { Id, Timestamp } from "./common.ts";

// Email (docs/01-Specification/Web-UI.md → Mail, ADR-032): my accounts,
// their folders and threads, kept in step with the provider.

export const MailProvider = z.enum(["gmail", "outlook", "imap"]);
export type MailProvider = z.infer<typeof MailProvider>;

/** How a connection is protected: TLS from the start, STARTTLS, or none (only to this machine). */
export const MailSecurity = z.enum(["tls", "starttls", "plain"]);
export type MailSecurity = z.infer<typeof MailSecurity>;

export const MailAddress = z.object({ name: z.string(), address: z.string() });
export type MailAddress = z.infer<typeof MailAddress>;

/** How mail comes in: IMAP (folders on the server) or POP3 (downloaded into local folders). */
export const MailProtocol = z.enum(["imap", "pop"]);
export type MailProtocol = z.infer<typeof MailProtocol>;

const MailServer = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  security: MailSecurity,
});

/** An account with a password (an app password for Gmail and Outlook). */
export const NewMailAccount = z.object({
  provider: MailProvider,
  protocol: MailProtocol.default("imap"),
  email: z.string().email(),
  /** Shown in the list; the address when empty. */
  name: z.string().max(60).default(""),
  /** The login, when it isn't the address. */
  login: z.string().optional(),
  /** Kept in the keychain, never in the database (BR-13). */
  password: z.string().min(1),
  /** The servers, for "imap" (any other server): Gmail and Outlook have theirs. */
  imap: MailServer.optional(),
  /** The POP3 server, when the protocol is "pop" on any other server. */
  pop: MailServer.optional(),
  smtp: MailServer.optional(),
  /** POP only: a message deleted for good here is deleted on the server too. Off: it stays there. */
  deleteFromServer: z.boolean().default(false),
});
export type NewMailAccount = z.infer<typeof NewMailAccount>;

export const MailAccountState = z.enum(["new", "syncing", "ready", "reconnect", "error"]);
export type MailAccountState = z.infer<typeof MailAccountState>;

export const MailAccountView = z.object({
  id: Id,
  name: z.string(),
  email: z.string(),
  provider: MailProvider,
  protocol: MailProtocol,
  /** The IMAP or POP3 server. */
  incomingHost: z.string(),
  smtpHost: z.string(),
  /** An agent's draft goes out without my approval. Off unless I turn it on. */
  autoSend: z.boolean(),
  /** Oraknid files what it sends in Sent itself (the provider doesn't). */
  appendSent: z.boolean(),
  /** POP only: deleting a message for good deletes it on the server too. */
  deleteFromServer: z.boolean(),
  /** "reconnect": the login failed; nothing syncs until I give the password again. */
  state: MailAccountState,
  error: z.string().nullable(),
  lastSyncAt: Timestamp.nullable(),
  unread: z.number().int(),
  createdAt: Timestamp,
});
export type MailAccountView = z.infer<typeof MailAccountView>;

export const MailFolderView = z.object({
  id: Id,
  accountId: Id,
  path: z.string(),
  name: z.string(),
  /** \Inbox, \Sent, \Drafts, \Trash, \Junk, \Archive, \All, or none. */
  specialUse: z.string().nullable(),
  total: z.number().int(),
  unread: z.number().int(),
});
export type MailFolderView = z.infer<typeof MailFolderView>;

/** One conversation in a folder's list. */
export const MailThreadSummary = z.object({
  threadId: z.string(),
  accountId: Id,
  subject: z.string(),
  /** Who wrote in it, latest first. */
  from: z.array(z.string()),
  snippet: z.string(),
  date: Timestamp,
  count: z.number().int(),
  unread: z.boolean(),
  starred: z.boolean(),
  hasAttachments: z.boolean(),
  /** The latest message's id in this folder, for actions on one row. */
  messageIds: z.array(Id),
  /** A draft of mine or an agent's for it, waiting. */
  drafts: z.number().int(),
});
export type MailThreadSummary = z.infer<typeof MailThreadSummary>;

export const MailThreadPage = z.object({
  total: z.number().int(),
  offset: z.number().int(),
  threads: z.array(MailThreadSummary),
});
export type MailThreadPage = z.infer<typeof MailThreadPage>;

export const MailAttachment = z.object({
  filename: z.string(),
  contentType: z.string(),
  size: z.number().int(),
});
export type MailAttachment = z.infer<typeof MailAttachment>;

export const MailMessageView = z.object({
  id: Id,
  accountId: Id,
  folderId: Id,
  threadId: z.string(),
  messageId: z.string().nullable(),
  subject: z.string(),
  from: MailAddress.nullable(),
  to: z.array(MailAddress),
  cc: z.array(MailAddress),
  replyTo: z.array(MailAddress),
  date: Timestamp,
  flags: z.array(z.string()),
  /** The body; null until it could be fetched. */
  text: z.string().nullable(),
  /** Raw HTML as sent: cleaned by the UI before it is shown (DOMPurify, a sandboxed frame). */
  html: z.string().nullable(),
  attachments: z.array(MailAttachment),
  /** Remote images allowed for this message or its sender. */
  imagesAllowed: z.boolean(),
});
export type MailMessageView = z.infer<typeof MailMessageView>;

export const MailDraftState = z.enum(["draft", "waiting", "sending", "sent", "failed"]);
export type MailDraftState = z.infer<typeof MailDraftState>;

export const MailOutgoingAttachment = z.object({
  filename: z.string().min(1),
  contentType: z.string().default("application/octet-stream"),
  /** The file's bytes, base64. */
  base64: z.string(),
});
export type MailOutgoingAttachment = z.infer<typeof MailOutgoingAttachment>;

/** What I write: a new message, a reply or a forward. */
export const MailCompose = z.object({
  accountId: Id,
  to: z.array(z.string().min(3)).default([]),
  cc: z.array(z.string().min(3)).default([]),
  bcc: z.array(z.string().min(3)).default([]),
  subject: z.string().default(""),
  html: z.string().default(""),
  text: z.string().default(""),
  /** The message answered: threading headers and \Answered on it. */
  replyToId: Id.nullable().default(null),
  /** The message forwarded: its attachments go along. */
  forwardOfId: Id.nullable().default(null),
  attachments: z.array(MailOutgoingAttachment).default([]),
});
export type MailCompose = z.infer<typeof MailCompose>;

export const MailDraftView = z.object({
  id: Id,
  accountId: Id,
  to: z.array(z.string()),
  cc: z.array(z.string()),
  bcc: z.array(z.string()),
  subject: z.string(),
  html: z.string(),
  text: z.string(),
  replyToId: Id.nullable(),
  forwardOfId: Id.nullable(),
  threadId: z.string().nullable(),
  attachments: z.array(MailAttachment),
  /** "agent": written by an agent; it waits for my approval before it is sent. */
  author: z.enum(["owner", "agent"]),
  jobId: Id.nullable(),
  state: MailDraftState,
  error: z.string().nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  sentAt: Timestamp.nullable(),
});
export type MailDraftView = z.infer<typeof MailDraftView>;
