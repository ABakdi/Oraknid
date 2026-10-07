# ADR-057 — Drive OpenAI's Codex CLI headless, its actions through Oraknid's policy by its hooks

**Status:** Accepted · 2026-10-07 · [[Legs-and-Capability-Profiles]] · [[Leg-Adapters]] · builds on [[ADR-011-Claude-Code-Adapter]], [[ADR-020-Antigravity-Adapter]], [[ADR-053-Auto-Mode]], [[ADR-056-The-Harness]]

## Context
I want Codex, OpenAI's coding agent CLI, as a kind of Leg like Claude
Code, OpenCode and Antigravity: my ChatGPT plan (or an API key) doing
Oraknid's tasks, with the same approvals, sandbox and routing.

Checked on 2026-10-07 against codex-cli **0.161.0** (installed on this
machine) through its `--help` only (no session was run, my own
`~/.codex` was never read), its generated app-server schema
(`codex app-server generate-json-schema`), its catalog
(`codex debug models`, run with an empty CODEX_HOME), and OpenAI's docs
and source (github.com/openai/codex: `exec_events.rs`,
`event_processor_with_jsonl_output.rs`, the device-code login, the
errors' wording; the hooks, auth, non-interactive and config reference
pages):

- `codex exec [--json] [PROMPT|-]` runs one turn non-interactively;
  `--json` prints JSONL: `thread.started {thread_id}`, `turn.started`,
  `item.started|updated|completed {item}`, `turn.completed {usage}`,
  `turn.failed {error}`, `error {message}`. Items: `agent_message`,
  `reasoning` (completed only, never streamed), `command_execution`
  (`command`, `aggregated_output`, `exit_code`, `status`
  in_progress|completed|failed|declined), `file_change` (`changes`,
  `status`), `mcp_tool_call` (`server`, `tool`, `arguments`, `result`,
  `error`), `web_search`, `todo_list`, `collab_tool_call`, `error`.
  `usage` is the **thread's running total** (`input_tokens` including
  `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`
  including `reasoning_output_tokens`). An interrupted turn emits no
  event.
- `codex exec resume [SESSION_ID] [PROMPT|-]` continues a thread; it
  takes fewer flags than `exec`: **no `--sandbox`, `--cd`, `--profile`
  or `--add-dir`**, but `-c key=value` (TOML), `-m`, `--json`,
  `--skip-git-repo-check`, `--ignore-rules`,
  `--dangerously-bypass-hook-trust`.
- Approval policy (`never` | `on-request`) is orthogonal to the sandbox
  mode (`read-only` | `workspace-write` | `danger-full-access`); in exec
  the default sandbox is read-only. Codex's Linux sandbox is bubblewrap
  (its package ships one) with seccomp for the network.
- **Hooks** (feature `hooks`, stable, on by default): `PreToolUse`,
  `PermissionRequest`, `PostToolUse`, `Stop` and others, from
  `hooks.json` or `[hooks]` in the config, so from `-c` too. A command
  hook gets the event as JSON on stdin (`tool_name` — `Bash`,
  `apply_patch`, `mcp__<server>__<tool>` —, `tool_input`, `cwd`,
  `turn_id`…) and blocks a tool by printing
  `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":…}}`
  or exiting 2; a `Stop` hook keeps the turn going with
  `{"decision":"block","reason":…}`. Hooks that aren't managed need
  trust, which `--dangerously-bypass-hook-trust` gives for one run. An
  untrusted project's `.codex/` layers (config, hooks, rules) are never
  loaded.
- **Auth**: `codex login` (a browser sign-in returning to
  localhost:1455), `codex login --device-auth` (a link and a one-time
  code to enter there; it must be allowed in the ChatGPT account's
  security settings, else "device code login is not enabled"),
  `--with-api-key`; `codex login status`; `CODEX_API_KEY` for exec;
  `cli_auth_credentials_store = "file"` keeps the login in
  `$CODEX_HOME/auth.json` (no keyring). `CODEX_HOME` must exist.
- `codex debug models` prints the model catalog as JSON: each model's
  `slug`, `display_name`, `visibility` (list | hide),
  `supported_reasoning_levels` (low … ultra), `context_window`,
  `supported_in_api`.
- `codex app-server` (JSON-RPC over stdio) answers
  `account/rateLimits/read` with the plan's `primary` and `secondary`
  windows (`usedPercent`, `windowDurationMins`, `resetsAt` in seconds),
  after an `initialize` / `initialized` handshake. It also has an
  approval protocol of its own (commands and file changes asked of the
  client), the richer integration if `exec` ever falls short.
- A usage limit reads "You've hit your usage limit. … Try again at
  3:45 PM." (local time; "Jan 15th, 2026 3:45 PM" when not today; "Try
  again later." when unknown); an API key out of credit "Quota
  exceeded. Check your plan and billing details."

## Decision
A `codex` Leg kind, `packages/legs/codex`, passing the Leg contract kit.

1. **One `codex exec --json` run per turn**, inside Oraknid's sandbox,
   the message on stdin; a follow-up and a resume are
   `codex exec resume --json <thread> -`. The context pack leads the
   thread's first message, so it stays on resume. Everything a run needs
   beyond the Leg's base config comes as `-c` flags (approval policy,
   sandbox mode, effort, MCP servers, hooks), the only kind `exec
   resume` accepts, and so two sessions sharing a CODEX_HOME never clash.
   Also `--skip-git-repo-check`, `--ignore-rules` (my and the repo's
   execpolicy rules stay out), `features.daemon_auto_start=false`.
