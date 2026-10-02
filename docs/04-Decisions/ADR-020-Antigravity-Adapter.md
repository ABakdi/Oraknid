# ADR-020 — Drive Antigravity through its official headless CLI

**Status:** Accepted · 2026-10-02 · [[Phase-5-Antigravity]]

## Context
Antigravity is the fourth kind of Leg (Phase 5). Re-checked on
2026-10-02 against Antigravity's own headless docs
(antigravity.google/docs/cli/headless) and its CLI's issue tracker.
`agy` is **not installed on this machine**; nothing below was run
against the real binary yet.

- `agy --input-format stream-json --output-format stream-json` reads
  one `{"event":"user","message":{"content":…}}` per line on stdin and
  runs one turn per message in one conversation; closing stdin ends it.
- Output is NDJSON: `init`, `step_update` (`text_delta`, `state`,
  `step_type`, `usage`, `tool_info`), `result` (`conversation_id`,
  `status` SUCCESS|ERROR|CANCELED|INTERRUPTED|INVALID|WAITING|RUNNING,
  `response`, `error`, `usage` with `input_tokens`, `output_tokens`,
  `thinking_tokens`, `cache_read_tokens`, `total_tokens`).
- `--conversation <id>` resumes a conversation; `--model`, `--effort`.
- **Permissions have no ask in headless mode**: an action that needs
  approval is *soft-denied* (the run goes on, a notice goes to stderr).
  Workspace file edits are allowed; shell commands are allowed only
  when `~/.gemini/antigravity-cli/settings.json` lists them
  (`permissions.allow: ["command(git)", "command(regex:…)"]`), or with
  `--dangerously-skip-permissions`, which allows everything.
- **Auth**: the OS keyring (Secret Service on Linux), else a Google
  sign-in; over SSH it prints a link and reads back a code. Older
  versions kept a token file under `~/.gemini`. There is **no
  documented profile or config-dir switch** for several accounts (open
  request upstream).
- **Terms**: Google staff say launching the official `agy` binary as a
  child process over pipes, with its own cached sign-in, is supported
  and uses the same plan limits as interactive use. Reading its tokens
  or calling its backend directly is not.
- Unknown until a real run: the exact soft-deny notice, how a quota
  error reads, the shape of `tool_info`, and whether a token stays in
  the Leg's home when no keyring is reachable.

## Decision
- **One `agy` process per Oraknid turn**, in stream-json both ways,
  inside the bwrap sandbox, continuing the same conversation with
  `--conversation`. The prompt goes on stdin (no argument-length limit);
  stdin closes after the `result`. `--dangerously-skip-permissions` is
  **never** passed.
- **Approvals by allow list and replay** (keeps BR-6 and ADR-014):
  before each run the adapter writes the Leg's `settings.json` with
  exactly the commands Oraknid's policy allowed in this session
  (`command(regex:^…$)`, escaped). When a run soft-denies something,
  the adapter asks Oraknid's policy; if allowed, it adds that command
  and continues the conversation ("approved, run it now"); if denied,
  it reports the tool result as failed with the reason and continues
  with that reason. Both stay inside one Oraknid turn, at most 20
  rounds. Workspace edits stay allowed, as they're in the sandboxed
  worktree.
- **A Leg's own world**: `HOME`, `TMPDIR` and the XDG dirs inside the
  Leg's home, and no D-Bus address, so the keyring of my desktop
  session is not reachable from a Leg. Sign-in runs with the same
  environment, so its token is the Leg's (one Leg per account), *if*
  `agy` keeps it in a file when it has no keyring; the first real run
  confirms this, and the Leg's card says so until then.
- **Sign-in from the web UI**, like Claude Code (BR-22): the daemon
  starts `agy` under a pseudo-terminal with the SSH variables set, shows
  the link it prints, and passes back the code I paste.
- **Usage** from each run's `result.usage` (thinking tokens count as
  output). **Quota**: a `result` with status ERROR whose error mentions
  quota, rate limit, `RESOURCE_EXHAUSTED` or 429 becomes a `rate_limit`
  event (rejected; a reset is read from the text when it says one) and
  the turn ends `rate-limited`.
- **Interrupt** sends SIGINT (status INTERRUPTED); **kill** ends the
  process tree.
- **Probe**: `agy --version`, then `agy models` for the model list
  (it also says whether the Leg is signed in).

## Consequences
- A turn costs one `agy` start. A command allowed once is allowed for
  the rest of the session, by its exact text only.
- The adapter is tested against a stand-in `agy` that follows the docs;
  where the docs are silent (the four unknowns above) the stand-in
  follows the adapter's guess, and the first real run on my machine is
  the check. Phase 5's exit criterion needs that run.
- Several Antigravity accounts depend on the file-token behaviour; if
  `agy` only keeps the keyring, one Antigravity Leg per machine account
  remains, and this ADR is revised.

Related: [[Leg-Adapters]] · [[Phase-5-Antigravity]] · [[ADR-014-Auto-Approval]] · [[ADR-006-Sandbox]] · [[ADR-009-Multiple-Accounts-Per-Provider]]
