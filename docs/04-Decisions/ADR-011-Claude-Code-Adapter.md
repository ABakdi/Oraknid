# ADR-011 — Drive Claude Code through the Agent SDK in streaming-input mode

**Status:** Accepted · 2026-10-01 · [[Phase-1-MVP]]

## Context
The Claude Code adapter needs start, follow-up, streaming, interrupt,
resume, kill, usage, rate-limit signals and permission control, all
unattended, with my own subscription.

## Decision
- Use **`@anthropic-ai/claude-agent-sdk`** (`query()` with an
  AsyncIterable prompt, so follow-ups go through the same session). It
  launches the unmodified Claude Code binary as a subprocess.
- `pathToClaudeCodeExecutable` points at the binary *inside the
  bubblewrap wrapper* ([[ADR-006-Sandbox]]). `env.CLAUDE_CONFIG_DIR` is
  the Leg's config directory.
- **Permissions:** `canUseTool` routes every request to The Eye's policy
  ([[Approvals-and-Autonomy]]). The permission mode is `default`.
  `bypassPermissions` is never used.
- **Isolation from the host setup:** `settingSources: []` and an explicit
  `mcpServers` list, so my personal hooks, CLAUDE.md and MCP servers
  don't leak into jobs. (`--bare` is **not** used: it skips
  OAuth/keychain credentials, which subscription login needs.)
- **Usage:** read `result.modelUsage` (running totals per session) and
  `rate_limit_event` (`five_hour` / `seven_day…` windows, `utilization`,
  `resetsAt`) into the Leg's quota. `getContextUsage()` drives session
  rotation (BR-3).
- **Interrupt:** `interrupt()` for a safe point. `close()` and a process
  group kill for step 4 of the ladder.
- **Resume:** `resume: <session_id>`, only when the session is under the
  context threshold. MCP and settings are passed again on resume.
  Otherwise a fresh session starts from a Silk context pack.
- The SDK is pinned exactly. It is pre-1.0 and changes often, so a
  contract test suite runs against the real binary on every upgrade.

## Consequences
- Typed events instead of parsing NDJSON by hand.
- Oraknid never touches Claude credentials ([[ADR-009-Multiple-Accounts-Per-Provider]]).

## Why not raw `claude -p --input-format stream-json`
It works, and it's the fallback if the SDK breaks. But it means
re-implementing the control protocol (interrupts, permission requests)
the SDK already types.

Related: [[Leg-Adapters]] · [[ADR-006-Sandbox]]
