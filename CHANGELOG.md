# Changelog

Versions follow [semantic versioning](https://semver.org). Until 1.0,
a minor version may change anything; each release says what to do.

## Unreleased

- **Licensed under AGPL-3.0** (`AGPL-3.0-only`): the LICENSE file, every package's `license`, and the README.

## 0.5.1 — 2026-10-08 (pre-release)

The web UI no longer freezes the browser. Measured with a job streaming, on data shaped like a real install: long tasks went from up to 4.2 s lost per minute to none on the Overview, a project's Eye chat and Activity.

- **Reloads paced:**
  - a list reloads at most twice a second, never on every streamed event;
  - nothing reloads while the tab is hidden, and it catches up once when shown.
- **Live data bounded:**
  - the newest events kept in fixed buffers, long payloads cut;
  - charts redrawn at most once a second;
  - pages draw their parts separately, so one event no longer redraws everything.
- **Less re-drawing:** messages and log lines are drawn once, not re-parsed on every update; a payload is drawn only when its line is opened.
- **Less data:**
  - a conversation loads its last 100 messages, with "Earlier messages" for the rest; a long message shows its start, with "Show all";
  - a server's page asks for 240 readings, not a day's worth (12 MB → 100 KB).
- **Size caps where data is written:** chat messages, event payloads, Silk notes and inbox details keep their start and end with "(cut short)". Silk's diff summaries list 60 files and a count.
- **Old oversized rows** (such as a 3.2 MB error) are cut at the next start; each original is saved first to `~/.local/share/oraknid/archive/`.

## 0.5.0 — 2026-10-08 (pre-release)

### Monitors suspect, a model confirms ([ADR-056](docs/04-Decisions/ADR-056-The-Harness.md))
- **What a project's own tools write is never questioned:** known conventions for each ecosystem (JavaScript/TypeScript and their bundlers, Python, Rust, Go, Java/Kotlin/Scala, .NET, Ruby, PHP, Elixir, Flutter, Swift, C/C++, Haskell, Zig, Terraform, Nix), chosen by the project's own marker files; also what its `.gitignore` excludes and what was learned for it before. No model call.
- **The rules only suspect** (scope, repetition, the same failure, stalls, token burn, going round in circles). A drift judge, a fast model then a strong one when it says drift, confirms before anything is corrected. When unsure, the agent is asked once, neutrally. A judge that doesn't answer leads to a gentle correction at most, never a restart, reassignment or kill.
- **Forbidden actions and retries of a refused action** still act at once.
- **Learned per project, silently:** a pattern judged to be tool output is never asked about again. None of this shows in the chat or the inbox; you hear about drift only when it's confirmed.
- **Fixed:** a scaffold that installs and builds (`node_modules/`, `dist/`) was corrected, restarted, reassigned and killed for its own output.

### The Models page
- **Refresh** for the list and for search results: files and sizes, Ollama's own models, whether a loaded model still answers, and its speed.
- **Roles are given on each model's card,** only the roles that model can do; a role moved from another model says so. The side panel is gone.
- **Ollama's library is found again:** ollama.com's page changed and every Ollama search came back empty. Results from both sources are interleaved by relevance, with an All / Ollama / Hugging Face filter and counts.

## 0.4.4 — 2026-10-08 (pre-release)

- **Rolling a task back no longer breaks on large folders:** the files to restore go to git on stdin, not on one command line that a scaffold's thousands of files overflowed.
- **Installed dependencies are never checkpointed or committed by Oraknid:** `node_modules`, the pnpm store, Python virtualenvs and caches stay out, even before the project has a `.gitignore`. pnpm keeps its store in the job's home, not inside the project.
- **Errors said briefly:**
  - a failing git command is reported by its first words and git's own message;
  - a job's blocked or paused reason is cut to a few lines;
  - the chat, Work, the job page and the Overview clip long text and wrap it, so the layout holds.

## 0.4.3 — 2026-10-08 (pre-release)

- **The Eye skips an agent that turns out to be out of quota:** when its own call (the interview, a plan, a review) hits a usage limit, for example an agent just signed in on an account already used up, it marks that agent limited until its reset and carries on with the next one. Before, the job stopped there.
- **A job stuck in "interviewing" with nothing running:** a job can now be blocked from the interview with the reason said, instead of staying "interviewing" silently. Such a job resumes by itself once Oraknid restarts on this version.

## 0.4.2 — 2026-10-08 (pre-release)

- **Antigravity sign-in:** after the code, agy's first-run theme picker is answered by Oraknid. Its sample text ("error: compilation failed") is no longer taken for a failure, and a sign-in that worked is no longer undone. A real failure is said in one short line.
- **Error messages in dialogs** wrap and scroll inside the dialog instead of stretching it.

## 0.4.1 — 2026-10-08 (pre-release)

The harness, stage 5: the last of [ADR-056](docs/04-Decisions/ADR-056-The-Harness.md).

- **The old task function is gone:** the 2,300-line function that ran a task is now a task controller, a state machine whose every step is recorded, built from small modules: routing, sessions, checks, the Gate, the Verifier, the decision, applying it.
- **Agents are handled by what they can do,** as each one's probe reports it (inline approvals, pre-tool and stop hooks, resume), with a declared fallback for what one can't; no agent is named in the harness.
- **An agent without inline approvals** (Antigravity) has what it ran audited after the fact; a refused action is corrected as a scope drift.
- **After a restart:**
  - an action left uncertain is checked, not re-run: a file in the tree, a commit by its branch, a server command by asking the agent to look;
  - a task whose commit Oraknid made just before stopping ends done instead of running again.

Known limit: right after updating, until each agent is probed again (about a minute), agents run asking for each action and without a stop hook.

## 0.4.0 — 2026-10-08 (pre-release)

### GitHub Actions inside Oraknid ([ADR-058](docs/04-Decisions/ADR-058-CI-In-Oraknid.md))
- **Where you see it:** a CI tab on every project and on Repos, with runs, their jobs and steps, and logs split by step (the failing one first, searchable).
- **What you can do:** download artifacts; re-run, cancel and start a workflow by hand with its inputs, each through your approval and recorded.
- **Status and notifications:** CI badges on the project header, job pages and The Eye's report; a notification when a run fails on the release or work branch.
- **For agents and The Eye:** a check, `oraknid github-ci`, that waits for the branch's CI and fails with the failing step's log. Agents read runs and logs through the github tool, and its re-runs need approval.
- **Elsewhere:** helper actions and `/ci` in the terminal app.
- **GitHub's rate limit is respected:** cached data while waiting.
- **This repository's own CI:** lint, typecheck and tests on every push and pull request. Also a release script (`scripts/release.mjs`), a release workflow, and the API's OpenAPI document (`/api/openapi.json`).

### More git hosts and accounts ([ADR-062](docs/04-Decisions/ADR-062-Git-Hosts.md), [ADR-063](docs/04-Decisions/ADR-063-Mail-OAuth.md))
- **GitLab (cloud or self-hosted), Gitea and Forgejo** by token: repos, create, link to a project, clone and push through Oraknid's own credentials, Repos browsing, merge requests, and the same built-in checks.
- **Mail sign-in with Google and Microsoft** by OAuth (your own app, steps in the guide); app passwords still work.
- **A storage tool for agents:** list, download into the job, upload (judged) and share links (always asked).
- **Context windows:** LM Studio's is read from the model; Claude Code reports its real context usage.

### Data, operations and servers ([ADR-059](docs/04-Decisions/ADR-059-Project-Secrets.md), [ADR-060](docs/04-Decisions/ADR-060-Sites-Domains-And-Uptime.md), [ADR-061](docs/04-Decisions/ADR-061-Moving-Oraknid.md))
- **Project secrets per environment** (dev, testing, production), kept in the keychain, never shown again, given only to the project's jobs. Written to servers as a 0600 env file, production values only to production servers.
- **A Sites tab under Servers:** domains and where they point, certificate expiry, uptime checks with down and back-up notifications.
- **Moving Oraknid:** `oraknid export --all` / `oraknid import` move everything to a new machine in one passphrase-encrypted archive (also in Settings → About). A job or a project exports as a zip and imports as a record.
- **Cleaning up:** finished jobs' worktrees can be cleaned up from Settings → Storage. The database is tidied while idle.
- **No sandbox, no job,** unless you start one without it explicitly.
- **Servers:**
  - an unreachable server is shown stale;
  - a cancelled or failed job still refreshes the state document;
  - databases show their sizes, and SQLite files are listed.
- **Notifications:** when a quota-paused job resumes, and when keeping the computer awake fails.
- **Adding an agent tests it first.**

### The interface and the helper
- **A command palette** that jumps anywhere and runs controls.
- **The Overview:** Activity in words, with filters and expandable lines; Resources grouped by agent, with full charts.
- **Inbox:** filters by state.
- **Full rights:** a badge for full rights, and uses away from home recorded.
- **The helper does what the screens do:** settings, drafts, waivers, chats, repos, the inbox, deletes, each with a confirm where it matters.
- **The guide:** new pages.

### The harness, stage 4 ([ADR-056](docs/04-Decisions/ADR-056-The-Harness.md))
- **How an attempt ends is decided in one place,** with its precedence written once and tested as a table that includes the real failures of 2026-10-06/07.
- **Monitors** for drift, stalls, budget and going round in circles: nudged once, then corrected.
- **A scope or security warning** found after the checks pass no longer counts as done.

### Security
- **Variables never on a command line:** a sandbox's variables (agents' keys, project secrets) are no longer passed as command-line arguments, which every user of the computer can read.
- **Commits** take the repository's own git identity.

