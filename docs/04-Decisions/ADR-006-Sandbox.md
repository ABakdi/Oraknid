# ADR-006 — Each Leg runs in a git worktree inside a bubblewrap sandbox

**Status:** Accepted · 2026-10-01 · [[Phase-1-MVP]]

## Context
Legs run commands unattended on my machine (BR-12). Containers would be
the strongest isolation, but they're heavy and complicate GPU access for
local models. Agent permission settings alone are too weak.

## Decision
- Every job works in a **git worktree** of its project, on a job branch
  (from the work branch, BR-14). Non-git projects use a shadow repo.
- Every Leg process is launched through **bubblewrap** (`bwrap`):
  - all namespaces unshared except network
  - `--die-with-parent`, `--new-session`
  - read-only `/usr`, `/etc/ssl` and `/etc/resolv.conf`
  - read-only bind of the toolchain directories the project needs
    (detected: node and pnpm, cargo, python…)
  - read-write bind of the worktree and the Leg's own config directory only
  - a private `/tmp`
  - `HOME` set to a per-Leg directory
  - every secret not meant for this Leg unset
- The command allow/deny list applies on top, through each adapter's
  permission hook ([[Security]]).
- Local model servers (Ollama) run outside the sandbox as they do today.
  Legs reach them over the network.
- `oraknid doctor` checks that `bwrap` works (unprivileged user
  namespaces). If it doesn't, Oraknid refuses to run jobs until I
  explicitly choose "unsandboxed" for a job, which is audited and shown
  in red.

## Consequences
- Strong filesystem confinement at almost no cost. Arch allows
  unprivileged user namespaces.
- Network isn't restricted yet. A filtering proxy (e.g. Anthropic's
  `sandbox-runtime`, once it reaches 1.0) is a later hardening item.
- Windows needs a different mechanism (final phase: Job Objects with a
  restricted token, or WSL2 + bwrap). The sandbox sits behind an
  interface in `packages/os`.

## As built (2026-10-02 and 2026-10-03, [[Audit-2]])
- Every sandbox also runs under a **Landlock** domain that scopes
  abstract unix sockets and signals: the network namespace was shared,
  and with it the desktop's abstract sockets (S2-01).
- The network is restricted after all: with `pasta` (package `passt`),
  each sandbox has a **network namespace of its own**, with the internet
  and only the local ports a project lists or a Leg's own settings name
  (S2-21). Details in [[Sandboxing]].

## Why not containers
Heavier, slower to start per session, and GPU passthrough adds work.
Kept as a later option.

## Why not agent permission settings only
They depend on each agent's correctness and differ per agent. The
sandbox is uniform.

Related: [[Sandboxing]] · [[Security]]
