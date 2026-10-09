# Security

**Is:** how Oraknid keeps Legs, untrusted input and remote access from
harming my machine, my accounts or my data.
**Is not:** a guarantee against a fully compromised Leg binary. The
sandbox limits damage, but it doesn't make that safe.

## Secrets (BR-13)

- Stored in the OS keychain (Secret Service / libsecret on Linux). If
  no keychain is available, an encrypted file store is used, with a key
  derived from a passphrase I enter at daemon start. The UI says which
  one is in use.
- Each data folder has entries of its own in the keychain (2026-10-03,
  [[Audit-2]] S2-23): they are kept under the service
  `oraknid:<id>`, where the id is made once and kept in the folder
  (`keychain-id`, 0600). A second daemon on another data folder (a
  test) never reads or replaces the first one's secrets. The entries
  of before, all under `oraknid`, belong to the default data folder:
  its daemon moves each one under its own service at start (copied,
  read back, then removed; a count is logged, never a value), and one
  it could not list moves when it is next read. A copy of a data folder
  keeps its id, and so shares its entries.
- Referenced by name. Resolved only when a process starts, passed by
  environment to that process only, never logged. Log output is
  scrubbed of known secret values.

## Project secrets (2026-10-07, [[ADR-059-Project-Secrets]])
- A project's secrets (per environment: `dev`, `testing`, `production`)
  are values in the keychain (`project.secret.<id>`); SQLite has only
  their names (`project_secrets`). No call, view, event, export or
  helper action returns a value: the UI shows `••••••••` and offers
  Replace and Remove only. Names Oraknid sets itself (`PATH`, `HOME`,
  `ORAKNID_*`, `GIT_*`, `CLAUDE_*`, `CODEX_*`, `OPENCODE_*`, `XDG_*`,
  `LD_*`, `SSH_*`…) are refused.
- A job's sessions get its own project's secrets of its environment as
  variables in the sandbox's clean environment; another project's never.
  Unsandboxed jobs, The Eye's planning, chats and the helper get none.
  Like the Legs' own keys, they reach the sandbox through a private
  0600 file read and deleted at its start, never its command line,
  which every user of the computer can read; software running as me
  could still read a running session's environment (this computer is
  mine alone, above).
- On a server they are written by the daemon (the `env` tool's
  `write_env_file`), never by the agent: `umask 077`, a temporary file
  renamed into place, `chmod 600`, the values on the command's stdin,
  never on a command line (a test reads every command the server ran).
  Only to one of the job's servers; production values only to a
  production server. The call is an `external-write`, a `deploy` for
  production values, through the Gate.
- Every value read becomes a known secret, so events, Leg logs, Silk,
  results and exports are scrubbed of it. Setting, replacing and
  removing are audited by name (`project.secret.set`, `.removed`,
  `project.secrets.used`, `project.secret.written`). Away from home,
  changing them needs a device with full rights. Deleting a project
  deletes its secrets.

## Filesystem and process scope (BR-12)

- Each job works in its own git worktree under the project, or in the
  project folder for non-git projects.
- Leg processes run inside a sandbox limited to the worktree, their own
  config directory, and read-only system paths ([[Sandboxing]]).
- The internet is allowed (Legs need their APIs), but not this
  computer's own services: with `pasta` installed, every sandbox has a
  network namespace of its own, and only the ports a project lists
  (Projects → Network) and a Leg's own local model are reachable, as
  localhost inside ([[Sandboxing]], [[Audit-2]] S2-21). Without `pasta`
  the host's network is shared, and `oraknid doctor` says so. Every
  sandbox also runs under Landlock, so the desktop's abstract sockets
  are out of reach (S2-01).
- **Git works inside the sandbox** (M13.22, 2026-10-04): a job's
  worktree gets the project's `.git` as a throwaway layer in which only
  the objects, refs, logs and the worktree's own git folder are the real
  ones, writable; its config and hooks are read-only, the worktree's
  links to the repository too, and anything else written there is gone
  with the sandbox ([[Sandboxing]] → Git in a job's worktree). Everyday
  git on the job's branch (`status`, `diff`, `log`, `add`, `commit`,
  `switch -c`, `stash`) is on the allow list and never asks, untrusted
  or not; a push, a merge or deleting a branch stays gated.
