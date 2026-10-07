# Sandboxing

[[ADR-006-Sandbox]] in practice.

## Worktrees

- Job start: `git worktree add .oraknid/worktrees/<job> -b oraknid/<job-slug>-<last 6 of the job id> <work branch>`.
  The work branch is made from the release branch if it doesn't exist;
  a repo with no commit gets an empty first one. A follow-up job's
  branch starts from the ended job's branch instead (the setting
  `job.startFrom.<job>`; [[Jobs-and-Projects]] → Follow-up jobs).
- Checkpoints: commits on `refs/oraknid/<job>/<task>/<attempt>`, made by
  The Eye (never by a Leg) through a temporary index, and never pushed.
- Job end: the branch stays for review. Merging into the work branch is
  the gated `merge` action. Removing the worktree happens on my request
  (2026-10-07, `workspace/worktrees.ts`): **Remove worktree** on a
  finished job's result, or Settings → Storage → Finished jobs'
  worktrees, each with its size, and **Clean up finished jobs'
  worktrees**. Only a completed or cancelled job's; its own folder
  (`.oraknid/worktrees/<job>`, each repo's worktree in it) and its tasks'
  (`<job>-t-<n>`) go through `git worktree remove`, then `prune`; the
  branch stays. One with commits not merged into the work branch, or
  files not committed, is refused in words until I confirm; the clean-up
  leaves those and names them. Audited (`job.worktree-removed`).
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
  --bind <job's home on the Leg> … --setenv HOME <job's home> \
  --bind <each linked entry of the Leg's home> <the same path> \
  --tmpfs <project>/.git \
  --ro-bind <project>/.git/{config,hooks,HEAD,info,packed-refs,…} <the same paths> \
  --bind <project>/.git/{objects,refs,logs} <the same paths> \
  --bind <project>/.git/worktrees/<job> <the same path> \
  --ro-bind <worktree>/.git … --ro-bind <project>/.git/worktrees/<job>/{commondir,gitdir} … \
  --chdir <worktree> \
  --unsetenv PWD --unsetenv OLDPWD --unsetenv SHLVL --unsetenv _ \
  -- <command>
```

The line above is started as `env -i PATH=… sh -c '. <file>; rm <file>;
exec "$@"' <file> [pasta …] [landlock …] bwrap …`: the variables this Leg
needs (PATH, HOME, its keys, a project's secrets) come from a private
0600 file, read and deleted by that clean shell, and `bwrap` inherits
exactly them. No value is ever on a command line, which every user of
the computer can read (2026-10-08).

- **Toolchain dirs**: every `PATH` entry under my home (system ones live
  under `/usr`, already bound), plus the real directory of the agent's
  binary (e.g. `~/.local/share/claude/versions`). Editing them per job
  arrives with the job settings.
- The **Leg home** holds the Leg's config dir (e.g. `CLAUDE_CONFIG_DIR`),
  so its login and sessions persist across sessions.
- **A home per job** (2026-10-03, [[Audit-2]] S2-08): a job's sessions
  don't get the Leg's home but one of the job's own,
  `legs/<leg>/jobs/<job>/home` (and, for Claude Code, its own config
  folder beside it), beside the Leg's home, never inside it. Each entry
  of the Leg's home and config folder is linked into it, so the Leg's
  login and settings serve every job and a refreshed token reaches the
  Leg; the sandbox binds those entries at their own path, never the
  Leg's home as a whole. Not linked, so each job's own: `~/.ssh`,
  `~/.cache`, `~/.local/state`, `~/tmp` (OpenCode's `TMPDIR`), shell
  histories, OpenCode's sessions (`.local/share/opencode/storage`,
  `snapshot`, `log`, OpenCode 2's database `opencode.db` with its `-wal`
  and `-shm`, and `repos`; M13.22), and Claude's
  `projects`, `todos`, `shell-snapshots`, `file-history`,
  `session-env`, `plans`, `history.jsonl`, `debug`, `ide`. What a
  session makes anywhere else in its home is the job's. A linked file a
  program replaced by rename (a token written to a new file) goes back
  to the Leg when newer, and is linked again, before the next session
  of any job on that Leg and when the job ends. The job's home goes
  when it is completed or cancelled. Two jobs on one Leg at once can't
  read each other's keys, transcripts or files; a test runs both in
  bwrap. What is still shared: what a session writes inside a linked
  folder (its settings, `~/.config`), by design, and sessions that
  aren't a job's (chats, The Eye's planning) use the Leg's home.
  A link that a home made before M13.22 has for one of these is removed,
  so it becomes the job's own: linked, OpenCode's `tmp` resolved to the
  Leg's home, outside the job's, and its writes there were refused (four
  times on 2026-10-04); one database for every job's server, seen by a
  sandbox that binds the file but not its journal beside it, failed its
  queries ("Failed query: select … from session_message").
- **Git in a job's worktree** (M13.22, 2026-10-04): the worktree's
  `.git` is a file pointing into the project's `.git/worktrees/<job>`,
  and the objects and refs live in the project's `.git`. Bound only the
  worktree, every git command inside said "not a git repository" (and
  OpenCode, seeing no repository, ran `git init`: the piano job). Now
  `gitBinds` finds each worktree (the folder itself, or a several-repo
  job folder's, up to two levels down) and the wrapper mounts the
  project's `.git` as a throwaway tmpfs holding its entries: the
  objects, refs, logs (and `lfs`, `rr-cache`) and this worktree's own
  folder writable, everything else (config, hooks, info, packed refs,
  HEAD) read-only; then the worktree's `.git` file and its folder's
  `commondir` and `gitdir` read-only again. What git writes beside them
  (`packed-refs.lock`, which `commit` takes) lands in the tmpfs, as does
  anything a Leg would add there to steer Oraknid's own git, which runs
  outside the sandbox (a `commondir`, a hook, a config naming a
  `core.fsmonitor` program): none of it reaches the project. Git's
  settings come at the command line's level (`GIT_CONFIG_COUNT`):
  `safe.directory=*`, `gc.auto=0`, `maintenance.auto=false`, and, when
  the project's config names no one, my identity from my global config
  (Oraknid's otherwise), since the sandbox's home is the job's. So
  `status`, `diff`, `log`, `add`, `commit`, `switch -c`, `stash` and
  deleting a branch it made work as they do outside, on the project's
  own objects and refs; the project's config can't be changed from
  inside (deleting a branch leaves that branch's settings there, and git
  says so). A test runs them in bwrap in a worktree of a temp repo, and
  OpenCode really runs them in a job.
- Verification commands run in the same wrapper, with a throwaway home
  instead of the Leg's, after the command policy has allowed them.
- Network is shared (Legs need their APIs), so the wrapper runs under
  a **Landlock** domain first (`python3 -c <script> bwrap …`, Linux
  6.12+): abstract unix sockets and signals outside the sandbox are out
  of reach. Without it, a Leg could connect to the desktop's abstract
  sockets (a terminal's single-instance socket, X11) and run code
  outside the sandbox ([[Audit-2]] S2-01). `oraknid doctor` says whether
  it is on.
- **A network of its own** (2026-10-03, [[Audit-2]] S2-21): with `pasta`
  (package `passt`) the wrapper is `pasta … -- python3 <landlock> bwrap …`:
  a network namespace with the internet through pasta, nothing forwarded
  in, and none of this computer's services: not its localhost, not its
  own address. Only the ports a project lists (Projects → Network), and
  the local model a Leg's own settings name (`http://localhost:11434`),
  are forwarded, reached as localhost inside. Landlock goes inside pasta
  (before it, pasta's user namespace can't map ids); bwrap gives me my
  own uid back inside. Without pasta, the host's network is shared and
  `oraknid doctor` says so, in words that tell passt missing (install
  it) from passt installed but unable to make a network here (it needs
  user namespaces and `/dev/net/tun`), 2026-10-03.
- A Leg's own server inside (OpenCode's `serve`) gets its port forwarded
  in, from this computer's localhost to the sandbox's localhost only.
  Signing a Leg in keeps this computer's network while it lasts: the
  provider's page may call back to the Leg's login.
- A job's `~/.ssh`, in its own home on the Leg, is emptied at the start
  of every attempt and holds only that job's servers' keys
  ([[ADR-026-Servers]]).

## Command policy

The deny and allow lists ([[Security]]) are checked in the adapter's
permission hook before a command reaches the sandbox. The sandbox is
the second wall, not the first. Since 2026-10-07 that check is the Gate
([[ADR-056-The-Harness]] §3): auto mode's rules, my grants, the judge
and the autonomy, the same for a permission prompt, Claude Code's
PreToolUse hook (Claude Code runs in its own auto mode inside the
sandbox, [[ADR-053-Auto-Mode]]), a job's tool through the broker and
Oraknid's own agent's tool calls. A check's command on a job's server
(`ssh <alias> …`) runs over Oraknid's own connection, not in the
sandbox ([[ADR-049-Server-Chat-And-Server-Jobs]]).

Related: [[ADR-006-Sandbox]] · [[Security]] · [[Drift-Control]]
