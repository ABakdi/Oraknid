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

## Changed (2026-10-04): every provider rclone supports
Not a fixed list: the providers are rclone's own (its `config providers`
schema: some seventy, from OneDrive, pCloud, Box, Backblaze B2, SFTP,
WebDAV, FTP, Proton Drive, iCloud Drive and the S3 family to the
storage of each cloud), each added with a form made from rclone's
description of it: its required options first, the rest under
Advanced, secrets as password fields kept only in the encrypted
config. Providers that sign in through a browser use rclone's
authorization as Drive and Dropbox do. Google Drive, Dropbox, MEGA and
S3 keep their short forms; the rest come from rclone's schema, searched
by name.

## Consequences
- rclone is a new dependency; without it Cloud storage says how to
  install it.
- Free space comes from each provider (`rclone about`); a provider that
  can't tell is used only when I pick it.

## As built (2026-10-04, M13.15)
- **rclone** (`apps/daemon/src/cloud/rclone.ts`): found by
  `ORAKNID_RCLONE` or on the `PATH`; `install.sh` installs it as
  recommended, `oraknid doctor` reports it. Run per command with
  `--config <data>/cloud/rclone.conf --ask-password=false
  --use-json-log`, the config's password in `RCLONE_CONFIG_PASS`. Oraknid
  writes the config itself in rclone's encrypted format (NaCl secretbox,
  read back by rclone in the tests), so no credential is ever an
  argument; MEGA's password is obscured through `rclone obscure -` on
  stdin. The password: `cloud.rclone.password` in the keychain, made on
  first use.
- **Providers** (`cloud_providers`, migration 0034; `cloud.*` in
  [[API-Contract]]): S3 with a preset (MinIO, AWS, R2 = rclone's
  Cloudflare, B2 and Other = Other, Wasabi), `acl = private`,
  `no_check_bucket` (adding makes the bucket); Drive (`scope = drive`)
  and Dropbox from `rclone authorize <kind> --auth-no-open-browser`, its
  127.0.0.1 address shown and its pasted token read (the token itself,
  or rclone's base64 blob of fields); MEGA. Each may show only a folder
  of the account. A provider is checked (made, then listed) before it is
  kept. Free space: `about --json`; object storage can't say (S3's
  `about` isn't supported), so it has **a space limit I set** (free =
  limit − `size --json`) or **pay as you go** (never full), else it is
  used only when picked.
- **The pool**: `lsjson` of each provider's folder at once, folders
  merged by path, a provider that fails named beside the listing;
  search is `lsjson -R --files-only --ignore-case --include *words*`
  (500 at most). Moves are `moveto` (across providers: copied, then
  removed); a folder renames or `purge`s in every provider holding it.
  New folders are opened empty and kept once a file goes in (object
  storage has no empty folders).
- **Placement** (`@oraknid/core` → `choosePlace`, `cloud.placement` in
  settings): most free, priority order, or by size (from
  `largeFromBytes`, object storage first; smaller files the others
  first, either when only one fits); a provider whose last check failed
  isn't chosen automatically. Too big for any one place is refused with
  the biggest room said.
- **Upload**: `POST /api/cloud/upload` with the file as the body (one
  request per file, not multipart: no parser, and each file is placed
  and refused on its own before its bytes come); streamed into
  `<data>/tmp/cloud`, then `rclone copyto` with `--stats 500ms`;
  `transfer` frames (receive, send, done, failed) to sockets subscribed
  to `storage`. **Download**: `cloud.downloadLink` → `GET
  /download/<token>`, `rclone cat` streamed. Both refused away from
  home: the tunnel carries text.
- **Backups**: [[ADR-044-Backups]] → As built.
- **The helper** (`helper/cloud-actions.ts`): `storage_list`,
  `storage_search` (read, names as untrusted data), `upload_to_storage`
  (asked; a file I name, never hidden, in a hidden folder or in the data
  folder), `move_in_storage`, `download_from_storage` (to a folder here,
  never over a file), `delete_from_storage` (asked).
- **Web**: Cloud storage (`/storage/<path>`, `g y`), the pool, Providers
  and Where uploads go ([[Web-UI]] → Cloud storage); a backup's Download.
- **Tested**: against a real MinIO (Chainguard's image, as MinIO stopped
  publishing its own) in a throwaway unprivileged container and a real
  rclone; Drive, Dropbox and MEGA with a stand-in rclone, no account.
- **Not yet**: uploads and downloads away from home; a public link
  (nothing makes a file public); a token rclone refreshes while Oraknid
  writes the config at the same moment could be lost (writes are
  serialised among Oraknid's own, not against rclone's).

Related: [[ADR-044-Backups]] · [[ADR-021-Tools-Broker]] · [[Security]] · [[Web-UI]]
