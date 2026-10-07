# Security

Whoever drives Oraknid drives your computer. These are the walls that keep it yours.

## Agents stay in their sandbox

- Every agent runs in a **bubblewrap** sandbox: its worktree and its own folder, read-only system files, nothing else of yours.
- Each sandbox has a **network of its own** (pasta): the internet, but not your local services or your desktop. A project can open the specific ports it needs.
- A **Landlock** rule keeps agents away from your desktop's sockets.
- Every command an agent wants to run is judged against your rules. Commands hidden inside others (`bash -c`, `find -exec`, `xargs`) are read through.
- An agent can't write outside its job's folder (its own `/tmp`, home and temp folders aside): such a write is refused, not asked, and the agent is told to work in its folder.
- Git works inside the sandbox: the agent can check the status, diff, stage, commit and make a branch in its worktree, on your project's own repository, without asking. Your repository's settings and hooks stay out of its reach; anything else it writes in `.git` is thrown away with the sandbox.
- Sending mail, publishing, deleting a repository and spending money always wait for your approval, and so does each change on a server you marked production. Other commands go through auto mode: rules block what is known to be dangerous (a force-push, `rm -rf` outside the job's folder, reading `.env` or `~/.ssh`, a credential sent out, wiping volumes or a database) and allow what only reads or edits the job's folder; a model judges the rest, seeing your words, the task and the command, never what the agent says. A blocked command is refused with its reason. Merging into your work branch and pushing to the project's repo are Oraknid's own steps at the end of a job, and happen only when you asked for them.
- Content from the web, mail or untrusted files is labelled as data in every prompt, and a task that read it can't trigger a gated action alone. Reading the project's own GitHub repo doesn't count as untrusted, and ordinary work (edits, tests, git on the job's branch) goes on without asking after a task read the web.

## Only you open it

- Every browser and phone is **paired** with a one-time code, and keeps a token the daemon stores only as a hash.
- A **PIN** unlocks each device, checked by the daemon. Idle devices lock; ten wrong tries unpair the device; you are told about wrong tries.
- The interface can't be framed by another site, and loads nothing from outside.

## Away from home

- The phone and your computer talk **end to end** (libsodium). The Nest relays sealed frames and can't read or change them; replayed frames are refused.
- Away from home, a phone can't open new ways in unless you gave it full rights, at home, with your PIN.

## Secrets

Passwords, keys and tokens live in your system keychain and are given to one process, for one task. They are scrubbed from logs, events and memory.

## Reporting a problem

If you find a way around any of this, please write to [a.bakdi@abakdi.com](mailto:a.bakdi@abakdi.com) before telling anyone else.