- A Leg's scratch, written without asking: its sandbox's `/tmp`, its
  home for the job (its own `tmp`, caches and config), and its Leg's
  `tmp` and cache. Anywhere else outside its folder is refused
  ([[Approvals-and-Autonomy]] → Writing outside its folder).
- **Nothing a Leg can write is trusted by Oraknid's own tools** (BR-22,
  [[Audit-1]]): git calls on a worktree use the main repo's records,
  never the worktree's `.git`, with fsmonitor and hooks off; shadow repos
  live in Oraknid's data folder; links in the Silk mirror are never
  followed; checks run with a throwaway home.
- Oraknid's data folder is mine alone (0700).

## Command allow/deny list

- Evaluated on every command a Leg wants to run (through the adapter's
  permission hook) and on every command The Eye runs. Since 2026-10-07
  every source goes through one Gate ([[ADR-056-The-Harness]] §3): a
  Leg's permission prompt, Claude Code's PreToolUse hook, a job's tool
  through the MCP broker, a command on a job's server, a check's
  command; one list of credential paths and lockfiles serves every rule
  (`packages/contracts` `sensitive.ts`).
- Shipped defaults deny destructive and escalating patterns (`rm -rf /`,
  `sudo`, `chmod -R 777`, `curl … | sh`, writes to `~/.ssh`,
  force-pushes, and so on) and gate `git push`, merges, publishing,
  deploys and system installs.
- Since auto mode ([[ADR-053-Auto-Mode]]) a shell command is parsed with
  tree-sitter-bash, its `sh -c` scripts and the command an `ssh` runs
  on the far side read again, and checked by CC Safety Net (with its
  Terraform and cloud rulebooks, from a configuration home of
  Oraknid's own, tighten-only for a project), our rules for its gaps,
  and a scan for credentials in what goes out (secretlint and
  gitleaks-style patterns). What only reads, edits the job's folder, or
  is the project's own build, test or lint runs at once; the rest goes
  to the judge, a model that sees my words, the task and the action,
  never the agent's prose or output. The fixed program lists of
  [[ADR-014-Auto-Approval]] are the fallback when the parser can't run.
- Global options are taken out before the lists are read, so `git -C .
  push` is a push. Fetching and running code (`npx <package>`, `dlx`,
  `pip install`) or inline code (`node -e`, `python -c`) goes to the
  judge.
- Reading a credential (`.env`, `~/.ssh`, `~/.aws`, `.netrc`…) is refused,
  with a shell command or a file tool.
- Checks (verify commands) obey the same lists: a never-allowed or
  gated check is a failed check, never run.
- Editable globally, per project and per job. More specific wins. Deny
  beats allow at the same level.

## Prompt injection (BR-15)

- Untrusted content (email bodies, web pages, issue text, files from
  inputs marked untrusted) is wrapped and labelled as data in every
  prompt, with an instruction not to follow it.
- A task whose context contains untrusted content can't trigger a gated
  action without an approval, whatever the autonomy level or waivers.
- Job inputs are marked untrusted when I create the job, and a task
  becomes untrusted once it reads from the web (WebFetch, WebSearch,
  `curl`, `wget`).
- Untrusted changes only the gated actions (and calls of the job's tools
  that write): a research task reads the web as its job, and everything
  else goes on as before: its edits, its scratch, its tests, and its
  everyday git on the job's branch never ask (M13.22, a test runs each
  untrusted).
- MCP tools reach a Leg only through Oraknid's broker
  ([[ADR-021-Tools-Broker]]): the server runs in its own sandbox with
  its secrets, which the Leg never sees. A call a tool declares as a
  read passes; a send is the gated action `send`; anything else is
  `external-write` (waivable per job). What an untrusted tool returns is
  wrapped as data, and the task is untrusted from then on.
- The judge and the second look get the command or a Leg's report as
  JSON data, never as instructions; the judge reads no files and sees
  none of the agent's prose or tool output (reasoning-blind, ADR-053).
- Suspicious content (instructions aimed at the agent) is flagged in
  the UI.

## GitHub tokens
- The tokens I paste for GitHub ([[ADR-023-GitHub-By-Token]], several
  accounts since [[ADR-038-Project-Accounts]]) are in the keychain, one
  per account (`github.token.<login>`; the one token of before stays
  under `github.token`, named by its account, never read out or
  copied), given to `git` only through `GIT_ASKPASS` for one command,
  never written in a URL, a remote or a config file, and never given to
  a Leg: GitHub work is done by the daemon's `github` tool, and a Leg's
  context tells it never to use the `gh` CLI or a token. git's output is
  scrubbed of the token before anyone sees it.
