# Sandboxing

[[ADR-006-Sandbox]] in practice.

## Worktrees

- Job start: `git worktree add .oraknid/worktrees/<job> -b oraknid/<job-slug>-<last 6 of the job id> <work branch>`.
  The work branch is made from the release branch if it doesn't exist;
  a repo with no commit gets an empty first one.
- Checkpoints: commits on `refs/oraknid/<job>/<task>/<attempt>`, made by
  The Eye (never by a Leg) through a temporary index, and never pushed.
- Job end: the branch stays for review. Merging into the work branch is
  the gated `merge` action. Removing the worktree happens on my request.
- Non-git projects: a shadow repo in Oraknid's data folder
  (`shadow/<hash of the path>.git`, out of every Leg's reach) with
  `--work-tree` set to the project. The job works in place.
- Oraknid's git calls on a worktree pass `--git-dir` (the main repo's
  `worktrees/<job>`) and `--work-tree`, with `core.fsmonitor=false`,
  `core.hooksPath=/dev/null` and `core.fsync=committed` ([[Audit-1]]).

## The bwrap wrapper

The daemon generates one wrapper per Leg session:

```
bwrap --unshare-all --share-net --die-with-parent --new-session \
  --ro-bind /usr /usr --symlink usr/bin /bin --symlink usr/lib /lib --symlink usr/lib64 /lib64 \
  --ro-bind /etc/resolv.conf /etc/resolv.conf --ro-bind /etc/ssl /etc/ssl \
  --ro-bind /etc/ca-certificates /etc/ca-certificates \
  --proc /proc --dev /dev --tmpfs /tmp \
  --ro-bind <toolchain dirs> \
  --bind <worktree> <worktree> \
  --bind <leg home> <leg home> --setenv HOME <leg home> \
  --chdir <worktree> \
  --clearenv --setenv PATH … <only the variables this Leg needs> \
  -- <command>
```

- **Toolchain dirs**: every `PATH` entry under my home (system ones live
  under `/usr`, already bound), plus the real directory of the agent's
  binary (e.g. `~/.local/share/claude/versions`). Editing them per job
  arrives with the job settings.
- The **Leg home** holds the Leg's config dir (e.g. `CLAUDE_CONFIG_DIR`),
  so its login and sessions persist across sessions.
- Verification commands run in the same wrapper, with a throwaway home
  instead of the Leg's, after the command policy has allowed them.
- Network is shared (Legs need their APIs), so the wrapper runs under
  a **Landlock** domain first (`python3 -c <script> bwrap …`, Linux
  6.12+): abstract unix sockets and signals outside the sandbox are out
  of reach. Without it, a Leg could connect to the desktop's abstract
  sockets (a terminal's single-instance socket, X11) and run code
  outside the sandbox ([[Audit-2]] S2-01). `oraknid doctor` says whether
  it is on.
- Still reachable: TCP on the host's loopback (the daemon's API, which
  needs a token; other local services). Its own network namespace, with
  `pasta` giving it the internet only, is the next step ([[Audit-2]]).
- A Leg's `~/.ssh` is emptied at the start of every attempt and holds
  only that job's servers' keys ([[ADR-026-Servers]]).

## Command policy

The deny and allow lists ([[Security]]) are checked in the adapter's
permission hook before a command reaches the sandbox. The sandbox is
the second wall, not the first.

Related: [[ADR-006-Sandbox]] · [[Security]] · [[Drift-Control]]
