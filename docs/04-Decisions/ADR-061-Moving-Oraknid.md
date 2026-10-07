# ADR-061 — Moving Oraknid to another computer, and exporting a job or a project

**Status:** Accepted · 2026-10-07 · builds on [[ADR-002-Persistence]], [[Persistence-and-Recovery]], [[Security]] (BR-13), [[ADR-044-Backups]] (age)

## Context
I want to take my Oraknid to a new computer: projects, jobs and their
history, Silk, servers, settings and the secrets that go with them,
without copying the data folder by hand (the keychain doesn't travel
with it). And [[Persistence-and-Recovery]] promised exporting a job or a
project as a zip, which wasn't built.

## Decision
### A job or a project as a zip
- `jobs.exportZip` / `projects.exportZip` (and **Export** on a job's and
  a project's page) make a zip: `manifest.json` (format, version, what),
  per job `jobs/<id>/job.json` (its record as `jobs.export` gives it),
  `jobs/<id>/silk/<kind>-<id>.md` (each Silk entry as markdown) and
  `jobs/<id>/logs/<session>.ndjson` (its sessions' raw logs, when kept);
  for a project, `project.json` too. Every text is scrubbed of known
  secrets and secret-shaped strings (BR-13). Downloaded through a
  one-time link, like a backup.
- **Import** (`jobs.importZip`, Settings → Storage and the project's
  page): a zip made by Oraknid adds its jobs as **ended, read-only
  records** under a project I pick (or a new one, by the zip's project
  name): the job, its tasks and plan, events, Silk; logs go to the logs
  folder. A job whose id is already here is skipped, said so. Nothing
  imported runs. A zip that isn't Oraknid's, too big (500 MB), or with
  paths outside its folders is refused.

### The whole Oraknid, to another computer
- `oraknid export --all [--out FILE]` (and **Export everything** in
  Settings → About) makes one archive, `oraknid-move-<date>.age`:
  a zip encrypted with **age** to a **passphrase** I type twice (age's
  scrypt recipient), holding:
  - the database, taken with SQLite's `.backup()` (never a copied file);
  - the config folder's files (the terminal app's state);
  - every keychain entry of this data folder (name and value),
    re-encrypted inside the archive only, never written in clear;
  - `manifest.json`: Oraknid's version, the time, the counts, and each
    project's folder and repos.
  Not in it: projects' folders (paths listed; their repos are cloned
  again when needed), Leg logs and homes (a Leg logs in again), local
  models, backups' files, the keychain id.
- `oraknid import FILE` on a **fresh install** (no project, no job yet;
  `--replace` to replace a data folder that has some, after its own
  `.backup()` in `backups/`), with the daemon stopped: asks the
  passphrase, checks the archive, puts the database in place (migrated
  at the next start as any), restores the config files, and stores each
  secret in this computer's keychain under this data folder's own id.
  Then it lists the projects whose folder is missing here, with their
  repos to clone again (**Clone again** on such a project's page clones
  its linked repo into its folder).
- **Settings → About** has **Export everything** (the passphrase twice,
  a download through a one-time link, this computer only) and **Import**
  (a file and its passphrase; it is staged and applied when the daemon
  restarts, before the database opens). Both are home only, and only on
  this computer's browser; both are audited (`oraknid.exported`,
  `oraknid.imported`, never a secret).
- A wrong passphrase, a damaged archive or one from a newer Oraknid is
  refused before anything is replaced.

## As built (2026-10-07)
- `apps/daemon/src/moving/`: `zip.ts` (a small zip writer and reader:
  deflate or store, CRC checked, names relative with no `..`, 500 MB
  inflated at most for a records zip), `records.ts` (export and import of
  jobs), `move.ts` (the archive), `reclone.ts` (Clone again),
  `routes.ts` (the two uploads). Archives are made in memory.
- A records zip holds `rows.json` beside `job.json` so the import puts
  the rows back as they were (an active job becomes `cancelled`, its
  worktree null, its sessions' logs under this data folder); sessions
  whose Legs aren't here are kept but not listed by `sessions.list`.
- The passphrase is 12 characters or more (the archive's only lock).
- The web's import stages the database; there is no restart from the
  page: "Restart Oraknid to finish" (`oraknid stop`, `oraknid start`).
- The CLI's `oraknid export --all` reads the keychain itself (the
  encrypted file's passphrase is asked when there is no keychain) and
  the database through `.backup()` of the file, with or without the
  daemon running; `oraknid import` needs it stopped.

## Consequences
- The archive holds every secret; its passphrase is the only lock. I
  keep it as I keep a password manager's export.
- Legs need logging in again on the new computer, and Oraknid's own
  server keys travel (they are keychain entries), so servers keep
  working from the new computer.

## Why age
Already used for backups (ADR-044), a small audited format, and a
passphrase recipient built in.

Related: [[Persistence-and-Recovery]] · [[Security]] · [[Data-Map]] · [[ADR-044-Backups]]