- Repos ([[ADR-040-Repos-Page]]) reads my repositories in the daemon
  with the account's token; a browser gets what GitHub said, never a
  token. A file's text is shown escaped (syntax colouring adds only its
  own spans), a README or a pull request's description as Markdown
  without raw HTML or images. Reading works away from home; creating a
  repository, adding or removing an account and changing a project's
  GitHub link are done at home or on a device with full rights.
- GitLab, Gitea and Forgejo ([[ADR-062-Git-Hosts]]) the same way: a
  personal access token per account, checked against its host and kept
  in the keychain (`githost.token.<host>.<login>`), given to git only
  through `GIT_ASKPASS` (GitLab's user `oauth2`, Gitea's the login), its
  output scrubbed; a host's address over plain http only to this
  computer. Adding and removing such an account and creating a
  repository there are home only for a standard device.
- Work on a project's linked repo (creating it as I chose, pushing a
  branch, a pull request) runs without asking: the link is my approval.
  A push anywhere else, a force-push, or linked work in a task that read
  untrusted content asks ([[Approvals-and-Autonomy]] → Linked work).

## Servers and the terminal
- Server credentials are in the keychain; a password is used once to
  install Oraknid's own key for that server, then deleted. Host keys are
  pinned; a changed one stops every connection until I accept it
  ([[ADR-026-Servers]]). Discovery only reads.
- A job gets a server only when its project has it; its Leg then has
  that server's key in its own home, and its commands there go through
  the approvals.
- The terminal is off until I turn it on, needs a paired and unlocked
  device, and is audited; it is a full shell as me ([[ADR-028-Terminal]]).
  Away from home it opens only on a device with full rights, through
  the tunnel ([[ADR-030-Device-Rights]]).
- What runs on a server is read by oraknid-monitor, which only reads,
  as the server's user: no root asked; what it can't read says why
  ([[ADR-043-Server-Insight]]). Log sources are checked (`unit:`,
  `container:`, `file:` with a full path and no `..`) on both sides; a
  followed log stops on the server when its screen closes. Restarting a
  container or a service asks first, takes `confirm: true`, only names
  what the server has, is home only for a device without full rights,
  and every attempt is in the audit log. What a server prints (logs,
  names) reaches the helper as untrusted data.

## Backups (2026-10-03, [[ADR-044-Backups]])
- A database's password is in the keychain, given to the dump on the
  server as the first line of its stdin and handed on in the
  environment by name (`docker exec -e NAME`), or for MongoDB in a file
  only its user can read, removed when the run ends: never on a command
  line (tested by watching every process's command line during real
  dumps), never in a log or an event; a tool's error is scrubbed of it.
- age private keys are made by Oraknid and kept in the keychain; I can
  take one away once. They are used only for Verify and Restore, never
  shown again, never given to the helper or an agent.
- Backups are written mine-only (0600 in 0700 folders here, `umask
  077` on a server), as `.part` until the dump ends well.
