# ADR-051 — Oraknid as an MCP server: a command center for any agent

**Status:** Proposed · 2026-10-04 · [[Phase-14-Oraknid-Over-MCP]] (not built yet)

## Context
Today I reach Oraknid through its web UI, my phone and the CLI. More and
more of my work starts inside another agent: Claude Code in a terminal,
Claude Desktop, claude.ai on my phone, OpenCode, an IDE assistant. Those
agents are good at a conversation and a short task, and bad at what
Oraknid is for:

- **Long work**: they stop when the conversation ends, the laptop
  sleeps or the context fills; Oraknid plans, runs for hours, survives
  restarts and verifies.
- **My accounts without my secrets**: to open a pull request, read my
  mail or look at a server, an agent today needs a token, a password or
  an SSH key in its environment, readable by anything it runs. Oraknid
  already holds them in the keychain and acts with them through its own
  gates ([[ADR-021-Tools-Broker]], [[ADR-023-GitHub-By-Token]],
  [[ADR-026-Servers]], [[ADR-032-Email]]).
- **Many agents at once**: one agent is one session; Oraknid routes work
  across Claude Code, OpenCode, Antigravity and local models, in
  parallel, within quota and machine limits.

MCP (Model Context Protocol) is how these agents take tools. If Oraknid
speaks it, any of them can use Oraknid as its command and control
center: hand it long work, get periodic updates, steer it, and use my
GitHub, mail and servers through it, without ever holding a secret.

## Decision
Oraknid exposes **one MCP server**, the same API the web UI uses
([[API-Contract]]), shaped for agents.

### Ways in
- **Local, stdio**: `oraknid mcp`, a small bridge the client starts
  (`claude mcp add oraknid -- oraknid mcp`); it talks to the daemon on
  127.0.0.1 with a client token.
- **Local, Streamable HTTP**: `http://127.0.0.1:7417/mcp` for clients
  that prefer a URL.
- **Away from home**: `oraknid mcp --remote`, the same bridge on another
  machine, paired through the Nest like a device and speaking its
  end-to-end tunnel ([[ADR-017-Nest-E2E-Protocol]]); the Nest still sees
  nothing. No plain remote endpoint is opened on my machine.

### Connected clients, with rights I give
- An MCP client is **paired** like a device (a code shown in Oraknid,
  or `oraknid mcp pair`), named ("Claude Code on my laptop"), listed in
  Settings → Connected agents, and revocable at once.
- Each client gets **rights** I choose, per area: read (projects, jobs,
  Silk, state documents, usage, health); start and steer jobs; answer
  questions; GitHub (read / write: branches, PRs, issues); mail (read /
  draft; sending is never granted, it stays mine); servers (read /
  start server jobs); backups and storage (read / run). Optionally
  limited to some projects and servers, with a budget and a rate limit
  of its own. Defaults: read and start/steer jobs; the rest off.
- **Approvals stay mine**: what a client does passes the same policy as
  a job ([[Approvals-and-Autonomy]]); a gated action it asks for goes to
  my devices as "Claude Code on my laptop wants to…". Sending mail,
  production servers, deleting, force pushes and anything marked
  always-ask are never approved by a client, whatever its rights.
- Every call is **audited** with the client's name.

### No secret ever crosses
Tools act with the keychain's credentials inside the daemon and return
results, never a token, password, key or cookie; known secret shapes are
redacted from every result as a second guard. Content from outside
(mail, web pages, issues, server logs) is returned **marked untrusted**,
with a short warning for the calling model, the same rule as for Legs
([[Security]]).

### What it offers
**Tools** (each one also an action in the API, so the UI and agents
never drift apart):
- *Work*: `start_job` (project or a folder, goal, spec files, autonomy,
  budget, which Legs) → a job id at once; `job_status`; `wait_for_job`
  (until a state, a question or a milestone, with a timeout: long
  polling for clients without notifications); `steer_job` (a message to
  The Eye: guidance, a correction, more work, the same path as my chat);
  `answer` (a question or approval, when granted); `pause` / `resume` /
  `cancel`; `job_report` (what was done, the diff summary, checks).
- *Projects*: list, create (the same sources as New project), the plan
  graph, Silk search, the conversation.
- *GitHub*: repos, files, branches, commits, PRs (read, open, comment,
  review, merge when granted), issues, CI runs: on the account Oraknid
  holds, chosen by name.
- *Mail*: search, read a thread, draft a reply (drafts wait for me).
- *Servers*: the state document, insight (Docker, databases, proxy,
  traffic, logs), read-only commands from the safe list, `start_server_job`
  (the server chat's jobs, ADR-049, when built).
- *Operations*: backups (status, run now), storage (list, upload a file
  the client gives), plan usage, the machine's health.

**Resources** (readable and **subscribable**): a job's transcript, its
plan graph, a project's Silk, a server's state document, the inbox.
A subscribed client gets `notifications/resources/updated` as they
change.

**Progress and periodic updates**: long tool calls send MCP progress
notifications; a client that starts a job can ask for **digests**
(every N minutes, on each milestone, on a question, at the end), each a
few lines from The Eye's own reports ([[ADR-045-The-Eye-Speaks-Up]]).

**Questions back**: when The Eye needs an answer and the client
supports MCP *elicitation*, the question (with its options,
[[ADR-037-Questions-With-Options]]) is asked in the client's
conversation; my devices get it too, and the first answer wins.

**Prompts**: ready MCP prompts, e.g. "delegate this to Oraknid" (turn
the current conversation into a spec and start a job), "what's running",
"review this PR with Oraknid".

### Not in the first version
MCP *sampling* (Oraknid borrowing the calling client's model for The
Eye) — interesting for a client on a strong model, but it ties a job's
life to a conversation; later, off by default.

## Use cases
- **Delegate from Claude Code**: in a repo, "have Oraknid build the
  billing service from docs/specs/billing while I keep working here" →
  `start_job`; the conversation goes on; digests arrive; "also add
  Stripe webhooks" → `steer_job`; at the end, `job_report` and the PR.
- **From my phone in claude.ai or Claude Desktop**: "how's the piano
  job? anything waiting for me?" → status, the open question, answered
  in the chat.
- **GitHub without a token**: an agent opens a PR, reads CI logs or
  triages issues through Oraknid's account.
- **Ops**: "why is x.com returning 502?" → insight and logs of the
  server; "fix it" → a server job with my approvals.
- **Mail**: "anything from the client about the release?" → search and
  read; "draft a reply" → a draft that waits for me.
- **Agents delegating to agents**: another orchestrator or a scheduled
  agent hands Oraknid the long part of its work and checks back later.
- **Hand-off at the end of a session**: "I'm closing my laptop; carry
  on with this" → the conversation becomes a job that runs overnight.

## Consequences
- The API gains agent-shaped actions (`wait_for_job`, digests) that the
  UI can use too.
- A new kind of identity, the connected client, beside devices: its
  rights, budget, rate limit and audit; [[Security]] and
  [[Approvals-and-Autonomy]] say how it is gated.
- Prompt injection reaches further: untrusted content returned to an
  outside model is marked, and nothing a client sends can widen its own
  rights or approve its own gated actions.
- The MCP specification moves; the server follows its current version
  and is tested against Claude Code, Claude Desktop and OpenCode as
  clients.
