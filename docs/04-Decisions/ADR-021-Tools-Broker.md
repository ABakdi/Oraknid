# ADR-021 — Tools reach a Leg through Oraknid's MCP broker

**Status:** Accepted · 2026-10-02 · [[Phase-6-Non-Coding-Skills]]

## Context
Non-coding skills need tools: an email skill reads and sends mail, a
calendar skill books. The common way to give an agent a tool is an MCP
server (stdio, JSON-RPC). Three things matter:

- **Credentials**: a mail password must not be readable by the Leg.
  Started by the Leg, the server's environment is visible from inside
  the Leg's sandbox (`/proc`, same user).
- **One gate for every kind of Leg**: Claude Code, OpenCode and
  Antigravity each name and ask for MCP tools differently, and headless
  Antigravity can't ask at all (ADR-020).
- **Not every call is a write**: today every MCP call is gated as
  `external-write`, so reading an inbox would ask me for each message.

## Decision
- **A tool is registered once** (Settings → Tools): a name the skills
  use (`email`), the MCP server's command and arguments, the names of
  its secret environment variables (values in the keychain, BR-13),
  which of its tools **only read**, which **send**, and whether what it
  returns is **untrusted** (default yes: mail, web pages, tickets).
  Anything not declared as a read is a write.
- **A skill asks for tools** (`requires.tools`); a job gets the skill's
  tools when it is created, and the job form says which are missing. A
  job can't start while one is missing. A tool's secrets are read only
  for the sessions of a job that has the tool.
- **The daemon runs the server, never the Leg** (the broker). For each
  Leg session of such a job, the daemon starts the server in its own
  bwrap sandbox: network on, a throwaway home, no worktree, its secrets
  in its environment. The Leg is given an MCP server named
  `oraknid-<tool>` whose command is a tiny bridge (`node bridge.mjs
  <socket>`) that pipes stdio to a unix socket bound into the Leg's
  sandbox. The Leg never sees the credentials.
- **Every `tools/call` passes the job's policy** in the broker, as the
  tool `mcp__<tool>__<name>`: a declared read is allowed; a send is the
  gated action `send` (always asked, never waived by autonomy); any
  other call is `external-write`, as before. An approval goes to the
  inbox like any other and the call waits. A refused call answers the
  Leg with the reason as a tool error.
- **Untrusted results** (BR-15): the result's text is wrapped as data
  with the instruction not to follow it, and the task is untrusted from
  then on (its gated actions always ask me).
- The Leg-level permission for an `oraknid-<tool>` MCP tool is allowed
  without asking: the broker decides, so I'm never asked twice.
- Every call, its verdict and its result size go to the job's events
  (audit).
- **A send is a side effect** (BR-6, added 2026-10-02): written to the
  outbox as `performing` before it reaches the server and `performed`
  when it answers. The same send (same tool, same arguments) is refused
  once made, so a resumed Leg can't send a message twice; one caught
  mid-way by a crash is reconciled like any action, which for now means
  I'm asked whether it went out.
- **Adapters** pass the bridge as an MCP server: Claude Code through
  the SDK's `mcpServers`, OpenCode through its config's `mcp`,
  Antigravity through `mcp_config.json` in the Leg's home (unverified,
  ADR-020). An OpenAI-compatible Leg doesn't take tools yet.

## Consequences
- One gate and one audit for every Leg kind; credentials stay with the
  daemon.
- A server costs one process per session that needs it.
- A tool's read/send declarations are mine to get right: a "read" that
  writes would pass ungated. The default for anything undeclared is the
  safe one.

Related: [[Skills]] · [[Security]] · [[Approvals-and-Autonomy]] · [[ADR-014-Auto-Approval]] · [[ADR-006-Sandbox]]
