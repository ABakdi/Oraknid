# Leg Adapters

Checked against official docs on 2026-10-01, and the first two built
and run the same day (M1.4). Re-check before each adapter's phase and
on every agent upgrade. Adapters are pinned to the versions their
contract tests pass on (`@anthropic-ai/claude-agent-sdk` 0.3.286 with
Claude Code 2.1.286).

## The interface

```ts
interface LegAdapter {
  kind: LegKind;
  probe(leg: LegConfig, sandbox: SandboxPlan | null): Promise<ProbeResult>; // health, models + efforts, context windows, features
  start(ctx: SessionStart): Promise<LegSession>;  // model, effort, context pack, cwd, sandbox plan, credential, permission hook
}
interface LegSession {
  nativeSessionId(): string | null;                       // for resume
  pid(): number | null;                                   // for metrics and recovery
  send(message: string): Promise<void>;                   // a follow-up turn
  events(): AsyncIterable<LegEvent>;                      // normalized stream (below)
  interrupt(): Promise<void>;                             // end the current turn at a safe point
  kill(): Promise<void>;                                  // terminate the process tree / abort the stream
  usage(): UsageSnapshot;                                 // tokens, context used, quota windows
}
// resume = start({ ..., resumeFrom: nativeSessionId })
// permissions = SessionStart.onPermission(req) => Promise<{ allow: true } | { allow: false; message }>
```

**Normalized events:** `turn.started`, `text.delta`, `tool.called`,
`tool.result`, `question` (the Leg asked me something),
`permission.requested` (with the decision), `usage`, `rate_limit`,
`turn.ended` (`completed` · `interrupted` · `error` · `max_turns` ·
`rate-limited`), `session.ended` (`completed` · `killed` · `crashed` ·
`rate-limited`). File changes are seen by The Eye through the worktree
diff, not reported by adapters.

Every adapter passes the same **contract test kit** in
`packages/legs/sdk`: start, follow-up, interrupt mid-turn, resume,
kill, permission allow/deny, usage present, and a rate-limit fixture.

## Claude Code — MVP

See [[ADR-011-Claude-Code-Adapter]].

| Need | How |
| :-- | :-- |
| Start / follow-up | `@anthropic-ai/claude-agent-sdk` `query({ prompt: AsyncIterable })`. Each `send` pushes a user message. One `result` per turn. |
| Sandbox | `spawnClaudeCodeProcess` runs the binary through the bwrap wrapper; the account's config dir is writable inside. |
| Probe | `supportedModels()` and `accountInfo()` on a query that is never sent a message: no tokens spent. |
| Context pack | `systemPrompt: { type: "preset", preset: "claude_code", append: <pack> }`, so Claude Code keeps its own tool instructions. |
| Model / effort | `model` option per session (`opus`, `sonnet`, `haiku` or a full ID); the effort or thinking option where the SDK exposes one (checked at M1.4). `fallbackModel` is **not** used: The Eye chooses the model. |
| Stream | `includePartialMessages: true` → `stream_event` deltas; `assistant` / `user` messages for tool calls and results. |
| Resume | `resume: session_id`. MCP and settings are passed again. Sessions live under the Leg's `CLAUDE_CONFIG_DIR` (30-day retention); their format is internal and never parsed. |
| Interrupt / kill | `interrupt()`; `close()` + kill the process group. SIGTERM leaves the turn unfinished. |
| Permissions | `canUseTool` → The Eye's policy. Mode `default`. Never `bypassPermissions`. |
| Usage | `result.modelUsage[model]` (input, output, cache, contextWindow; running totals); `getContextUsage()`. |
| Quota | `rate_limit_event.rate_limit_info`: `status`, `rateLimitType` (`five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`…), `utilization`, `resetsAt` (**epoch seconds**). Seen live: while a window is `allowed`, `utilization` is absent, so Oraknid estimates it. A 429 shows up as `system/api_retry` or an assistant `error: "rate_limit"`. |
| Accounts | One `CLAUDE_CONFIG_DIR` per Leg. I log into it with the official binary. Oraknid never reads tokens ([[ADR-009-Multiple-Accounts-Per-Provider]]). |
| Host isolation | `settingSources: []`, explicit `mcpServers`. Not `--bare` (it skips subscription credentials). |
| MCP | `mcpServers` option. |

