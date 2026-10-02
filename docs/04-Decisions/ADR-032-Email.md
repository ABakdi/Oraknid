# ADR-032 — An email client inside Oraknid, with mail for the agents through the broker

**Status:** Accepted · 2026-10-03 · [[Phase-12-Email]]

## Context
I want my mail in Oraknid: several accounts (Gmail, Outlook/Hotmail,
any IMAP/SMTP), read, sorted and answered with the agents' help, and
never sent by an agent without me.

## Decision
- **A client only**: no mail server. Libraries: `imapflow` (read,
  search, IDLE, flags, move), `nodemailer` (send, OAuth2), `mailparser`
  (MIME), DOMPurify and a sandboxed frame to show HTML, TanStack Virtual
  for long lists, Tiptap to write.
- **Fitted to Oraknid**, not to a generic web app: SQLite (the existing
  database, new tables), sync jobs in the daemon itself (no Redis or
  BullMQ: one user, one machine), the live socket for new mail, my
  existing data hooks instead of TanStack Query.
- **Accounts**: IMAP/SMTP with a password (an app password for Gmail and
  Outlook works today); OAuth2 (XOAUTH2) for Gmail and Microsoft once I
  register Oraknid as an app with them and paste its client id and
  secret. Secrets and tokens in the keychain. A failed login or revoked
  token shows "Reconnect", never a silent failure.
- **Sync**: IMAP IDLE per account's inbox, a periodic pass for other
  folders; headers and bodies cached in SQLite, bodies fetched on first
  open; threads by `Message-ID`/`In-Reply-To`/`References`, and Gmail's
  thread id when there is one. What I do (read, star, move, delete,
  archive) is done on the server, so other clients see it.
- **Safe mail**: HTML is cleaned with DOMPurify, shown in a sandboxed
  frame with no scripts; remote images are blocked until I allow them
  for a message or a sender. Mail is untrusted content (BR-15): wrapped
  as data wherever an agent reads it.
- **Agents**: an `email` tool through the broker ([[ADR-021-Tools-Broker]]):
  `search`, `read_thread`, `list_folders`, `label`/`move`/`flag`
  (declared writes), `draft_reply`/`draft` (a draft marked as written
  by an agent). `send` is the gated action: a draft is sent only when I
  approve it, unless I turn on auto-send for an account. Every agent
  action on mail is in the audit log.
- **Chats and the helper** can use the email tool too, with the same
  gates.

## Consequences
- Gmail and Outlook with OAuth need me to create an app with Google and
  Microsoft; until then, app passwords.
- Mail adds a long-lived connection per account to the daemon.

Related: [[ADR-021-Tools-Broker]] · [[Security]] · [[Chats-and-Helper]]
