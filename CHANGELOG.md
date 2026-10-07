# Changelog

Versions follow [semantic versioning](https://semver.org). Until 1.0,
a minor version may change anything; each release says what to do.

## 0.2.0 — 2026-10-07 (pre-release)

Phase 15, agents that deliver (started), and the rest of Phase 13.
Update from Settings → About & updates (or `oraknid update`), then
reload any open tab.

### Agents that deliver ([ADR-052](docs/04-Decisions/ADR-052-A-Harness-For-Any-Model.md))
- **Whole goals instead of crumbs:** the planner makes substantial, independent tasks, and chains of small ones are merged. The agent plans inside its own session and runs the task's checks itself; Claude Code can't end its turn while one fails.
- **Checks are tried before they judge.** A broken check (quoting, syntax, a missing tool) is repaired, never counted against an agent. An agent showing that a check is broken gets the check reviewed.
- **A ladder up:** one real failure moves the task to the next stronger model with a handoff, up to the strongest you allow; a Claude share per job. Retries resume the same session.
- **Only usable agents are chosen:** out of quota (read from the agent's own words, e.g. "Resets in 51h"), paused, failing to start or on a deprecated model are skipped. A blocked job says the real reason and what to do.
- **The Eye** plans, repairs checks and reviews on the strongest model you allow.
- **One interview round** when the spec is complete.
- **Oraknid's own handoff notes** no longer count as edits outside a task's scope.

### Auto mode ([ADR-053](docs/04-Decisions/ADR-053-Auto-Mode.md))
- **Rules from open-source parts:** commands parsed with tree-sitter-bash (also inside `sh -c` and `ssh host '…'`), dangerous ones blocked by cc-safety-net plus Oraknid's rules, secrets going out caught by secretlint. Read-only commands, edits in the job's folder, and the project's build, test and lint run at once.
- **A model judges the rest**, seeing only your messages, the task and the action. A blocked agent is told why and carries on another way.
- **You're asked only for:** a server job's plan, each change on a production server, sending mail, publishing and deleting repos, and an agent stuck on repeated blocks.
- **Autonomy levels** auto (default), careful and full; Claude Code runs in its own auto mode with Oraknid's rules before every tool.
- **Fixed:** a path containing "deploy" was treated as a deployment.

### Oraknid's own agent and local models ([ADR-054](docs/04-Decisions/ADR-054-Local-Models.md))
- **Oraknid's own agent:** a new Leg that drives any model through an OpenAI-compatible API, with Claude-Code-like tools in the sandbox. Tool calling is tested per model.
- **A Models page:**
  - search Hugging Face and the Ollama library, with what fits this machine;
  - resumable, checksum-checked downloads;
  - running with llama.cpp or the Ollama already on the machine;
  - loading admitted by the machine's limits.
- **Roles** (translate, OCR, speech to text, embeddings) become tools for every agent.
- **`install.sh --local-models`** installs llama.cpp for your GPU.

### The terminal app ([ADR-055](docs/04-Decisions/ADR-055-Terminal-App.md))
- **`oraknid` opens a full-screen terminal app:** The Eye's conversation, a prompt, and `/` commands with completion and numbered lists (`/projects`, `/jobs`, `/inbox`, `/servers`, then a server's `/chat`, `/docker`, `/logs`, `/ssh` and more, `/agents`, `/models`, `/settings`, `/update`…).
- **Install without the web UI:** `install.sh --no-gui` (or the question it asks); `oraknid install --gui` adds the web UI later.

### Since 0.1.0, also
- **Setup:** servers take a key file first, Fix wording, Edit and Test connection; New project asks the name first, offers New, an existing folder or GitHub, with a folder picker.
- **Updates from inside Oraknid** following your channel; an open tab notices an update and reloads.
- **The planner fixed:**
  - a real dependency graph with no duplicate tasks;
  - a short interview;
  - git and OpenCode working in the sandbox;
  - a question you skip is closed rather than left open.
- **Projects:** archive and delete, with your choices for the repos and the folder.
- **A chat on each server**, and jobs that work on it, with the state document updated after.
- **The Eye thinks out loud:** stop it, or redo with your words; the conversation reads like a terminal transcript, with a rail of your prompts.
- **Parallel by default**, within what the machine can take; warnings when it's in danger.
- **Fixed:**
  - signing an Antigravity Leg in again shows the link;
  - the service's PATH no longer grows with each update.

### Known limits
- **Auto mode's judge:** a judge that doesn't answer in 10 s counts as a block.
- **Not yet built:** a per-job network allowlist.
- **The terminal app:** it can't create projects, servers or Legs, or edit a plan; the web UI does.
- **Local models:** GPU fit counts memory only on AMD and Intel; whisper.cpp is used when installed, not installed.
- **Not yet tried on real jobs:** the 30-minute piano run (Phase 15's proof).

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