- Restoring always takes two steps (what it replaces, then the
  database's name typed back) and is only mine: no agent tool reaches
  backups, and the helper has no restore action. A backup is
  downloaded (as stored, or decrypted with its key) only to a browser
  on this computer, through a one-time link. Away from home,
  changing plans or keys and restoring need a device with full rights.

## Cloud storage (2026-10-03, [[ADR-046-Cloud-Storage]])
- Providers' credentials (S3 keys, Google Drive and Dropbox tokens,
  MEGA's password) are written only into Oraknid's own rclone config,
  encrypted with rclone's config encryption; its password is in the
  keychain and reaches rclone in its environment. No credential is on a
  command line (tested by watching every process's command line while
  rclone runs against a real MinIO), in SQLite, a view, an event or a
  log; an error from adding one is scrubbed of the secret. Without the
  keychain's password the config can't be read (tested with rclone).
- Google Drive and Dropbox sign in through rclone's own authorization,
  on 127.0.0.1, so only a browser on this computer can finish it; the
  token is held in memory until the provider is added, then only in the
  config. Adding, changing or removing a provider, and starting a
  sign-in, are home only for a standard device.
- Uploads are refused before a byte is read when nothing can take them;
  they wait in a mine-only temporary folder and are removed after.
  Downloads are links made by a paired, unlocked device's call, good once
  and for two minutes, streamed; uploads and downloads are this computer
  only. Object storage is written private (`acl = private`); nothing
  makes a file public.
- Paths are kept inside each provider's root (no `.` or `..`). Deleting
  asks first, on the page and in the helper; the helper's uploads ask
  first too, and it never sends a hidden file, one in a hidden folder,
  or anything of Oraknid's data folder. File names are untrusted data
  to it.
- Agents reach cloud storage only through Oraknid's `storage` tool, and
  only in a job whose skill asks for it ([[ADR-046-Cloud-Storage]] →
  The storage tool): listing and downloading into the job's folder pass,
  an upload of a job's file is a write the job's policy judges, a public
  link always asks. Files go only from and into the job's own folder, by
  real path, never a hidden one or Git's; the providers' credentials
  never leave the daemon, and what the tool returns is untrusted data.

## Moving Oraknid (2026-10-07, [[ADR-061-Moving-Oraknid]])
- `oraknid export --all` (or Settings → About) holds every keychain entry
  of this data folder (server keys, tokens, passwords, project secrets)
  inside an archive encrypted with age to my passphrase (12 characters
  or more, typed twice; scrypt), never written in clear: the zip is
  made in memory and encrypted before it is written or downloaded.
  The web's export is a one-time link for this computer's browser only,
  home only whatever the device's rights (`moving.*`); so is the import.
- `oraknid import` stores each secret in the new computer's keychain
  under that data folder's own id; it refuses a data folder that has
  projects or jobs unless `--replace` (its database kept with
  `.backup()` first), and refuses a wrong passphrase or a damaged
  archive before anything is written.
- A job's or a project's zip is scrubbed of known secrets and
  secret-shaped text like `jobs.export`; it holds no keychain value.

## Mail
- Mail passwords (app passwords) are in the keychain, never in SQLite.
  An account is saved only once its incoming server (IMAP or POP3) and
  its SMTP server accept the login, over TLS or STARTTLS; a connection
  without TLS is refused unless the server is this machine
  ([[ADR-032-Email]]).
- Gmail and Outlook may sign in with Google or Microsoft instead
  ([[ADR-063-Mail-OAuth]]), through an app I register: its client id a
  setting, Google's client secret in the keychain; the browser sign-in
  uses PKCE and comes back only to this daemon on 127.0.0.1, accepted
  only for a sign-in started here (a random state, fifteen minutes);
  Microsoft's may be a code typed on its page. The refresh token is in
  the keychain (`mail.<account>.refresh`), access tokens only in memory;
  none is in an event, a view or a log. Setting an app and signing in
  are home only.
- A login refused stops that account and shows "Reconnect"; nothing
  retries a refused password.
- POP accounts keep their messages here: each one's bytes in
  `mail/local/<account>/` in the data folder (only I can read it), its
  text in SQLite. Removing the account deletes both. A message is
  deleted on the server only when I delete it for good here and turned
  on "delete from the server" for the account.
- Mail's HTML is cleaned with DOMPurify and shown in a sandboxed frame
  where no script runs, with its own content policy: nothing loads from
  outside; remote images I allow for a message or its sender are fetched
  by the daemon (public addresses only) and given to the frame inline.
- Agents reach mail only through the email tool in the broker: reads
  pass, labels, moves, flags and drafts are external writes, and `send`
  never sends on its own: an agent's draft waits for my approval (in
  Mail, and in the inbox when a job wrote it) unless I turn on
  auto-send for the account. Everything the tool returns is wrapped as
  untrusted data, and every agent action on mail is in the audit log
  (`mail.agent.*`, actor `agent`).
- Away from home, accounts can't be added, changed, reconnected or
  removed, unless the device has full rights.

## Chats and the helper
- A chat may read its folder and the projects I attach, and research
  the web; nothing else ([[ADR-025-Chats]]). The helper acts only
  through Oraknid's API with my device's rights, and asks before
  creating a project, adding a Leg, starting a job, creating a repo,
  deleting or waiving a gate ([[ADR-024-Oraknid-Helper]]). Creating a
  project and adding a Leg are confirmed only at home, or from a device
  with full rights ([[Audit-2]] S2-04).

