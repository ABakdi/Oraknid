# Changelog

Versions follow [semantic versioning](https://semver.org). Until 1.0,
a minor version may change anything; each release says what to do.

## 0.1.0 — 2026-10-04 (pre-release)

The first release: everything built in Phases 1 to 13 of the
[roadmap](docs/03-Planning/Roadmap.md).

### Agents and The Eye
- Legs: Claude Code, OpenCode, Antigravity and any OpenAI-compatible model (Ollama, LM Studio, llama.cpp, vLLM), several accounts each, found on the machine.
- The Eye plans a goal into a graph of tasks with checks, routes each to a Leg and model by strength, quota and cost, runs the checks itself, and only then calls a task done.
- It watches every session for drift, loops, edits out of scope and tokens without progress; corrects, hands over through Silk, or asks.
- An Eye on a dedicated decision model, or on a Leg from the pool.
- Several tasks and several jobs at once, each in its own worktree, merged with conflicts raised as tasks.
- Lossless pause and resume, crash recovery, the machine kept awake while jobs run.
- Approvals: risky actions ask, with what a no does; autonomy per job; questions come with options, the recommended one first.
- The Eye speaks up in each project's conversation: progress, a summary when a job ends, what it needs.
- Jobs get a proper name and a description of what they did.
- Skills, the canon-driven interview, MCP tools with credentials scoped per job.

### Projects and code
- The project is the place: The Eye's conversation, the Workflow diagram (compact or expanded), Work, Silk, budget and stats.
- One repo or several per project, a branch per job per repo; servers per project by role.
- GitHub: several accounts, a repo linked or created per project, pushes through Oraknid's own tool; Repos browses code, commits with diffs, branches and pull requests.
- Open the project's folder, or a terminal in it, from its header.
- Plan usage (Claude's windows and weekly limits) on the Overview and on each Leg.
- Chats with any model; Docs in the app, and a helper that knows the guide and points at the option on screen.

### Servers and operations
- Servers over SSH with Oraknid's own key: read-only discovery and a state document kept current.
- Monitoring: CPU, memory, disk, network; Docker containers, images and volumes; databases; the reverse proxy (nginx, Traefik, Caddy) with sites and certificates; traffic and logs.
- Deploys by a job, through approvals, production confirmed.
- Database backups on a schedule: PostgreSQL, MySQL/MariaDB, MongoDB, Redis, SQLite, in Docker or not; compressed and encrypted with age; to this computer, a server or cloud storage; Test connection, Verify, Restore.
- Cloud storage: every rclone provider, pooled.
- A terminal in the browser: tabs, split, grid, local or on a server.

### Mail
- IMAP and POP3 accounts with app passwords; agents read, sort and draft; nothing is sent without you.

### Away from home and security
- The Nest: a self-hostable relay with an end-to-end encrypted tunnel; pair a phone with a QR code; push notifications.
- A public Nest serves the product site and the guide; a private one shows nothing and is not indexed.
- A PIN on every device, checked by the daemon; full rights only for devices you choose.
- Every agent in a sandbox: bubblewrap, Landlock, its own network through passt; writes outside its folder refused.

### Install
- One script for Arch, Debian, Ubuntu, Fedora, Alpine and openSUSE; runs Oraknid with systemd, OpenRC or runit; `--dev`, `--ref`, `--dir`, `--from`, `--no-service`, `--uninstall`.
- `oraknid doctor` checks the machine and names the fix for this distribution.

### Known limits
- Linux only; Windows is the final phase.
- Mail OAuth is not there yet (app passwords only).
- The phone loader's code is not yet pinned (Audit-2 S2-02, in part).
