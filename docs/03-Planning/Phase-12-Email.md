# Phase 12 — Email

Touches [[Web-UI]], [[Security]], [[Chats-and-Helper]], [[ADR-021-Tools-Broker]].
Written 2026-10-03.

## Why

My mail is where much of my work starts and ends. I want it in
Oraknid, with the agents reading, sorting and drafting, and nothing
sent without me ([[ADR-032-Email]]).

## Milestones

### M12.1 — Accounts and sync
- [x] Several accounts: IMAP/SMTP with a password (Gmail and Outlook app passwords), OAuth2 for Gmail and Microsoft once I add their app ids
- [x] Sync with IDLE, cached in SQLite; threads; new mail live within 10 s
- [x] Read, star, move, archive, delete done on the server

### M12.2 — The client
- [x] Mail page: accounts and folders, a virtual list fine with 10,000 messages, the thread, search
- [x] Compose, reply, forward, attachments; sent mail in the provider's Sent
- [x] Safe HTML: cleaned, sandboxed, remote images blocked until allowed
- [x] "Reconnect" on an expired or revoked account

### M12.3 — Agents and mail
- [x] The `email` tool through the broker: search, read, label, move, draft (chats and the helper: not yet)
- [x] Agents' drafts marked, approved by me before sending; auto-send per account if I choose
- [x] Every agent action on mail in the audit log

Built 2026-10-03 and tested against a stand-in IMAP and SMTP server
(`apps/daemon/src/testing/fake-mail.ts`): connect, sync, threads, new
mail through IDLE, flags, moves and deletes reaching the server, sending
with Sent, an agent's draft approved and sent, auto-send, Reconnect, an
OAuth sign-in against a stand-in token server, the HTML cleaning. Not
yet tried with a real Gmail or IMAP account, nor OAuth with Google's and
Microsoft's real apps (they need registering); see [[ADR-032-Email]] →
As built.

## Exit criterion

The acceptance list of [[ADR-032-Email]]'s source spec: Gmail and an
IMAP account both work end to end; new mail shows within ten seconds;
an agent finds a thread and drafts a reply that I approve and send.

Related: [[Roadmap]]