## 0.3.1 — 2026-10-08 (pre-release)

The harness, stage 3 ([ADR-056](docs/04-Decisions/ADR-056-The-Harness.md)). Also the first published release of 0.3.0's work (Codex, the Gate): v0.3.0 was tagged but not published, because its clean install check failed on a full disk on the build machine.

- **One Verifier for every check:** the task's, the stop hook's, the ones tried before the work, the merge's and the job's. Its report tells a broken check from a failing one.
- **The attempt log:** every action, the Gate's decision, each check run, the questions, the handoffs and the outcome are recorded per attempt. The task's memory (grants, refusals, stuck count, the untrusted mark) is read from it.
- **Handoffs to the next agent** now say what was tried, what the Gate refused and the last check report.
- **After a crash,** an action left without a result is marked uncertain and never re-run blindly.
- **Fixed:**
  - a job-level check on a server (`ssh <server> …`) didn't go through the rules;
  - the merge's and the job's GitHub checks misread a wrong repo name;
  - a successful built-in tool call didn't end a stuck row.

## 0.3.0 — 2026-10-08 (pre-release)

### Codex as an agent ([ADR-057](docs/04-Decisions/ADR-057-Codex-Adapter.md))
- **Add Codex on the Legs page:**
  - It's found on this computer, or added by hand with your ChatGPT sign-in or an OpenAI API key (kept in the keychain).
  - Each Codex Leg has its own CODEX_HOME; your `~/.codex` is never used by jobs.
  - Sign-in from its card uses a device code: a link and a one-time code.
