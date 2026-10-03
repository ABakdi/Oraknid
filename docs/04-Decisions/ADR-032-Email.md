# ADR-032 — An email client inside Oraknid, with mail for the agents through the broker

**Status:** Accepted · 2026-10-03 · [[Phase-12-Email]]

## Context
I want my mail in Oraknid: several accounts (Gmail, Outlook/Hotmail,
any IMAP or POP3 server with SMTP), read, sorted and answered with the agents' help, and
never sent by an agent without me.

## Decision
- **A client only**: no mail server. Libraries: `imapflow` (read,
  search, IDLE, flags, move), `nodemailer` (send), a small POP3 client of its own (added later, see below), `mailparser`
  (MIME), DOMPurify and a sandboxed frame to show HTML, TanStack Virtual
  for long lists, Tiptap to write.
- **Fitted to Oraknid**, not to a generic web app: SQLite (the existing
  database, new tables), sync jobs in the daemon itself (no Redis or
  BullMQ: one user, one machine), the live socket for new mail, my
  existing data hooks instead of TanStack Query.
- **Accounts**: IMAP or POP3, and SMTP, with a password (an app
  password for Gmail and Outlook). Passwords in the keychain. A failed
  login shows "Reconnect", never a silent failure. *Changed
  2026-10-03:* OAuth (Google and Microsoft sign-in) is taken out for
  now and comes back after a few releases; see As built.
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
  gates (not built yet; see As built).
- **No MCP SDK**: the spec named `@modelcontextprotocol/sdk` for the
  agents' side; the broker already speaks MCP's JSON-RPC itself
  ([[ADR-021-Tools-Broker]]), so the email tool is built into the daemon
  and answered by the broker, with no extra process or package.
- **Not the shadcn/ui mail example**: the Mail page is Oraknid's own
  three panes, in the app's look ([[Web-UI]] → Mail and → Look).

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
- **Remote images**: once I allow them, the daemon fetches them (web
  addresses only, never this computer or my network, images only, 3 MB
  each, 40 a message, redirects checked) and the message's frame gets
  them inline; neither the UI nor the frame loads anything from outside,
  so the UI's content policy stays closed (Audit 2).
- **The email tool** is registered with the first account, so a tool of
  mine already named "email" stays as it is.
- **Not yet**: chats and the helper don't take the email tool.

### Changed after building (2026-10-03)
- **OAuth: later, after a few releases.** Sign-in with Google and
  Microsoft is removed (its routes, the `/oauth/mail/callback` handler,
  the client id and secret in Settings, the code): accounts are app
  passwords or server settings only. Gmail and Outlook stay as presets
  of their servers, with a short hint and a link to where each makes an
  app password. Migration 0028 drops the accounts' `auth` column and
  the saved app ids.
- **POP3 as well as IMAP.** An account picks IMAP or POP3 for incoming
  mail (POP3 over TLS, 995, or STARTTLS; no TLS only to this machine,
  as for IMAP), and SMTP to send. POP has no folders nor flags, so: new
  messages are downloaded by UIDL into a local Inbox, every two minutes
  and on demand; Sent, Archive, Trash and Drafts are Oraknid's own
  folders; read, star, move and archive are local; delete moves to
  Trash, and from Trash removes the message here, and on the server
  only if the account's "delete from the server" is on (off by
  default: it stays there and is never downloaded again). What I send
  is kept in the local Sent. The first check takes the latest 10,000
  messages, as an IMAP folder's first sync. A small POP3 client of
  Oraknid's own (`mail/pop3.ts`, over `node:net`/`node:tls`) does it:
  the maintained npm clients lack STLS or hand messages over as text,
  which breaks 8-bit mail. Each message's bytes are kept in
  `mail/local/<account>/`, for its attachments and forwards.
- **Accounts from Mail itself**: add one, check, reconnect, its
  settings (auto-send, Sent, delete from the server) and remove, from
  each account's menu in the folder list; and the folders in a drawer
  on a phone.

### Fixed after a failed Namecheap POP account (2026-10-03)
Namecheap's Private Email (Dovecot) answers POP3 on 995 (TLS) and 110
(STARTTLS), and Oraknid's POP3 client reaches its login with either. A
failed add was hard to diagnose: a port and security that don't match
gave OpenSSL's raw "wrong version number", a refused login said only
what the server said, and nothing was logged. Now:
- **Presets found from the address**: the domain's MX records name the
  provider (Google, Microsoft, Namecheap Private Email, Zoho, Fastmail,
  iCloud, Yahoo, and others known), and the servers, ports and
  security are filled in; I can still change them.
- **Port and security move together**: 995, 993 and 465 are TLS; 110,
  143 and 587 are STARTTLS.
- **Errors in plain words**, each naming what to check: a TLS mismatch,
  a name that doesn't resolve, a port closed or timing out, a refused
  login (the full address as login, the mailbox's own password or an
  app password), and which side failed (incoming or SMTP).
- **"Test" before adding**, checking incoming and SMTP separately, and
  every failed add written to the daemon's log without the password.

## Acceptance
The source spec's list (pasted 2026-10-03), where each stands:
- Gmail and a generic IMAP account end to end: Gmail **with an app
  password** (OAuth later), synced for real; a generic IMAP account
  tested against the stand-in server only.
- New mail in the UI within 10 seconds: built (IDLE), tested.
- Threads by reply headers and by Gmail's thread id: built, tested.
- Sent mail in the provider's Sent folder: built (filed unless the
  provider does it), tested.
- Read, star, move, delete seen in the provider's own client: done on
  the server first, tested against the stand-in.
- An agent finds a thread, drafts a reply marked as an agent's, I
  approve and send: built, tested; on my real account, to try.
- No agent sends without approval unless auto-send is on: built, tested.
- Every agent action logged: built (`mail.agent.*`, one user).
- Credentials encrypted at rest: passwords only in the keychain; the
  mail cached in Oraknid's database is not encrypted, like the rest of
  its data on my disk.
- No script in mail HTML, remote images blocked until allowed: built,
  tested.
- An expired or revoked account says "Reconnect": built, tested.
- 10,000+ messages scroll smoothly: virtual list, paging tested with
  10,000 conversations.

## Consequences
- Gmail and Outlook need an app password (and two-step verification)
  until OAuth comes back; POP must be turned on in their settings to be
  used.
- Mail adds a long-lived connection per account to the daemon.

Related: [[ADR-021-Tools-Broker]] · [[Security]] · [[Chats-and-Helper]]