**Terms note:** the Agent SDK and `claude -p` usage draws from my plan's
limits. Anthropic announced and then paused (2026-06-15) a separate
Agent SDK credit; re-checked 2026-10-01, **still paused**, with no new
date. Re-check before `v0.1.0`.

## OpenAI-compatible (local) — MVP

These servers are models, not agents. They have no tools of their own.
The adapter is therefore a **minimal agent loop owned by Oraknid**:

- Chat completions with tool calling: `read_file`, `write_file`,
  `edit_file` (one exact replacement), `list_dir`, `search`,
  `run_command`. File tools are confined to the worktree by real path;
  `search` and `run_command` run **inside the sandbox**. Writes, edits
  and commands go through the same permission policy; reads inside the
  worktree do not ask.
- The history is held by the adapter for the session's life only.
  Rotation and handoff work through Silk like every other Leg.
- Models without reliable tool calling get profile strengths limited to
  `summarize`, `classify` and `mechanical` text tasks (no file tools).
  `probe` tests tool calling.

| Need | How |
| :-- | :-- |
| Stream | SSE from `/v1/chat/completions`, `stream_options.include_usage` where supported (Ollama, vLLM). Otherwise usage is counted from the final chunk or estimated with a tokenizer, and marked estimated. |
| Interrupt / kill | Abort the HTTP request (Ollama, llama.cpp and vLLM stop generating). |
| Resume | Not native. Always a fresh session from a context pack. |
| Usage | `usage` fields. llama.cpp adds `timings`. |
| Context window | Ollama: `/api/ps` `context_length` (set by `num_ctx` / Modelfile); llama.cpp: `/props` `n_ctx`; vLLM: `/v1/models` `max_model_len`; LM Studio: `/api/v1/models`. |
| Models / VRAM | Ollama `/api/ps` (`size_vram`), `/api/tags`; others via `nvidia-smi`. |
| Quota | None. Rate limits don't apply. |

## OpenCode — Phase 2

OpenCode **v2** (2.0.20, checked 2026-10-01) through a private
`opencode serve --stdio` per session, inside the sandbox, over its HTTP
API and SSE event stream ([[ADR-015-OpenCode-Adapter]]): `POST
/api/session`, `POST …/prompt`, `POST …/interrupt`, `GET /api/event`,
`POST …/permission/{id}/reply`. Turns end with
`session.execution.*`; usage per step from `session.step.ended`; a rate
limit is a `session.retry.scheduled` with `provider.rate-limit`. Each
Leg has its own `HOME`, `TMPDIR` and XDG dirs, project config is
ignored, and every action is asked for. There's no subscription-window
API.
**OpenCode may not use a Claude subscription** under Anthropic's terms.
OpenCode Legs use other providers' API keys or local models.

## Antigravity — Phase 5

**Built against the docs, not yet run for real** (re-checked
2026-10-02, [[ADR-020-Antigravity-Adapter]]). The official `agy` CLI
runs headless: `--input-format stream-json --output-format
stream-json`, one user message per line on stdin; events `init`,
`step_update` (`text_delta`, `tool_info`, `usage`) and `result`
(`conversation_id`, `status`, `error`, `usage`). Google staff describe
launching `agy` as a child process with its own cached sign-in as
supported; using its OAuth from other tools isn't.

- **One `agy` run per turn**, inside the sandbox, continuing the
  conversation with `--conversation`; interrupt is SIGINT.
- **Approvals**: headless `agy` can't ask, it soft-denies. Oraknid
  writes the Leg's `settings.json` with exactly the commands its policy
  allowed; a soft-denied command goes to the policy, and the adapter
  continues the conversation with "approved, run it now" or with the
  reason it was denied. `--dangerously-skip-permissions` is never used.
- **Its own world**: HOME and XDG dirs in the Leg's home, no D-Bus, so
  my desktop keyring is out of reach; sign-in runs from the Leg's card
  under a pseudo-terminal in `agy`'s SSH mode (link, then code).
- **Still to confirm on a real run**: the soft-deny notice's wording,
  a quota error's wording, `tool_info`'s fields, and whether the
  sign-in stays in the Leg's home without a keyring (several accounts
  depend on it). `agy` is not installed on this machine yet.

Related: [[Legs-and-Capability-Profiles]] · [[ADR-011-Claude-Code-Adapter]] · [[ADR-009-Multiple-Accounts-Per-Provider]] · [[Sandboxing]]
