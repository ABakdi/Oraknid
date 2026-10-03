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

## As built (2026-10-03)
Decided while building Phase 12, in the spirit of the above:
- **Two connections per account**: one sits in IDLE on INBOX (new mail
  in the list within seconds, as `mail.new` on the `mail` topic), the
  other does the work (syncs, flags, moves, appends). A pass over every
  folder runs every five minutes, and on demand. A folder's first sync
  takes its latest 10,000 messages; Gmail's All Mail is never synced
  (it holds everything again): archiving on Gmail moves there.
- **Threads** are Gmail's `X-GM-THRID` when the server has it; else the
  conversation of the message answered (`In-Reply-To`), else the first
  `References` id, so a reply arriving before its parent still joins it.
- **Drafts are Oraknid's**, in SQLite, not the provider's Drafts
  folder: an agent's draft must stay where only Oraknid can send it.
- **`send` is held by Oraknid itself**: the email tool is built into the
  daemon (the broker answers it without a process, so no credential
  ever leaves the daemon), and the policy lets its `send` through to it
  as "held" (only Oraknid's own tools can declare that). The call only
  marks the draft "waiting" and, when a job wrote it, opens an inbox
  approval ("Send" / "Don't send"); Approve and send in Mail answers
  that same item. With auto-send on for the account (off by default),
  the call sends at once. A send caught mid-way by a crash is never
  retried on its own: the draft says to check Sent first (BR-6).
- **Sent**: Oraknid appends what it sent to Sent unless the provider
  files it itself (Gmail, Outlook: off by default for them; a switch
  per account).
- **No TLS** is refused except to this machine (the test servers).
- **Remote images**: the UI's content policy now allows images from
  the web; each message's frame carries its own stricter policy, which
  loads nothing from outside until I allow it.
- **The email tool** is registered with the first account, so a tool of
  mine already named "email" stays as it is.
- **Not yet**: chats and the helper don't take the email tool; OAuth is
  built but untried against Google and Microsoft until I register the
  apps.

## Consequences
- Gmail and Outlook with OAuth need me to create an app with Google and
  Microsoft; until then, app passwords.
- Mail adds a long-lived connection per account to the daemon.

Related: [[ADR-021-Tools-Broker]] · [[Security]] · [[Chats-and-Helper]]
