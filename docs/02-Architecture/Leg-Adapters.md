# Leg Adapters

Checked against official docs on 2026-10-01. Re-check before each
adapter's phase and on every agent upgrade. Adapters are pinned to the
versions their contract tests pass on.

## The interface

```ts
interface LegAdapter {
  kind: LegKind;
  probe(leg: LegConfig): Promise<ProbeResult>;            // health, available models + efforts, context windows, features
  start(ctx: SessionStart): Promise<LegSession>;          // model, effort, context pack, cwd, sandbox, permission hook
}
interface LegSession {
  id: string; nativeSessionId?: string;
  send(message: string): Promise<void>;                   // a follow-up turn
  events(): AsyncIterable<LegEvent>;                      // normalized stream (below)
  interrupt(): Promise<void>;                             // end the current turn at a safe point
  kill(): Promise<void>;                                  // terminate the process tree / abort the stream
  usage(): UsageSnapshot;                                 // tokens, context used, quota windows
}
// resume = start({ ..., resumeFrom: nativeSessionId })
// permissions = SessionStart.onPermission(req) => Promise<"allow" | "deny" | { deny: string }>
```

**Normalized events:** `turn.started`, `text.delta`, `tool.called`,
`tool.result`, `file.changed`, `question` (the Leg asked me something),
`permission.requested`, `usage`, `rate_limit`, `turn.ended`
(`completed` · `interrupted` · `error` · `max_turns`), `session.ended`.

Every adapter passes the same **contract test kit** in
`packages/legs/sdk`: start, follow-up, interrupt mid-turn, resume,
kill, permission allow/deny, usage present, and a rate-limit fixture.

## Claude Code — MVP

See [[ADR-011-Claude-Code-Adapter]].

| Need | How |
| :-- | :-- |
| Start / follow-up | `@anthropic-ai/claude-agent-sdk` `query({ prompt: AsyncIterable })`. Each `send` pushes a user message. One `result` per turn. |
| Model / effort | `model` option per session (`opus`, `sonnet`, `haiku` or a full ID); the effort or thinking option where the SDK exposes one (checked at M1.4). `fallbackModel` is **not** used: The Eye chooses the model. |
| Stream | `includePartialMessages: true` → `stream_event` deltas; `assistant` / `user` messages for tool calls and results. |
| Resume | `resume: session_id`. MCP and settings are passed again. Sessions live under the Leg's `CLAUDE_CONFIG_DIR` (30-day retention); their format is internal and never parsed. |
| Interrupt / kill | `interrupt()`; `close()` + kill the process group. SIGTERM leaves the turn unfinished. |
| Permissions | `canUseTool` → The Eye's policy. Mode `default`. Never `bypassPermissions`. |
| Usage | `result.modelUsage[model]` (input, output, cache, contextWindow; running totals); `getContextUsage()`. |
| Quota | `rate_limit_event.rate_limit_info`: `status`, `rateLimitType` (`five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`…), `utilization`, `resetsAt`. A 429 shows up as `system/api_retry` or an assistant `error: "rate_limit"`. |
| Accounts | One `CLAUDE_CONFIG_DIR` per Leg. I log into it with the official binary. Oraknid never reads tokens ([[ADR-009-Multiple-Accounts-Per-Provider]]). |
| Host isolation | `settingSources: []`, explicit `mcpServers`. Not `--bare` (it skips subscription credentials). |
| MCP | `mcpServers` option. |

**Terms note:** the Agent SDK and `claude -p` usage draws from my plan's
limits. Anthropic announced and then paused (2026-06-15) a separate
Agent SDK credit. Its status is to be re-checked before Phase 1 ships.

## OpenAI-compatible (local) — MVP

These servers are models, not agents. They have no tools of their own.
The adapter is therefore a **minimal agent loop owned by Oraknid**:

- Chat completions with tool calling: `read_file`, `write_file`,
  `apply_patch`, `list_dir`, `search`, `run_command`. The daemon
  executes every tool **inside the sandbox**, through the same
  permission policy.
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

`opencode serve` per Leg (password-protected, on localhost, inside the
sandbox) and `@opencode-ai/sdk`: `session.create`, `prompt_async`,
`session.abort` (interrupt), `event.subscribe` (SSE: `message.part.delta`,
`permission.asked`, `session.idle`, `session.error`…),
`permission.reply`. Usage comes from `step_finish` parts (`tokens`,
`cost`). Rate limits show up as session `retry` status and `ApiError`
429s. There's no subscription-window API. Accounts: separate
`XDG_DATA_HOME` / `XDG_CONFIG_HOME` per Leg (to be confirmed in Phase 2).
**OpenCode may not use a Claude subscription** under Anthropic's terms.
OpenCode Legs use other providers or local models.

## Antigravity — Phase 5

**Can now run unattended** (re-checked 2026-10-01): the official `agy`
CLI has a headless mode: `agy -p`, `--output-format stream-json`,
`--input-format stream-json`, `--conversation <id>` / `-c`,
`--json-schema`, `--print-timeout`. Events: `init`, `step_update`
(with `usage`), `result` (`SUCCESS|ERROR|CANCELED|INTERRUPTED|WAITING…`).
Auth uses the binary's own cached credentials after one interactive
login. Google staff describe launching `agy` as a child process this
way as supported. Using Antigravity OAuth from other tools isn't
allowed. Still unknown: exact usage field names, how a quota error
looks, a config-dir variable for several accounts, MCP config, and
interrupt behaviour. Phase 5 starts by closing these.

Related: [[Legs-and-Capability-Profiles]] · [[ADR-011-Claude-Code-Adapter]] · [[ADR-009-Multiple-Accounts-Per-Provider]] · [[Sandboxing]]
