# ADR-044 — Scheduled, encrypted database backups

**Status:** Accepted · 2026-10-03

## Context
My servers' databases need backups I can trust: on a schedule, kept
somewhere else (this computer or another server), encrypted if I want,
set up from the web interface or by asking the helper.

## Decision
- **A backup plan**, per database (one ADR-043 found, or one I
  describe): what (a database, or all of one server), how (the native
  dump: `pg_dump`/`pg_dumpall`, `mysqldump`/`mariadb-dump`,
  `mongodump`, Redis `BGSAVE` + the RDB file, a SQLite `.backup`; inside
  its container with `docker exec` when it runs in Docker), when (a
  schedule: hourly, daily at a time, weekly, or a cron line), where to
  (**this computer**, a folder; or **another of my servers**, a
  folder), how many to keep (by count and by age), and encryption.
- **Credentials** for the database are kept in the keychain (BR-13),
  given to the dump on the server through its environment or a file
  made for the run and removed after, never on its command line and
  never in a log.
- **Oraknid runs it** at its time, over SSH: the dump streams from the
  server, compressed (zstd), encrypted if asked, to its destination
  (to this computer through the SSH connection; to another server
  streamed through Oraknid, never with credentials left on either
  server). A missed run (Oraknid off) runs when it's back and says so.
- **Encryption**: with **age**. Keys are made in the web interface
  (Settings → Backups → Keys: make one, name it, show its public key,
  export the private key once to keep it safe) or imported. The public
  key encrypts; the private key stays in the keychain, used only when I
  restore. A backup made with a key says which.
- **Each run** is recorded: when, size, how long, checksum, where, and
  the error in plain words if it failed; a failed run is a
  notification. **Verify** checks a backup can be decrypted and read;
  **Restore** (to the same or another database) always asks, with a
  second step, and is never done by an agent without me.
- **Servers → a server → Backups**, and **Backups** in Settings for all
  plans and keys. The helper can create, change, run and verify plans
  and make keys, asking first for anything that writes on a server, and
  never shows a private key.

## Consequences
- `age` and `zstd` are used on this computer (Oraknid ships or finds
  them); a dump tool must exist where the database runs (in its
  container it always does).
- Restoring is mine: an agent can propose it, never run it.

Related: [[ADR-043-Server-Insight]] · [[ADR-026-Servers]] · [[Security]] · [[Business-Rules]] · [[ADR-041-Docs-And-A-Guiding-Helper]]
