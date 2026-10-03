# Data Map

Where each piece of data lives, and who can read it.

| Data | Lives in | Readable by | Leaves the machine? |
| :-- | :-- | :-- | :-- |
| Jobs, tasks, Web, stats | SQLite | Daemon, paired devices | Only through The Nest (E2E, Phase 4). |
| Silk | SQLite + `.oraknid/silk/` mirror | Daemon, Legs of that job, me | Only as part of prompts sent to remote Legs. |
| Context packs / prompts | Built in memory, logged condensed | Daemon, the receiving Leg | **Yes, to the Leg's provider** (e.g. Anthropic) for remote Legs. Local Legs: no. |
| Leg raw output | `logs/jobs/<job>/<session>.ndjson` | Daemon, me | No. |
| Workspace code | The project folder / worktree | Legs of that job (sandboxed) | Yes, to remote Legs' providers, as they read files. |
| Secrets | OS keychain, under this data folder's own service `oraknid:<id>` (the id in `keychain-id`, 0600; [[Audit-2]] S2-23), or `secrets.json` (encrypted, 0600) when there's none | Daemon, at process start only | Only to the service they are for. |
| Resource metrics | Memory only (last hour) | Daemon, paired devices | No. |
| Provider logins | Each Leg's own config dir, managed by the official binary | That Leg's process | Only to that provider. |
| Audit log | SQLite + daily JSONL | Me | No. |
| Device keys | SQLite (public), device (private) | — | No. |
| Push subscriptions | SQLite | Daemon | The push service (browser vendor) receives encrypted notifications. |
| Email notifications | — | — | Via my SMTP server, to my address. |
| My mail (Phase 12) | SQLite: headers of synced messages, bodies once opened, drafts, POP accounts' UIDLs; drafts' attachments in `mail/drafts/<id>/`; POP accounts' messages as downloaded in `mail/local/<account>/` | Daemon, paired devices; agents with the email tool, through the broker | Only to my mail providers (IMAP or POP3, SMTP). What an agent reads goes to its Leg's provider, as any prompt does. |
| Mail passwords | OS keychain (`mail.<account>.password`) | Daemon | Only to that provider. |
| The PIN (Phase 10) | SQLite, setting `lock.pin`: a scrypt hash with its own salt, never the PIN | Daemon | No. |
| Unlocked sessions | The daemon's memory only, as hashes (a restart locks every device); on a device, session storage | Daemon, that device | Only through The Nest's tunnel (E2E). |
| Device rights (Phase 11) | SQLite, setting `devices.fullRights` (the ids of devices with full rights) | Daemon | No. |
| Servers (Phase 9) | SQLite: `servers` (host, user, pinned host key, my description), `server_states` (every version of the state document), `server_samples` (oraknid-monitor's readings, 24 hours); keys and passwords in the keychain (`server.<id>.key`, `.password` until setup deletes it, `.passphrase`) | Daemon, paired devices; a job's Legs get the state documents of its project's servers, and their key in the Leg's home for the job | To that server over SSH. The state document goes to a remote Leg's provider as part of its prompt. |
| What runs on a server (2026-10-03, [[ADR-043-Server-Insight]]) | Nothing on disk: a part read (containers, databases, the proxy's sites and certificates, traffic counts, log lines) kept 20 seconds in the daemon's memory; a followed log's lines only pass through to the screen; a summary goes into the next state document | Daemon, paired devices (reading also away from home); the helper reads it as untrusted data | Read from that server over SSH; through the helper, to The Eye's model as part of its prompt. |
| GitHub tokens (Phase 8; several, 2026-10-03) | OS keychain, one per account (`github.token.<login>`; the one token of before stays under `github.token`); the accounts' names and which entry holds each in the setting `github.accounts` | Daemon, given to `git` for one command | Only to GitHub. |
| My repositories as read (Repos, 2026-10-03) | Nothing on disk: GitHub's answers (lists, trees, files up to 512 KB, commits, pull requests) kept a minute in the daemon's memory with their ETag, and each account's hourly allowance as last seen | Daemon; paired devices see what they open, never a token | No: read from GitHub with the account's token. |
| A project's GitHub link (2026-10-03) | SQLite: each repo's `github` in `projects.repos` (account, owner/name, visibility, new or existing, created yet), one per repo ([[ADR-042-Several-Repos-And-Servers]]; `projects.github` was moved there by migration 0031 and dropped by 0032) | Daemon, paired devices; a job's Legs read its repo's name in their context | No. |
| A project's repos and its servers' roles (2026-10-03) | SQLite: `projects.repos` (each repo's name, folder, branches, link), `projects.server_roles` (role and production mark per server); a job's opened repos in `jobs.repos`, a task's commits per repo in `tasks.commits`; the server chosen for a job in the setting `job.server.<job>` | Daemon, paired devices; a job's Legs read the repos' layout and the servers' roles in their context | No. |
| Tools' secrets (Phase 6) | OS keychain (`tool.<tool>.<name>`) | Daemon, the tool's own process for a job that has it | Only to the service the tool talks to. |
| Leg credentials | OS keychain (`leg.<id>`), for Legs that take a key | That Leg's process | Only to that provider. |
| The Nest | SQLite, setting `nest.config` (address, daemon id); its secret in the keychain (`nest-secret`); the daemon's static key pair in its data folder (0600) | Daemon | The secret to The Nest, which keeps only its hash on a public Nest. |
| Chats and the helper (Phase 8) | SQLite: `chats`, `chat_messages`, `helper_messages` | Daemon, paired devices | What I write goes to the chosen Leg's provider (the helper: The Eye's). |
| Plans and their shadows (Phase 7) | SQLite: `eye_plans` | Daemon, paired devices | The plan input goes to both models' providers. |
| The Eye's conversations | SQLite: `eye_messages`, each with its job and its project (migration 0029 filled the project from the job, [[ADR-034-Projects-First]]); The Eye's questions, the inbox item they belong to, my answers and the message they answer (migration 0030) | Daemon, paired devices | What I write goes to the Eye's model for triage. |
| A Leg's plan windows (2026-10-03, [[ADR-039-Plan-Usage-In-View]]) | SQLite: the `quota` JSON of `legs` (account windows) and `leg_models` (a model's), each window with its figure, reset, `observedAt` and source; their history as `leg.quota` events. | Daemon, paired devices | The usage reading is the official CLI asking its provider, from inside the Leg's sandbox with the Leg's own login; Oraknid sends nothing. |
| A project's Workflow: compact or expanded (2026-10-03) | The browser's storage on each device (`oraknid.workflow.<project>`) | That device | No. |
| Cloud storage (2026-10-03, [[ADR-046-Cloud-Storage]]) | SQLite (migration 0034): `cloud_providers` (name, kind, its rclone section's name, the bucket or folder shown, what the page says of it: preset, endpoint, region, e-mail; a space limit, pay as you go, the priority order, the last used and free space and error). The placement in `settings` (`cloud.placement`). Every credential (S3 keys, Drive and Dropbox tokens, MEGA's obscured password) only in Oraknid's rclone config, `<data>/cloud/rclone.conf` (0600 in 0700), encrypted with rclone's config encryption; its password in the keychain (`cloud.rclone.password`). Files on their way in or out wait in `<data>/tmp/cloud` (0600 in 0700), removed after. Download links in memory, two minutes, once | Daemon and rclone; paired devices see names, sizes and space, never a credential | Files go from this computer to the provider I chose or the rule chose, over rclone's own connection; nothing goes to a Leg. File names and paths are in `cloud.*` events. |
| Database backups (2026-10-03, [[ADR-044-Backups]]) | SQLite (migration 0033): `backup_plans` (target, schedule, destination, retention, key, next time), `backup_runs` (each run: state, why, size, duration, SHA-256, where, its key, the error in words, Verify's result, when retention removed it), `backup_keys` (name, the age public key, when its private half was taken). The database passwords (`backup.plan.<id>.password`) and the age private keys (`backup.key.<id>`) in the keychain. The backups themselves: files in the plan's folder on this computer (mine only, 0600 in a 0700 folder) or on the other server (`umask 077`), or in cloud storage (made here first in `<data>/tmp/cloud`, then handed to the provider, [[ADR-046-Cloud-Storage]]) | Daemon, paired devices (never a password or a private key; a private key is shown to me once). The password reaches the dump tool on the server through its environment, or a 0600 file removed after the run (MongoDB) | The dump crosses SSH from its server to Oraknid and, for a server destination, from Oraknid to that server, compressed and (with a key) encrypted before it leaves this computer. Nothing goes to a Leg. |
| Questions and my answers in the inbox (2026-10-03) | SQLite: `inbox_items.questions` / `answers` (migration 0030) | Daemon, paired devices | My answers to an interview go to the Eye's model, as Silk. |
| Earlier jobs' Silk in a pack (2026-10-03) | Read from SQLite when a session's context pack is built | The receiving Leg | As part of the pack, to a remote Leg's provider, like the job's own Silk. |

## Settings keys

The `settings` table holds one JSON value per key; a cleared setting is
no row.

| Key | Holds |
| :-- | :-- |
| `jobs.maxRunning`, `jobs.maxTasks` | Jobs at once, tasks at once in a job ([[ADR-016-Parallel-Work]]). |
| `fallback.sameProvider` | Same-provider fallback ([[ADR-009-Multiple-Accounts-Per-Provider]]). |
| `eye.legModelId`, `eye.models` | The Eye's Leg model; the pins per kind of decision and the shadow ([[ADR-022-Eye-Decision-Models]]). |
| `policy.global`, `policy.project.<project>` | Command rules, globally and per project ([[Security]]). |
| `project.localPorts.<project>` | The ports on this computer a project's jobs may reach ([[Sandboxing]]). |
| `job.startFrom.<job>` | The branch a follow-up job starts from ([[Jobs-and-Projects]] → Follow-up jobs). |
| `project.budget.<project>` | A project's limits on tokens and money across its jobs, and a new job's default ([[Budgets-and-Quotas]] → A project's budget). |
| `project.budgetState.<project>` | Where it stands: the warnings already given, the open inbox question and the jobs it paused. |
| `lock.pin`, `lock.idleMinutes` | The PIN's hash; the idle lock ([[ADR-029-App-Lock]]). |
| `github.accounts` | My GitHub accounts in order, the first the default: each one's login and the keychain entry of its token, never the token ([[ADR-038-Project-Accounts]]). |
| `devices.fullRights` | Devices with full rights ([[ADR-030-Device-Rights]]). |
| `terminal.enabled` | The terminal's switch ([[ADR-028-Terminal]]). |
| `nest.config` | The Nest's address and this daemon's id. |
| `notifications`, `notifications.vapidPublicKey` | Channels, routing and quiet hours; the web push public key (the private one is in the keychain). |
| `audit.exportedSeq` | How far the daily audit export has got. |

**What a remote Leg's provider sees:** the context pack, the files the
Leg reads, and command output inside the session. The UI shows on each
Leg card whether it is remote or local.

Related: [[Security]] · [[Persistence-and-Recovery]] · [[The-Nest]]
