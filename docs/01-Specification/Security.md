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
  a later hardening item.

## Command allow/deny list

- Evaluated on every command a Leg wants to run (through the adapter's
  permission hook) and on every command The Eye runs.
- Shipped defaults deny destructive and escalating patterns (`rm -rf /`,
  `sudo`, `chmod -R 777`, `curl … | sh`, writes to `~/.ssh`, and so on)
  and gate `git push`, publishing and deploy commands.
- Editable globally, per project and per job. More specific wins. Deny
  beats allow at the same level.

## Prompt injection (BR-15)

- Untrusted content (email bodies, web pages, issue text, files from
  inputs marked untrusted) is wrapped and labelled as data in every
  prompt, with an instruction not to follow it.
- A task whose context contains untrusted content can't trigger a gated
  action without an approval, whatever the autonomy level.
- MCP tools that write externally are always `external-write` gated.
- Suspicious content (instructions aimed at the agent) is flagged in
  the UI.

## The daemon's own surface

- The HTTP/WebSocket API listens on `127.0.0.1` only by default. Until
  pairing exists, it also refuses any request whose `Host` isn't a local
  name (stops DNS rebinding) or whose `Origin` is another site (stops a
  web page in my browser from calling it).
- Every client must be a **paired device**. Pairing happens from the
  local machine: the CLI or UI shows a short code, which the new device
  enters. Devices hold a key and get short-lived session tokens. Any
  device can be revoked.
- Exposing the daemon on the local network (so my phone can reach it
  before The Nest exists) is an explicit setting, served over HTTPS with
  a local certificate.
- Remote access goes only through The Nest ([[The-Nest]]).

## Audit log (BR-16)

Append-only table, also exported daily to a JSONL file. Each entry
records the time, the actor (owner/device, eye, leg), the job and task,
the action, its inputs (secrets scrubbed) and its outcome. The UI can
search and filter it.

Related: [[Sandboxing]] · [[Approvals-and-Autonomy]] · [[The-Nest]] · [[Data-Map]]
