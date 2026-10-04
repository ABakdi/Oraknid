# ADR-047 — Releases

**Status:** Accepted · 2026-10-04

## Context
Oraknid was installed from a branch: `dev` for the newest work, `main`
far behind it. People need a version they can name, a page that says
what is in it, and a command that installs exactly that.

## Decision
- **Versions** follow semantic versioning, defined once in the root
  `package.json` (every package carries the same number; `oraknid
  --version` and the status read it). Until 1.0 a minor version may
  change anything, and its notes say what to do.
- **A release** is an annotated tag `vX.Y.Z` on `dev`, after a full
  `pnpm check`, with a GitHub release (a pre-release before 1.0) that
  carries:
  - the notes: every feature, what changed, the known limits, how to install;
  - GitHub's own **Source code** archives (zip and tar.gz);
  - **`install.sh`** pinned to the tag (`REF="vX.Y.Z"`), so
    `curl -fsSL https://github.com/ABakdi/Oraknid/releases/download/vX.Y.Z/install.sh | sh`
    installs exactly that version;
  - **`SHA256SUMS`** for the script.
- **`main` follows the releases**: fast-forwarded to each tag, so the
  short command, the script from `main`, installs the latest release.
  `dev` stays where work happens (`--dev`).
- **`CHANGELOG.md`** at the root holds every release's notes.
- No built bundle is attached: the script builds from source, because
  `node-pty` and `better-sqlite3` compile for the machine they run on.

## Consequences
- GitHub's `releases/latest` skips pre-releases, so before 1.0 the
  short command is the one from `main`, not that link.
- A release is checked before it is tagged: `pnpm check`, and the
  pinned script installing the tag in a plain container.

## As built (2026-10-04)
- v0.1.0, the first: Phases 1 to 13.
