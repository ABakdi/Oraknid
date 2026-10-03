# Phase 12 — Email

Touches [[Web-UI]], [[Security]], [[Chats-and-Helper]], [[ADR-021-Tools-Broker]].
Written 2026-10-03.

## Why

My mail is where much of my work starts and ends. I want it in
Oraknid, with the agents reading, sorting and drafting, and nothing
sent without me ([[ADR-032-Email]]).

## Milestones

### M12.1 — Accounts and sync
- [x] Several accounts: IMAP or POP3 with SMTP, with a password (Gmail and Outlook app passwords, a link to make one)
- [ ] OAuth2 for Gmail and Microsoft: taken out 2026-10-03, back after a few releases
- [x] POP3 accounts: downloaded by UIDL into a local Inbox every two minutes; local folders and flags; delete from the server only if I choose
- [x] Sync with IDLE, cached in SQLite; threads; new mail live within 10 s
- [x] Read, star, move, archive, delete done on the server (IMAP), kept here (POP)

### M12.2 — The client
- [x] Mail page: accounts and folders, a virtual list fine with 10,000 messages, the thread, search
- [x] Compose, reply, forward, attachments; sent mail in the provider's Sent
- [x] Safe HTML: cleaned, sandboxed, remote images blocked until allowed; once allowed, fetched by the daemon (public addresses only) and given to the frame inline, so the UI loads nothing from outside
- [x] "Reconnect" on an expired or revoked account
- [x] Accounts added, reconnected, set and removed from Mail itself; on a phone the folders in a drawer and a way back from a conversation, at 390 px

### M12.3 — Agents and mail
- [x] The `email` tool through the broker: search, read, label, move, draft (chats and the helper: not yet)
- [x] Agents' drafts marked, approved by me before sending; auto-send per account if I choose
- [x] Every agent action on mail in the audit log

Built 2026-10-03 and tested against a stand-in IMAP, POP3 and SMTP
server (`apps/daemon/src/testing/fake-mail.ts`): connect, sync, threads,
new mail through IDLE, flags, moves and deletes reaching the server,
sending with Sent, an agent's draft approved and sent, auto-send,
Reconnect, the HTML cleaning; for POP, downloading by UIDL (nothing
twice, a dotted line kept), local folders and flags, attachments from
the kept copy, deleting on the server only with the option on, the
two-minute check and Reconnect. The add-account form is tested in the
web app, and the Mail page was checked by hand at 390 px against a
test daemon. OAuth was taken out the same day (back after a few
releases). Not yet tried with a real Gmail, IMAP or POP account; see
[[ADR-032-Email]] → As built.

## Exit criterion

The acceptance list of [[ADR-032-Email]]'s source spec: Gmail and an
IMAP account both work end to end; new mail shows within ten seconds;
an agent finds a thread and drafts a reply that I approve and send.

Related: [[Roadmap]]