2. **Codex's own sandbox off, its approvals off**:
   `sandbox_mode="danger-full-access"`, `approval_policy="never"`
   (never `--dangerously-bypass-approvals-and-sandbox`, which says
   nothing of what stays on). Oraknid's bwrap is the boundary, as for
   every Leg. Codex's sandbox is bubblewrap too: nested in ours it needs
   user namespaces inside a user namespace, and its `workspace-write`
   mode cuts the network and every folder but the worktree (the job's
   home, its caches, the MCP sockets). Asking would hang a headless run.
3. **Every action through Oraknid's policy, before it runs, by Codex's
   PreToolUse hook.** The adapter listens on a unix socket in a folder
   bound into the sandbox (as the MCP bridges do, [[ADR-021-Tools-Broker]]);
   the hook is a few lines of Node that pass the event there and print
   the answer. A command is asked as `Bash` with its command, each file
   of a patch as `Write` (added, moved to) or `Edit` (changed, deleted)
   with its path, an MCP call by its tool name; Codex's own bookkeeping
   (its plan, viewing an image) changes nothing and isn't asked. In
   careful mode it goes to `onPermission`; in auto mode Oraknid's layer 1
   (`onPreToolUse`) first: a deny is final, an allow ("allow once") runs,
   and what it leaves goes to the policy, since Codex has no classifier
   of its own here ([[ADR-053-Auto-Mode]]). A refusal is reported to the
   log at once and goes back to Codex as the hook's reason. A hook that
   can't reach Oraknid blocks the tool. This is an inline gate: the
   capability `inlineGate` of [[ADR-056-The-Harness]] §2 holds for Codex,
   with no audit after the fact needed. Its PreToolUse hook doesn't see
   hosted tools (web search), which read and change nothing here.
4. **The task's checks hold a turn open by Codex's Stop hook**, as
   Claude Code's (ADR-052 §2): three times at most per turn.
5. **A CODEX_HOME per Leg**, `<legs>/<id>/codex-home`, created when the
   Leg is added, never my `~/.codex` (refused, like `~/.claude`). It
   holds the login (`auth.json`, in a file), a base `config.toml`
   Oraknid writes (the file store, no update check, no analytics, no
   history file, keys kept out of commands' environment) and the
   threads. A job's sessions get a CODEX_HOME of their own with only
   `auth.json` linked in ([[Audit-2]] S2-08's mechanism: a refreshed
   token written by rename goes back to the Leg); its threads, logs and
   state stay the job's.
6. **Login from the Leg's card**: `codex login --device-auth` for the
   Leg's CODEX_HOME; the card shows OpenAI's link and the one-time code
   to enter there; Codex finishes by itself, and **Done** checks
   (`codex login status`). Where device codes are off, Codex's browser
   sign-in instead, said to work only in a browser on this computer.
   It runs outside the sandbox like Claude Code's, its CODEX_HOME the
   Leg's. Or an **OpenAI API key**: kept in the keychain, given to each
   run as `CODEX_API_KEY` (excluded from commands' environment); the
   Leg is marked `auth: "api-key"`, has nothing to log in, offers only
   the models the API serves and has no plan windows.
7. **Usage and limits**: `turn.completed`'s totals counted by how much
   they grew, cached input apart. A usage-limit error is a `rate_limit`
   (`plan`, account, rejected) with the time it gives, so the Leg rests
   until then ([[Legs-and-Capability-Profiles]] → Provider failures); the
   plan's windows (`five_hour`, `seven_day`) come from
   `codex app-server`'s `account/rateLimits/read`, without a prompt, at
   most every 5 minutes while I look; when it doesn't answer, nothing is
   spent on a prompt.
8. **Models** from `codex debug models` (listed ones, their reasoning
   levels as efforts, context windows); `models` in the config is the
   fallback. **Default profile** (estimated, like every default):
   frontier GPT models at 4–5 (implementation, debugging, refactoring,
   tests, review 5), hard tasks, `subscription`, quota weight 3; mini,
   nano and luna models at 3–4, medium. GPT-5 to GPT-9 are frontier
   wherever they run. Routing gives them rungs from the profile; a job's
   Claude share doesn't count them.
9. **Discovery**: `codex` on PATH or `~/.local/bin/codex` (its
   standalone installer's link), with its version. The binary runs by
   its real path (the link points into `~/.codex/packages/standalone/…`),
   and that package folder (the binary, its `rg`) is bound read-only;
   nothing else of `~/.codex` is.

## Consequences
- Codex Legs work with Oraknid's approvals as tightly as Claude Code's:
  nothing runs that the policy didn't see first.
- The adapter depends on Codex's hooks running in `exec` with
  `--dangerously-bypass-hook-trust`, and on the `-c` forms of `hooks`
  and `mcp_servers`: documented, unverified against a real run. If a
  release breaks them, a command would run unasked; the first real job
  must check that the hook is called (the session log shows each
  `permission.requested`), and the app server's approval protocol is
  the fallback.
- `exec` doesn't stream messages: text arrives a message at a time.
- A resumed thread's running total, the first time a new session reads
  it, may count its earlier turns once.
- Not yet run on a real job (no session was started for this ADR, by
  rule): the event shapes, the hook's input, the device-code output and
  the limit wording are from the docs and source above, and the
  stand-in follows them.
