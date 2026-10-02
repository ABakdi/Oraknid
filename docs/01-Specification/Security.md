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
- Referenced by name. Resolved only when a process starts, passed by
  environment to that process only, never logged. Log output is
  scrubbed of known secret values.

## Filesystem and process scope (BR-12)

- Each job works in its own git worktree under the project, or in the
  project folder for non-git projects.
- Leg processes run inside a sandbox limited to the worktree, their own
  config directory, and read-only system paths ([[Sandboxing]]).
- Network is allowed (Legs need their APIs). Per-job network limits are
  a later hardening item (Phase 2).
- **Nothing a Leg can write is trusted by Oraknid's own tools** (BR-22,
  [[Audit-1]]): git calls on a worktree use the main repo's records,
  never the worktree's `.git`, with fsmonitor and hooks off; shadow repos
  live in Oraknid's data folder; links in the Silk mirror are never
  followed; checks run with a throwaway home.
- Oraknid's data folder is mine alone (0700).

## Command allow/deny list

- Evaluated on every command a Leg wants to run (through the adapter's
  permission hook) and on every command The Eye runs.
- Shipped defaults deny destructive and escalating patterns (`rm -rf /`,
  `sudo`, `chmod -R 777`, `curl … | sh`, writes to `~/.ssh`,
  force-pushes, and so on) and gate `git push`, merges, publishing,
  deploys and system installs.
- The allow list names ordinary development programs (shells, git, the
  package managers, test runners, coreutils). What else a command runs
  is decided by auto approval ([[ADR-014-Auto-Approval]]); at Supervised
  it asks me.
- Global options are taken out before the lists are read, so `git -C .
  push` is a push. Fetching and running code (`npx <package>`, `dlx`,
  `pip install`) or inline code (`node -e`, `python -c`) gets a look at
  Standard.
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
- MCP tools reach a Leg only through Oraknid's broker
  ([[ADR-021-Tools-Broker]]): the server runs in its own sandbox with
  its secrets, which the Leg never sees. A call a tool declares as a
  read passes; a send is the gated action `send`; anything else is
  `external-write` (waivable per job). What an untrusted tool returns is
  wrapped as data, and the task is untrusted from then on.
- The classifier and the second look get the command or a Leg's report
  as JSON data, never as instructions; the classifier reads no files.
- Suspicious content (instructions aimed at the agent) is flagged in
  the UI.

## GitHub token
- The token I paste for GitHub ([[ADR-023-GitHub-By-Token]]) is in the
  keychain, given to `git` only through `GIT_ASKPASS` for one command,
  never written in a URL, a remote or a config file, and never given to
  a Leg. A push with it is a gated action.

## Servers and the terminal
- Server credentials are in the keychain; a password is used once to
  install Oraknid's own key for that server, then deleted. Host keys are
  pinned; a changed one stops every connection until I accept it
  ([[ADR-026-Servers]]). Discovery only reads.
- A job gets a server only when its project has it; its Leg then has
  that server's key in its own home, and its commands there go through
  the approvals.
- The terminal is off until I turn it on, needs a paired device, and is
  audited; it is a full shell as me ([[ADR-028-Terminal]]).

## Chats and the helper
- A chat may read its folder and the projects I attach, and research
  the web; nothing else ([[ADR-025-Chats]]). The helper acts only
  through Oraknid's API with my device's rights, and asks before
  starting a job, creating a repo, deleting or waiving a gate
  ([[ADR-024-Oraknid-Helper]]).

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
  a new way in (pairing, the terminal, policies, projects, Legs, tools,
  servers, the PIN, a job outside the sandbox) is done at home only.
- Every response carries a content policy: no framing by another site,
  scripts and images only from Oraknid itself; a request another site
  made my browser send, other than opening a page, is refused.
- Oraknid assumes a computer that is mine alone: software running as me
  can read its data, and another user could take its port while it is
  down ([[Audit-2]]).

## Audit log (BR-16)

The event stream is the audit log: append-only, also exported to
`logs/audit/<day>.jsonl` (each event once). Each entry records the time,
the actor (`owner`, `eye`, `leg:<id>`, `oraknid`), the job, the action
and its details. Before anything is stored, known secret values and
secret-shaped strings (API keys, tokens, private keys, bearer tokens)
are replaced with `[secret]`; Leg session logs are scrubbed the same
way. `audit.search` filters by job, type or type prefix, actor and
text.

Related: [[Sandboxing]] · [[Approvals-and-Autonomy]] · [[The-Nest]] · [[Data-Map]]