## The daemon's own surface

- The HTTP/WebSocket API listens on `127.0.0.1` only by default. Until
  pairing exists, it also refuses any request whose `Host` isn't a local
  name (stops DNS rebinding) or whose `Origin` is another site (stops a
  web page in my browser from calling it).
- Every client must be a **paired device**. Pairing happens from the
  local machine: `oraknid pair` (or Settings → Devices) shows a
  six-digit code, valid five minutes and usable once, which the new
  device enters; five wrong codes cancel every open one; `oraknid open` pairs this machine's browser by itself.
  A device gets a long-lived token, kept by the daemon only as a hash,
  and any device can be revoked. The CLI's token is new at every start,
  in a file only my user can read. A token in the address is accepted
  only by the live socket. Secrets are scrubbed from events, logs, Silk
  and inbox text.
- **A PIN unlocks every device** ([[ADR-029-App-Lock]]): the daemon
  checks it, and each device's calls need an unlocked session as well
  as its token. Idle sessions lock; ten wrong PINs unpair the device.
- A pairing link for away (its QR code) expires if no device uses it
  within ten minutes, and needs the PIN on the device after.
- Exposing the daemon on the local network (so my phone can reach it
  before The Nest exists) is an explicit setting, served over HTTPS with
  a local certificate.
- Remote access goes only through The Nest ([[The-Nest]]). Away from
  home a device can follow, answer, approve and start jobs; what opens
  a new way in (the terminal, policies, projects, Legs, tools, skills,
  servers, GitHub, mail accounts, The Eye's models, a job outside the
  sandbox) is done at home only.
- **Device rights** ([[ADR-030-Device-Rights]]): a device is `standard`
  or `full`. Away from home, a device with full rights may do what it
  may at home, the terminal included, except what stays home only for
  every device: the PIN and the idle lock, pairing and revoking devices,
  giving rights, The Nest's configuration and registering on a public
  Nest, the encrypted store's passphrase. Rights are given at home, with
  the PIN again; a device can't widen itself. The device shows its full
  rights in the header, and each use of them away from home (a call a
  standard device couldn't make, the helper's too) is in the audit log
  as `device.awayUse` with the device and the call (2026-10-07).
- Every response carries a content policy: no framing by another site,
  scripts and images only from Oraknid itself; a request another site
  made my browser send, other than opening a page, is refused.
- **A review's frame** (2026-10-09, [[ADR-064-Design-And-Approval-By-Experience]]):
  what I review is served on an origin of its own, `rv-<key>.localhost`
  on the daemon's port (`<key>` 128 random bits per review), so a page
  an agent wrote runs apart from Oraknid's: it can't read the device's
  token or unlocked session, and its calls to `/api` aren't Oraknid's
  (there is no API on that origin). It answers only from this machine,
  only to a review's key that is not withdrawn, and may be framed only
  by Oraknid's own page (`frame-ancestors`); the review page talks to
  it only by `postMessage` and the frame has no top navigation. A
  design is served read-only from its folder, which must be inside the
  project's folder or the job's worktree: no `..` (plain or encoded), no
  dot file (`.git`, `.env`), symlinks resolved and checked again at
  every request; its pages may load nothing from elsewhere. An app is
  proxied to its own port on 127.0.0.1 and no other (never Oraknid's
  port, none below 1024; an absolute-form request can't name another).
  The overlay is added to HTML responses only; nothing is written into
  the project. Away from home a page comes inlined through the API, in a
  frame sandboxed without same-origin.
- Oraknid assumes a computer that is mine alone: software running as me
  can read its data, and another user could take its port while it is
  down ([[Audit-2]]).

## Audit log (BR-16)

The event stream is the audit log: append-only, also exported to
`logs/audit/<day>.jsonl` (each event once). Each entry records the time,
the actor (`owner`, `eye`, `leg:<id>`, `agent` for an agent's action on mail, `oraknid`), the job, the action
and its details. Before anything is stored, known secret values and
secret-shaped strings (API keys, tokens, private keys, bearer tokens)
are replaced with `[secret]`; Leg session logs are scrubbed the same
way. `audit.search` filters by job, type or type prefix, actor and
text.

Related: [[Sandboxing]] · [[Approvals-and-Autonomy]] · [[The-Nest]] · [[Data-Map]]
