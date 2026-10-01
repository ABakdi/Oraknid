# ADR-007 — Silk lives in the database, mirrored to markdown in the workspace

**Status:** Accepted · 2026-10-01 · [[Phase-1-MVP]]

## Context
Silk has to survive crashes along with the job state, be easy to query
for context packs, and be readable by me and by any Leg as plain files.

## Decision
The database is the source of truth. After each change, the daemon
rewrites `.oraknid/silk/*.md` in the workspace (atomic write: temp file
+ rename). Hand edits to the mirror are detected (by content hash) and
offered for import as `owner` entries. They never overwrite silently.

## Consequences
- Context packs come from indexed queries, not file parsing.
- Legs can read Silk without a special tool.
- I can commit the mirror if I want Silk in the repo history.

## Why not database only
Silk would be invisible outside the UI, and Legs would need a tool to
read it.

## Why not markdown files only
Hard to query, hard to keep consistent with the job state through a
crash, and easy to corrupt with a partial write.

Related: [[Silk]] · [[ADR-002-Persistence]]
