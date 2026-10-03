# ADR-046 — Cloud storage: my providers as one pool

**Status:** Accepted · 2026-10-03

## Context
I want my storage accounts (Google Drive, Dropbox, MEGA, and any
S3-compatible object storage such as MinIO, Backblaze B2, Cloudflare R2,
Wasabi, AWS S3) in Oraknid, seen as one big pool: I upload, Oraknid
puts the file where it fits best, or I choose. Backups (ADR-044) should
be able to go there too, and be downloaded to this computer.

## Decision
- **Cloud storage**, in the sidebar (`/storage`, `g y`): my providers
  (add, check, rename, remove; each with its used and free space), and
  **the pool**: one listing of everything across them, with folders,
  search, upload (drag and drop, several files, progress), download,
  rename, move, delete (asks). Each file shows where it lives.
- **Where an upload goes**: **Automatic** by a rule I set (most free
  space first, or a priority order, or by kind: large files to object
  storage), or **a provider I pick**. A file too big for any one place
  is refused, never split.
- **Providers through rclone**: Oraknid runs `rclone` (installed by
  `install.sh`, found by `doctor`) with a config it owns, kept encrypted
  with a password from the keychain. Google Drive and Dropbox sign in
  through rclone's own authorization in the browser (rclone's app, so no
  app of mine to register); MEGA with its email and password; S3 with an
  endpoint, region, bucket, access key and secret. Credentials never
  leave the keychain and the encrypted config, never reach a Leg.
- **Backups' destinations** gain: **cloud storage** (the pool, or one
  provider), and **this computer** remains; every backup can be
  **downloaded** from the web page (decrypted only if I ask and only
  with the key, else as stored).
- **The helper** can list, upload (a file I give it), move and download
  for me; deletes and anything leaving a file public ask first. Agents
  get nothing of it unless a job's skill asks for a storage tool,
  declared and gated like any tool (ADR-021).

## Consequences
- rclone is a new dependency; without it Cloud storage says how to
  install it.
- Free space comes from each provider (`rclone about`); a provider that
  can't tell is used only when I pick it.

Related: [[ADR-044-Backups]] · [[ADR-021-Tools-Broker]] · [[Security]] · [[Web-UI]]
