# API Contract

oRPC procedures under `/api`, schemas in `packages/contracts`
([[ADR-010-API-Contracts]]). OpenAPI is generated at build time. This
table is the summary and is kept in step with the contracts.

| Area | Procedure | Purpose |
| :-- | :-- | :-- |
| System | `system.status` · `system.doctor` | Version, uptime, pid, data directory, last event `seq`, inhibitor, secret store, sandbox and service status; the checks. |
| Devices | `devices.pairStart` / `pairComplete` / `list` / `revoke` | Pairing. Five wrong codes cancel every open one (Audit 1). |
| Projects | `projects.createFrom` (Phase 8: a folder, a new empty folder, a new GitHub repo, a cloned one, a git URL) · `projects.setSkills` (Phase 8) · `projects.create` / `list` (M1.6) · `policy` / `setPolicy` (M1.9) · `archive` / `delete` (M2.0) | Creating a project in a folder that isn't a git repo asks: `initGit: true` or a shadow repo. |
| Jobs | `jobs.updateDraft` / `remove` / `draftStart` / `draftTalk` / `draftThinking` (Phase 8: the New work page's draft and its conversation; `remove` takes a draft or an ended job) · `jobs.planComparisons` (ADR-022: each plan beside its shadow's, with measures and the job's outcome) · `jobs.create` / `start` / `get` / `list` / `pause` / `resume` / `cancel` (M1.6) · `setAutonomy` / `setWaivers` / `setRules` / `redirect` (M1.7) · `setBudget` (M1.9) · `setPriority` (M3.3) · `talk` / `conversation` · `result` / `merge` / `openFolder` (Checkpoint 1) | A job's view carries its tasks, worktree and branch. `talk` returns at once; The Eye's reply arrives as `eye.replied`. `merge` returns `{ok, commit}` or `{ok: false, reason, conflicts}`. |
| Web | `web.edit` (add, update, remove tasks) | Plan editing; an edit that breaks The Web's rules is refused and undone. |
| Tasks | `tasks.pin` / `takeOver` / `handBack` / `rollback` / `attempts` · `diff` (M2.0) | `diff`: the task's commit once done, else its work since before its first attempt. |
| Sessions | `sessions.list({jobId})` / `sessions.log({id, after})` (Checkpoint 1) | Each Leg session of a job and its log as readable lines, from a byte offset. |
| Legs | `legs.discover` (agents and local model servers found on this machine, each with a suggested name and config) · `legs.loginStart` / `loginFinish` (a Claude Code or Antigravity Leg's sign-in, 2026-10-02) · `legs.list` / `get` / `create` / `test` / `update` (with `maxSessions`, M3.3) / `pause` / `resume` / `remove` / `setModelHidden` / `setProfile` | Creating tests the Leg at once. A Leg's view carries its models with effective profiles, quota windows, VRAM and a setup hint. |
| Silk | `silk.list` / `add` / `edit` / `importMirror` | Editing supersedes. `importMirror` looks for hand edits now. |
| Inbox | `inbox.list` / `inbox.answer` | `list` filters by state, kind, project, job and words (`q`); each item names its project, job and task. An approval takes only one of its options; the answering device is recorded. |
| Skills | `skills.list` / `get` / `upload` / `edit` / `remove` | Built-ins are read-only; an upload says what front matter it ignored. The default skill comes first. |
| Servers | `servers.list` / `add` / `update` / `setup` / `discover` / `acceptHostKey` / `state` / `editState` / `samples` / `remove` · `projects.setServers` · `settings.terminal` / `setTerminal` (Phase 9) | Credentials go to the keychain; `setup` installs Oraknid's key (for a password), reads the server, writes its document, installs oraknid-monitor. The terminal is the `/term` WebSocket (ADR-028), not a procedure. |
| Helper | `helper.conversation` / `thinking` / `send` / `decide` / `clear` (Phase 8, ADR-024) | `send` answers in the background; `decide` confirms or cancels a proposed action. Its actions are a fixed catalogue run by the daemon's own services. |
| GitHub | `github.status` / `setToken` / `removeToken` / `repos` (Phase 8, ADR-023) | The token goes to the keychain once GitHub accepts it; `status` names the account or says why GitHub refuses it. |
| Chats | `chats.list` / `get` / `create` / `send` / `stop` / `rename` / `setProjects` / `remove` (Phase 8, ADR-025) | `get` returns the messages and, while it answers, the text so far (`answering`); events `chat.*` on `overview` say when to reload. |
| Mail | `mail.accounts` / `addAccount` / `updateAccount` (name, `autoSend`, `appendSent`) / `removeAccount` / `reconnect` / `sync` · `mail.oauthSettings` / `setOAuth` / `oauthStart` · `mail.folders` / `threads` (a page, with a search) / `thread` / `attachment` / `allowImages` · `mail.flag` / `move` / `archive` / `delete` · `mail.drafts` / `replyTemplate` / `saveDraft` / `send` / `approve` / `discard` (Phase 12, [[ADR-032-Email]]) | Passwords and tokens go to the keychain; an account is saved only once IMAP and SMTP accept its login. Every action is done on the server first. `approve` sends a draft, an agent's included, answering its inbox item when there is one. Google and Microsoft send me back to `GET /oauth/mail/callback` on the daemon, which accepts only a sign-in it started. Events `mail.*` on the `mail` topic. |
| Tools | `tools.list` / `create` / `update` / `remove` (Phase 6) | MCP servers for skills ([[ADR-021-Tools-Broker]]). Secrets go to the keychain; a view names them and those missing, never their values. A job lists its `tools` and `missingTools`; `jobs.start` refuses while one is missing. |
| Stats | `stats.summary` / `tokens` / `activity` | Totals and charts per job, project or everything. |
| Logs | `audit.search` · `logs.tail` (M2.0) | Filters: job, type or prefix, actor, text. `logs.tail`: the daemon log's last lines. The audit export is built in the UI from `audit.search` pages. |
| Secrets | `secrets.unlock` | Opens the encrypted-file store when there is no keychain. |
| Metrics | `metrics.recent` | Samples since a time, up to the last hour. |
| Notifications | `notifications.get` / `update` / `configureEmail` / `test` / `vapidPublicKey` / `subscribe` / `unsubscribe` | Per-channel switches, SMTP setup (password to the secret store), web push. |
| Settings | `settings.eyeModels` / `setEyeModels` (the Eye Leg, a model per kind of decision, the shadow planner; ADR-022) · `settings.setEyeLeg` · `maxRunningJobs` / `setMaxRunningJobs` (M3.3) · `maxTasksPerJob` / `setMaxTasksPerJob` (M3.1) · `sameProviderFallback` / `setSameProviderFallback` (ADR-009) · `policies.get` / `update` | |
| Storage | `storage.usage` / `storage.prune` (M1.9) | |
| The Nest | `nest.status` / `nest.configure` / `nest.pairAway` (Phase 4) | Reaching me away from home ([[Nest-Protocol]]). `pairAway` returns a link whose keys are in the fragment. |

**Not built yet** (Audit 1 → Q1-15), with where they land: `projects.get`, `jobs.export` (Phase 2); a general `settings.get` / `update` when a second setting
needs it.

Mutating procedures are not idempotent by a client `requestId` yet: they
are safe to repeat by their own state (a second `start`, `pause` or
`answer` is refused with a sentence). A `requestId` arrives with The Nest
(Phase 4), where a retried request over a flaky link needs it. Errors
carry a code (`BAD_REQUEST`, `NOT_FOUND`, `CONFLICT`,
`INTERNAL_SERVER_ERROR`) **and** a sentence for the UI (BR-17); an
internal error's details stay in the daemon's log.

Outside `/api`: `GET /health` (liveness, used by the CLI) and the
`/live` WebSocket ([[Realtime-Transport]]).

Related: [[ADR-010-API-Contracts]] · [[Realtime-Transport]] · [[Core-Entities]]
