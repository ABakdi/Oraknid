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

*Extended 2026-10-03:* destinations in cloud storage and a download from the web page ([[ADR-046-Cloud-Storage]]).

## Consequences
- `age` and `zstd` are used on this computer (Oraknid ships or finds
  them); a dump tool must exist where the database runs (in its
  container it always does).
- Restoring is mine: an agent can propose it, never run it.

## As built (2026-10-03, M13.13)
- **Plans, runs, keys** in SQLite (migration 0033: `backup_plans`,
  `backup_runs`, `backup_keys`); passwords (`backup.plan.<id>.password`)
  and age private keys (`backup.key.<id>`) in the keychain
  ([[Servers]] → Backups, [[Data-Map]]).
- **The dump** is one command over the server's SSH connection: the
  password is the first line of its stdin, read into a shell variable,
  exported under the tool's own name (`PGPASSWORD`, `MYSQL_PWD`,
  `REDISCLI_AUTH`) and handed on by name (`docker exec -i -e NAME`);
  MongoDB's tools get a `--config` file made for the run (0600) and
  removed. Redis: `BGSAVE`, waited for, then its RDB file. The output
  streams through zstd, age (with a key) and a SHA-256 tap into
  `<file>.part`, renamed once the dump ended well; to another server
  through its own SSH connection. A command at the far end that stops
  early ends the stream instead of leaving it waiting.
- **zstd**: Node's own (`node:zlib`, Node 22.15 and later), so nothing
  is installed; on an older Node, the `zstd` program if it's there,
  otherwise a run fails saying so. **age**: the `age-encryption`
  package (by age's author, JavaScript, streaming), X25519 keys; files
  read with `age -d -i key.txt file.zst.age | zstd -d`.
- **Schedule** in this computer's time (`@oraknid/core` → `nextRun`,
  cron's rules for both day fields); looked at every 30 s; a time more
  than 10 minutes past is a *missed* run, run once when Oraknid starts.
  Retention: `toPrune`, the newest good backup always kept.
- **Verify**: checksum, decrypt, decompress, and the dump's own header
  and ending. **Restore**: `backups.prepareRestore` (what it replaces,
  a token for five minutes) then `backups.restore` with the database's
  name typed back; into the plan's database or another (its password for
  that restore only). PostgreSQL dumps are plain SQL with `--clean
  --if-exists --no-owner --no-privileges`, so they restore into another
  database; MongoDB renames with `--nsFrom/--nsTo`; Redis's file is put
  in place and Redis stopped without saving, its container started
  again (a Redis keeping an append-only file is refused, in words).
- **Away from home**: changing plans and keys, taking a private key and
  restoring need full rights (`HOME_ONLY`); running and verifying don't.
- **The helper**: `list_backups`, `create_backup_plan`,
  `update_backup_plan`, `run_backup`, `verify_backup`,
  `make_backup_key`; it asks first for a plan writing on a server (a
  server destination, Redis, SQLite), for a changed target or
  destination, and for every run; no password in its inputs, no private
  key in what it sees, no restore.
- **Web**: Settings → Backups (plans, latest backups, keys) and
  a server's Backups tab (`ServerBackupsTab`), which offers the
  databases ADR-043 finds (`servers.databases`) to pick from in a new
  plan: a container's by its name, a host service by its port.
- **Cloud storage** (2026-10-04, M13.15, [[ADR-046-Cloud-Storage]]): a
  destination `{kind: "cloud", providerId (null: the pool), folder}`. The
  backup is made in `<data>/tmp/cloud` (its size decides where it fits),
  then put in the provider (the run's destination names it, its path is
  the pool's); too big for any one place is a failed run in words.
  Retention deletes it there; Verify downloads it into a temporary file
  first. A provider a plan or a kept backup needs can't be removed.
- **Download** (2026-10-04): `backups.downloadLink({runId, decrypt?})`,
  a one-time link for two minutes, streamed from wherever it is (this
  computer, another server, cloud storage); `decrypt` runs it through
  age with its key (still zstd-compressed). Only to a browser on this
  computer; `backup.downloaded` is in the audit trail.

Related: [[ADR-043-Server-Insight]] · [[ADR-026-Servers]] · [[Security]] · [[Business-Rules]] · [[ADR-041-Docs-And-A-Guiding-Helper]]
