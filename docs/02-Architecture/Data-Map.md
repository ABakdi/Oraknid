# Data Map

Where each piece of data lives, and who can read it.

| Data | Lives in | Readable by | Leaves the machine? |
| :-- | :-- | :-- | :-- |
| Jobs, tasks, Web, stats | SQLite | Daemon, paired devices | Only through The Nest (E2E, Phase 4). |
| Silk | SQLite + `.oraknid/silk/` mirror | Daemon, Legs of that job, me | Only as part of prompts sent to remote Legs. |
| Context packs / prompts | Built in memory, logged condensed | Daemon, the receiving Leg | **Yes, to the Leg's provider** (e.g. Anthropic) for remote Legs. Local Legs: no. |
| Leg raw output | `logs/jobs/<job>/<session>.ndjson` | Daemon, me | No. |
| Workspace code | The project folder / worktree | Legs of that job (sandboxed) | Yes, to remote Legs' providers, as they read files. |
| Secrets | OS keychain, or `secrets.json` (encrypted, 0600) when there's none | Daemon, at process start only | Only to the service they are for. |
| Resource metrics | Memory only (last hour) | Daemon, paired devices | No. |
| Provider logins | Each Leg's own config dir, managed by the official binary | That Leg's process | Only to that provider. |
| Audit log | SQLite + daily JSONL | Me | No. |
| Device keys | SQLite (public), device (private) | — | No. |
| Push subscriptions | SQLite | Daemon | The push service (browser vendor) receives encrypted notifications. |
| Email notifications | — | — | Via my SMTP server, to my address. |

**What a remote Leg's provider sees:** the context pack, the files the
Leg reads, and command output inside the session. The UI shows on each
Leg card whether it is remote or local.

Related: [[Security]] · [[Persistence-and-Recovery]] · [[The-Nest]]
