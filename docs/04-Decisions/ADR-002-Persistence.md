# ADR-002 — SQLite (better-sqlite3, WAL, synchronous=FULL) with Drizzle

**Status:** Accepted · 2026-10-01 · [[Phase-1-MVP]]

## Context
A single-user local daemon must persist everything and recover from
power loss without losing a committed transition (BR-8). It needs no
separate database server.

## Decision
- **SQLite** through **better-sqlite3**, one connection on the daemon's
  main thread (a single writer, synchronous API).
- Pragmas: `journal_mode=WAL`, `synchronous=FULL`, `foreign_keys=ON`,
  `busy_timeout=5000`, plus a periodic `wal_checkpoint(TRUNCATE)` when idle.
  FULL because a commit acknowledged before power loss must survive.
  NORMAL can lose the last commits.
- **Drizzle ORM** for the schema, types and queries. **drizzle-kit**
  generates SQL migrations, which are committed and applied at daemon
  start in a transaction, after an automatic `.backup()` of the database.
- `drizzle-zod` derives Zod schemas where useful. Wire schemas still
  live in `packages/contracts`.
- Location: `$XDG_DATA_HOME/oraknid/oraknid.db` (default
  `~/.local/share/oraknid/`).

## Consequences
- One file to back up (with `.backup()`, never by copying the file).
- A native addon to build. Prebuilt binaries cover Linux and Windows x64.
- Heavy writes (Leg output chunks) are batched per 250 ms to keep the
  main thread free. Raw Leg output goes to log files on disk, and the
  database stores summaries and offsets.

## Why not node:sqlite
Still Release Candidate (stability 1.2) in current Node, with fewer
features. Worth revisiting to drop the native addon once it's stable.

## Why not Postgres
It's a server to install and supervise on every machine, for one user.

## Why not Kysely
A fine query builder, but it has no schema-first migration generation.

Related: [[Persistence-and-Recovery]] · [[ADR-003-Job-Execution-Engine]]
