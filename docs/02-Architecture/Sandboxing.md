# Sandboxing

[[ADR-006-Sandbox]] in practice.

## Worktrees

- Job start: `git worktree add .oraknid/worktrees/<job> -b oraknid/<job-slug> <work branch>`.
- Checkpoints: commits on `refs/oraknid/<job>/<task>/<n>`, made by The
  Eye (never by a Leg), with `--no-verify`, and never pushed.
- Job end: the branch stays for review. Merging into the work branch is
  the gated `merge` action. Removing the worktree happens on my request.
- Non-git projects: a shadow repo `.oraknid/shadow.git` with
  `--work-tree` set to the project. The job works in place.

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
- Verification commands run in the same wrapper, without the Leg home.
- Network is shared. Localhost model servers are reachable.

## Command policy

The deny and allow lists ([[Security]]) are checked in the adapter's
permission hook before a command reaches the sandbox. The sandbox is
the second wall, not the first.

Related: [[ADR-006-Sandbox]] · [[Security]] · [[Drift-Control]]
