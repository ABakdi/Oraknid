# ADR-015 — Drive OpenCode v2 through a private `serve --stdio` per session

**Status:** Accepted · 2026-10-01 · [[Phase-2-OpenCode]]

## Context
OpenCode is the third kind of Leg (Phase 2). The canon described its
v1 API; the installed OpenCode is **v2.0.20**, whose HTTP API is new
(checked 2026-10-01 against a local stand-in model, never a real
provider). What matters for an unattended, sandboxed Leg:

- `opencode serve --stdio --port 0` runs a private HTTP server, prints
  `{"url":…}` once, and exits when its stdin closes; the password comes
  from `OPENCODE_PASSWORD` (HTTP Basic, user `opencode`).
- Under `/api`: `POST /session` (with `location.directory`, `model`,
  `permissions`), `POST /session/{id}/prompt` (always async),
  `POST …/interrupt`, `POST …/permission/{id}/reply {decision}`,
  `GET /api/event` (one SSE stream for the server), `GET /session/{id}`
  (cumulative tokens and cost).
- A turn ends with `session.execution.succeeded|failed|interrupted`.
  Text streams as `session.text.delta`; tools as `session.tool.called`
  and `.success`/`.failed`; usage per step in `session.step.ended`.
- A rate limit is **not** a status: `session.retry.scheduled` with
  `error.type: "provider.rate-limit"`, ten retries, then
  `session.execution.failed`.
- **Isolation needs more than XDG dirs**: OpenCode reads `~/.claude`
  and `~/.agents` from `HOME`, and shares `/tmp/opencode`. Provider keys
  in the environment are picked up.
- **Permissions default to allow-all**, and a repo's own
  `opencode.json` can grant itself more; rules passed when the session
  is created win.
- The matching client is `@opencode/client@2`, not `@opencode-ai/sdk`;
  the API is marked experimental.

## Decision
- **One private server per Oraknid session**, started inside the bwrap
  sandbox like any Leg (`--stdio --port 0`, stdin held open, a random
  password per server). Killing the session closes stdin and kills the
  tree. No shared background service.
- **Plain `fetch` and an SSE reader**, no client library: the shapes
  are few, and the API is experimental; the adapter pins what it reads.
- **A Leg's own world**: `HOME`, `TMPDIR` and all four XDG dirs inside
  the Leg's home; the environment is cleared except `PATH`, `LANG` and
  the one provider key the Leg holds (BR-13). Project config is ignored
  (`OPENCODE_DISABLE_PROJECT_CONFIG=1`), models.dev and updates are off,
  and the Leg's config (its provider, models, base URL) comes in
  `OPENCODE_CONFIG_CONTENT`, with a `provider.use` policy that allows
  only the Leg's provider (the free built-in one is off).
- **Every action asks**: the session is created with
  `* → ask` (reads, globs and greps allowed), so every shell command,
  edit and fetch reaches Oraknid's policy through `permission.asked`.
  "Allow" replies `once`; "deny" replies `reject` with the reason, which
  the model reads.
- **Usage** from `session.step.ended` (input without cache, output,
  cache read and write); cost from the model's configured price.
- **Rate limits**: the first `session.retry.scheduled` with
  `provider.rate-limit` becomes a `rate_limit` event (rejected, no
  reset known) and the turn ends `rate-limited`; Oraknid interrupts the
  session rather than wait out ten retries.
- **Resume**: prompting an existing session id continues it with its
  history, inside the same Leg's data dir.
- **Terms**: an OpenCode Leg never uses a Claude subscription
  (Anthropic's terms); it uses API keys of other providers, or local
  models.

## Consequences
- A session costs one OpenCode start (about a second).
- An upgrade of OpenCode can change the experimental API: the adapter's
  probe checks `/api/info`'s version and says when it isn't the one
  tested.
- Tests run the real binary against a stand-in OpenAI-compatible
  server, so the whole path is exercised without a provider.

Related: [[Leg-Adapters]] · [[Phase-2-OpenCode]] · [[ADR-006-Sandbox]] · [[ADR-011-Claude-Code-Adapter]] · [[Security]]