- **How it runs:** headless (`codex exec --json`) inside Oraknid's sandbox, resuming its threads.
- **Every action is asked of Oraknid** through Codex's PreToolUse hook, each file of a patch included, and the task's checks run through its Stop hook.
- **Fails closed:** if Codex ever runs a tool without asking (its hooks not active), the session is stopped at once.
- **Models, quota and the ladder:** models and reasoning levels come from Codex itself, plan windows (five-hour and weekly) are read without spending a prompt, and usage-limit messages are read for their reset time. Codex models take their place on the ladder.

### The harness, stage 2: the Gate ([ADR-056](docs/04-Decisions/ADR-056-The-Harness.md))
- **One path for every action:** the agent's permission prompt, Claude Code's hook, Oraknid's built-in tools and commands on servers. The rules run once per action.
- **Grants survive a restart:** your approved plan's removals and "allow once".
- **Every block counts toward the stuck rule,** your own refusals included (shown as "(you)").
- **Fixed:**
  - a denied built-in tool call refused every later call of that tool;
  - three Claude Code blocks on a file tool asked nothing;
  - a cancelled job's task memory was never cleared.

### The canon
Specification, architecture and planning brought up to date with the code: glossary, business rules, entities, data map (every table, settings key and migration), the API contract (all procedures), the roadmap and phase notes, the README and the guide.

