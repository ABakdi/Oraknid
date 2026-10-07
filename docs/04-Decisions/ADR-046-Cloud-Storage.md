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
  (nothing makes a file public; *2026-10-07:* the storage tool's
  `share_link`, always asked, below); a token rclone refreshes while Oraknid
  writes the config at the same moment could be lost (writes are
  serialised among Oraknid's own, not against rclone's).

## As built (2026-10-04, M13.16): every provider rclone supports
- **The schema** (`@oraknid/core` → `rclone.ts`, shared by the daemon
  and the web form): `rclone config providers` (JSON) read into the
  backends offered: 55 of rclone v1.75.1's 69, leaving out the wrappers
  (alias, cache, chunker, combine, compress, crypt, hasher, union), this
  computer (local, memory), the read-only ones (http, doi, archive) and
  hidden ones (tardigrade, an old name of storj). Hidden options are
  dropped. An option is a **secret** (a password field, scrubbed from
  errors) when rclone keeps it obscured (`IsPassword`) or marks it
  sensitive and its name says pass, secret, key, token, cookie,
  credentials, pem …; addresses and user names marked sensitive stay
  text. **Signs in through a browser**: drive, dropbox, onedrive, box,
  pcloud, yandex, zoho, hidrive, premiumizeme, putio, sharefile,
  google photos, google cloud storage, huaweidrive (each answered
  `rclone authorize <backend>` here; a backend with `token` and
  `client_id` options is taken as one too, except mailru, jottacloud,
  linkbox, filefabric and shade, whose tokens come another way); for
  those, rclone's own app: token, client id and secret, auth and token
  URLs are left out of the form. Object storage (buckets): s3, b2, gcs,
  azureblob, swift, oracleobjectstorage, qingstor, storj, and any
  rclone's `backend features` says is bucket-based.
- **Read once per rclone version**: at the daemon's start (not
  blocking it), without Oraknid's config (`--config /dev/null`), kept in
  memory and in `<data>/cloud/backends-<hash of the version and the
  format>.json`. `cloud.backends` gives the list without options,
  `cloud.backend` one backend's options ([[API-Contract]]).
- **The form** (`formModel`): the sub-provider first when a backend has
  a `provider` option with choices (s3's 53, koofr, storj,
  oracleobjectstorage), required to go on; options conditioned on
  another sub-provider (rclone's `Provider`, `!` for all but) left out,
  each option once (Koofr's password is listed per service), choices
  filtered the same way; required options without a default first, the
  everyday ones, the advanced ones apart. `checkOptions` checks what
  comes back: unknown or another service's options, required ones,
  booleans, whole numbers, sizes (`64M`, `5Gi`, `off`), durations
  (`1h30m`), choices of an exclusive option; a PEM key's line breaks
  become `\n` as rclone wants, a credentials JSON one line.
- **Adding** (`cloud.addRclone`): the section written as for the short
  forms (`IsPassword` values obscured through `rclone obscure -` on
  stdin; a browser sign-in's token and the fields rclone set beside it,
  as its authorize is always given a blob of the form's everyday,
  non-secret options, so Zoho's region goes in and pCloud's host comes
  back). Then **rclone's own setup**, `config update <remote>
  --non-interactive`, with `RCLONE_CONTINUE`, `RCLONE_STATE` and
  `RCLONE_RESULT` in its environment, never its command line: "token
  already configured, replace it?" is answered no; a step with nothing
  to ask goes on; anything else is a **question** (`cloud.answerRclone`,
  its answer checked against the choices) with what was wrong with the
  last answer; serialised with Oraknid's own writes of the config. Then
  `backend features` (About, BucketBased; a bucket-based one without a
  bucket is refused), the folder made and listed, the row kept (kind
  `rclone`, `info`: backend, title, sub-provider, about, bucket; no
  value of the form). A failure or a cancel (`cancelRclone`, or 15
  minutes) removes the section.
- **Free space**: `about` when rclone says the backend has it; when it
  fails or says no free space (an SFTP server without a shell, a WebDAV
  server without quotas) and `size` answers, the provider is marked as
  one that can't tell: a limit of mine or pay as you go, as for object
  storage, else used only when picked. "By size" placement sends large
  files to the bucket-based ones.
- **Tested**: the schema and the form against what the real rclone
  v1.75.1 printed (recorded, gzipped, the user name made "me"); the
  generic path end to end with the real rclone against SFTP (atmoz/sftp
  in a throwaway unprivileged container) and WebDAV (`rclone serve
  webdav` started by the test): added from the form, a file uploaded,
  listed, downloaded, a wrong password refused in rclone's words, the
  passwords on no command line (`/proc` sampled while adding and
  uploading), in no view, event or row; a config rclone itself wrote
  read back. OneDrive's sign-in and questions, a two-factor code, a
  failing and a cancelled setup with a stand-in rclone.
- **Not yet**: the backends' own client id and secret (rclone's app
  only); a question rclone asks that needs a browser of its own
  (Jottacloud's "traditional" sign-in: its personal login token works);
  a provider's options can't be changed after it is added (remove and
  add again).

## As built (2026-10-07): the storage tool
What the Decision said of agents ("nothing of it unless a job's skill asks
for a storage tool, declared and gated like any tool") is built:
- **`storage`, one of Oraknid's own tools** (`apps/daemon/src/cloud/tool.ts`),
  answered by the broker in the daemon like `email` and `github`, so no
  credential leaves it. It is registered once there is a provider (at
  start, and when one is added); a job has it only when its skill asks for
  it (`requires.tools: [storage]`), and a job asking for it can't start
  while there is no provider (the tool is missing).
- **Its calls**: `list` (a folder of the pool, or a search under it, each
  file with its provider's id) and `download` (a file into the job's
  folder, never over a file) are declared reads; `upload` (a file of the
  job's folder, where the placement rule puts it or the provider named) is
  a write, judged by the job's policy (`external-write`); `share_link` (a
  public link, `rclone link`, with an expiry where the provider takes one)
  is judged as `send`: always asked, never waived by autonomy. A provider
  without links (WebDAV, SFTP…) says so in words. Each link made is an
  event (`cloud.file.shared`).
- **Inside the job's folder only**: paths relative to it, resolved by real
  path (a link pointing out is refused), never a hidden file or folder
  (`.git`, `.oraknid`). What it returns (file names, a provider's words)
  is wrapped as untrusted data, and the task is untrusted from then on.
- **Tested** (`cloud/tool.test.ts`) with a real rclone against its own
  WebDAV server started by the test: offered once a provider exists, a
  job's file uploaded, listed, searched, downloaded into the job's folder,
  the refusals (over a file, out of the folder, absolute, hidden, a link
  out), WebDAV's lack of public links said; the policy's verdicts on each
  call. Not yet: a public link made on a real Drive or Dropbox.

Related: [[ADR-044-Backups]] · [[ADR-021-Tools-Broker]] · [[Security]] · [[Web-UI]]
