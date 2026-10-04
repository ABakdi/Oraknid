# Phase 14 — Oraknid over MCP

Touches [[API-Contract]], [[Security]], [[Approvals-and-Autonomy]],
[[The-Eye]], [[ADR-051-Oraknid-Over-MCP]].
Written 2026-10-04. Planned, not started.

## Why

Much of my work starts inside another agent (Claude Code, Claude
Desktop, claude.ai, OpenCode). Through MCP, any of them can hand
Oraknid long work, follow it, steer it, and use my GitHub, mail and
servers through Oraknid without ever holding a secret
([[ADR-051-Oraknid-Over-MCP]]).

## Milestones

### M14.1 — The server and connected clients
- [ ] `oraknid mcp` (stdio bridge) and `/mcp` (Streamable HTTP on 127.0.0.1), one server over the API
- [ ] Pairing a client, Settings → Connected agents: name, rights per area, projects and servers it may touch, budget, rate limit, revoke
- [ ] Every call audited with the client's name; approvals asked as "<client> wants to…"; never-approvable actions refused for clients

### M14.2 — Work: start, follow, steer
- [ ] `start_job`, `job_status`, `wait_for_job`, `steer_job`, `answer`, `pause` / `resume` / `cancel`, `job_report`
- [ ] Resources for a job's transcript and plan graph, subscribable; progress notifications on long calls
- [ ] Digests: every N minutes, per milestone, on a question, at the end
- [ ] Questions through MCP elicitation when the client supports it, the first answer wins

### M14.3 — Accounts without secrets
- [ ] GitHub tools on Oraknid's accounts (read; write when granted)
- [ ] Mail: search, read, draft (sending stays mine)
- [ ] Servers: state document, insight, safe read-only commands, server jobs
- [ ] Backups, storage, plan usage, machine health
- [ ] Secrets never in a result (redaction tested on every tool); outside content marked untrusted

### M14.4 — Away from home
- [ ] `oraknid mcp --remote`: the bridge paired through the Nest, over the end-to-end tunnel

### M14.5 — Prompts and polish
- [ ] MCP prompts: delegate this to Oraknid, what's running, review this PR
- [ ] Tested as a server for Claude Code, Claude Desktop and OpenCode; the guide's page on connecting an agent

## Exit criterion

From Claude Code in another repo I hand Oraknid a spec, keep working,
get digests, steer it once, answer its question in that conversation,
and receive the PR at the end; the client never held a GitHub token;
revoking the client stops it at once.
