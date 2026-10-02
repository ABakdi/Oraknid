# Phase 12 — Email

Touches [[Web-UI]], [[Security]], [[Chats-and-Helper]], [[ADR-021-Tools-Broker]].
Written 2026-10-03.

## Why

My mail is where much of my work starts and ends. I want it in
Oraknid, with the agents reading, sorting and drafting, and nothing
sent without me ([[ADR-032-Email]]).

## Milestones

### M12.1 — Accounts and sync
- [ ] Several accounts: IMAP/SMTP with a password (Gmail and Outlook app passwords), OAuth2 for Gmail and Microsoft once I add their app ids
- [ ] Sync with IDLE, cached in SQLite; threads; new mail live within 10 s
- [ ] Read, star, move, archive, delete done on the server

### M12.2 — The client
- [ ] Mail page: accounts and folders, a virtual list fine with 10,000 messages, the thread, search
- [ ] Compose, reply, forward, attachments; sent mail in the provider's Sent
- [ ] Safe HTML: cleaned, sandboxed, remote images blocked until allowed
- [ ] "Reconnect" on an expired or revoked account

### M12.3 — Agents and mail
- [ ] The `email` tool through the broker: search, read, label, move, draft
- [ ] Agents' drafts marked, approved by me before sending; auto-send per account if I choose
- [ ] Every agent action on mail in the audit log

## Exit criterion

The acceptance list of [[ADR-032-Email]]'s source spec: Gmail and an
IMAP account both work end to end; new mail shows within ten seconds;
an agent finds a thread and drafts a reply that I approve and send.

Related: [[Roadmap]]
