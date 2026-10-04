# Security

Whoever drives Oraknid drives your computer. These are the walls that keep it yours.

## Agents stay in their sandbox

- Every agent runs in a **bubblewrap** sandbox: its worktree and its own folder, read-only system files, nothing else of yours.
- Each sandbox has a **network of its own** (pasta): the internet, but not your local services or your desktop. A project can open the specific ports it needs.
- A **Landlock** rule keeps agents away from your desktop's sockets.
- Every command an agent wants to run is judged against your rules. Commands hidden inside others (`bash -c`, `find -exec`, `xargs`) are read through.
- An agent can't write outside its job's folder (its own `/tmp` and home aside): such a write is refused, not asked, and the agent is told to work in its folder.
- Deploys, sending mail, spending money and pushes anywhere but the project's own GitHub repo always wait for your approval. Merging into your work branch and pushing to the project's repo are Oraknid's own steps at the end of a job, and happen only when you asked for them.
- Content from the web, mail or untrusted files is labelled as data in every prompt, and a task that read it can't trigger a gated action alone. Reading the project's own GitHub repo doesn't count as untrusted.

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