### Known limits
- **Codex is unproven on a real job:** it hasn't run a real job yet; its hooks and event formats come from its docs and source. The fail-closed check guards the hooks.
- **Harness stage 3** (one check runner, the attempt log) is in progress.

## 0.2.4 — 2026-10-07 (pre-release)

The harness, stage 1 ([ADR-056](docs/04-Decisions/ADR-056-The-Harness.md)): behaviour pinned by scenarios replaying real jobs, and fifteen fixes.

- **Stop the job** now stops its other running tasks and starts no new one.
- **Re-checking after a merge** uses the task's own runners (server, GitHub), so a parallel task with such checks no longer loops.
- **Checks:** every agent receives the task's checks (Oraknid's own agent didn't), and Claude Code's checks run once per turn end, not twice.
- **Resume** follows what each agent can do (Oraknid's own agent resumes too).
- **Kept across a restart:** the "read untrusted content" mark (security), allow-once grants, refused actions and stuck counts. Questions an attempt raised are withdrawn when the job starts again.
- **Claude Code's own refusals** count toward the stuck rule.
- **Your "try again" or "another agent"** no longer uses up the job's attempt limit; skipping or taking a task yourself no longer counts as the model failing.
- **Scope and security drifts** are corrected in the same session before any climb to a stronger model.
- **An interrupted turn** is told to go on rather than checked as finished.
- **One list of credential paths and lockfiles** shared by every rule.

## 0.2.3 — 2026-10-07 (pre-release)

Server jobs that did the work but ended asking "keeps going wrong… what should I do?".

- **An approved plan covers its own removals.** When the safety rules block a removal your approved server plan names (a folder, a compose project, its volumes or containers), you get one specific question, e.g. "run `rm -rf /root/misahaty` on spinet-staging (in the plan you approved)?", and Allow runs it once. Anything the plan doesn't name stays blocked.
- **Claude Code's blocks count:** they now reach the stuck rule, so "Let it run this one" works for Claude Code too.
- **What the agent needs, asked as itself:** when an agent says it's blocked or needs you, The Eye asks you that specific thing (the command, why: Allow / I'll do it / Leave it out / Stop), not "keeps going wrong".
- **Server checks in plain form:** `ssh <server> …` only; one written with Oraknid's private paths is put in plain form and runs on the server. A check that can't run (ssh can't read its config, host unreachable, key refused) is a broken check, repaired, never charged to the agent.
- **Guard checks** ("Harvest still runs") must pass before the work; one that doesn't is rewritten from what the server shows.
- **Agents may no longer make a check pass another way** (e.g. planting a file).

## 0.2.2 — 2026-10-07 (pre-release)

- **Cancel from the chat:** a Cancel button in every Eye chat (projects and servers) for a job that hasn't ended, whether running, waiting on you, blocked or paused. One confirm, and its open questions close; with several jobs going, a menu picks which. `/cancel` in the terminal app does the same, with a y/N.
- **The Eye looks things up before asking:**
  - **Names it doesn't know** (a compose project, a site, a service) are searched in server state documents, other chats, past jobs and Silk. Work that belongs to a server is taken to that server's chat, as a server job awaiting your approval of its plan, with a link; work for another project goes to that project.
  - **It only asks when nothing matches;** when several places match, it offers them as choices.
- **"Start another job" / "again"** carries the earlier job's goal, how it ended and what it learned.
- **Each chat's recent jobs**, and on a server its state document, are part of what The Eye reads before it answers.

## 0.2.1 — 2026-10-07 (pre-release)

Fixes. If your Oraknid stopped answering after updating to a dev build
of 0.2.0 ("Failed to fetch" at the lock screen), install again from the
script: `curl -fsSL https://raw.githubusercontent.com/ABakdi/Oraknid/dev/install.sh | sh -s -- --dev`
(your data and settings stay).

- **Startup:** the daemon lists every package Oraknid's own agent uses, so an installed daemon starts. A test checks it.
- **Updates:** an update whose new version builds but doesn't start is rolled back, not reported as succeeded.
- **Antigravity:** signing an Antigravity Leg in again shows the link; its earlier sign-in is kept if the new one doesn't finish.
- **The service:** its PATH keeps each folder once across updates.

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
