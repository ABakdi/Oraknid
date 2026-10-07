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
- v0.2.0 (2026-10-07): Phase 15's harness, auto mode, local models and the terminal app, and the rest of Phase 13 (M13.18–M13.26). Versions stay 0.x.y, the minor raised for each batch of features and the patch for fixes, until I say 1.0.
- v0.2.1 (2026-10-07): an installed daemon starts again; an update whose new version doesn't start is rolled back ([[ADR-048-Updates]]).
- v0.2.2 (2026-10-07): cancel from the chat; The Eye looks up what it doesn't know.
- v0.2.3 (2026-10-07): server jobs: an approved plan covers its own removals, the agent's need asked as itself, checks in plain form.
- v0.2.4 (2026-10-07): the harness, stage 1 ([[ADR-056-The-Harness]]): scenarios from my real jobs, fifteen fixes.
- Oraknid tells me of a new release and installs it from inside (2026-10-04, [[ADR-048-Updates]]): an install from `dev` counts pre-releases and new work on dev, one from `main` or a tag only releases, so a release meant for `main`'s installs is published as a release, not a pre-release.

Related: [[ADR-036-One-Script-Install]] · [[ADR-048-Updates]]
