# ADR-055 — Oraknid in the terminal, and an install without the web UI

**Status:** Accepted · 2026-10-07 · [[Phase-15-Agents-That-Deliver]] · extends [[ADR-036-One-Script-Install]]

## Context
On a machine without a desktop (a server, a box over SSH), or when I
don't want a whole web interface, I want Oraknid in the terminal: I open
it, prompt it there, and reach everything with slash commands in the
style of Claude Code (`/servers` lists my servers, numbered; I pick one
and do everything from there). And the install should let me leave the
web UI out, saving space and build time.

## Decision

### `oraknid` opens the terminal app
- `oraknid` with no arguments (or `oraknid tui`) opens a full-screen
  terminal app built with **Ink** (React for the terminal; the same
  contracts and API client as the web UI, over the daemon's API on
  127.0.0.1 with the CLI's local token). The existing subcommands
  (`start`, `status`, `pair`, `update`, `doctor`…) stay.
- **A prompt at the bottom**, The Eye's conversation above it, the same
  transcript as the web's ([[ADR-034-Projects-First]], M13.25): my
  prompts marked `›`, replies in rendered markdown, The Eye's thinking
  live and folded, agents' work as one line each. Esc stops what The
  Eye is thinking; while it thinks my message offers "redo with this"
  or "add as context".
- **Slash commands** with completion as I type (`/` lists them):
  - `/projects`, `/project <n>`: the list numbered; picking one makes it
    the current project, the prompt then talks to its Eye.
  - `/jobs`, `/job <n>`: a job's plan as a tree, its tasks, logs
    (`/logs`), `/pause`, `/resume`, `/cancel`, `/redirect`.
  - `/inbox`: questions and approvals, answered by number or option.
  - `/servers`, then a number: its overview, `/chat` (the server's Eye,
    ADR-049), `/docker`, `/db`, `/proxy`, `/logs` (followed), `/state`,
    `/ssh` (a shell on it, through Oraknid's key), `/backups`.
  - `/agents` (Legs, their accounts, usage and quota), `/models`
    ([[ADR-054-Local-Models]]), `/usage`, `/health`.
  - `/mail`, `/repos`, `/storage`, `/backups`, `/chats`, `/skills`.
  - `/settings` (the common ones by name), `/update`, `/doctor`,
    `/help`, `/quit`.
  - Lists are numbered; a number picks; `↑↓` and Enter work too; `Esc`
    goes back. Every command has a one-line help.
- **Live**: the same live socket as the web (events, metrics), so a job
  moves on screen and a question appears when The Eye asks.
- **Notifications** in the terminal: a line at the top for a question,
  an approval, danger (ADR-050), the bell if I allow it.
- Away from home it is not needed: on another machine I use the web
  through the Nest; over SSH I run `oraknid` on the machine itself.

### Install with or without the web UI
- `install.sh` asks (or `--no-gui` / `--gui`): **with the web UI**
  (default on a desktop), or **terminal only** (default when there is
  no display and no browser). Terminal only skips building `apps/web`
  (and its dependencies are not installed), the daemon serves the API
  and the Nest tunnel but no pages; `/` answers "this Oraknid has no web
  UI, use `oraknid` in a terminal". The install record keeps the choice
  (`gui: false`), updates honour it, and `oraknid install --gui` adds the
  web UI later.
- A phone paired through the Nest needs the web UI on the daemon (the
  loader fetches it); terminal-only says so at pairing.

## Consequences
- A third client of the API (web, phone, terminal): every action stays
  an API procedure; the terminal adds none of its own.
- Ink adds a dependency to the daemon package's CLI only, loaded only
  when the terminal app opens (the service doesn't load it).

## As built (2026-10-07, M15.6)

- **The app** is `apps/daemon/src/tui/` (spec: [[Terminal-App]]): Ink 8
  with React 19, imported by `oraknid` / `oraknid tui` with a dynamic
  `import()`, so tsdown puts it in its own chunk and `oraknid run` never
  loads it. It uses the same oRPC client and router types as the web,
  over 127.0.0.1 with the CLI's token (which needs no unlocking), and its
  own Node client of `/live` (topics, replay, followed server logs). No
  procedure was added for it: `system.status` gained `webUi`, the one new
  field.
- **The transcript** is the web's, drawn as text: messages and thoughts
  merged and folded the same way (the function is repeated, not shared:
  the web's sits in a React DOM component), Markdown rendered to ANSI by
  a small renderer of its own rather than a library. Thinking live shows
  its last six lines.
- **While it thinks**, "redo with this" or "add as context" is guessed
  from my words (`correctsThinking`, as the web) and switched with Tab.
- **Commands**: every one listed in the Decision, plus `/answer` (The
  Eye's open questions here), `/stop`, `/server <n>`, `/project <n>`;
  `/settings` covers max running jobs, max tasks per job, interview
  rounds and the terminal. `/models` reads `models.list` when the daemon
  has it (ADR-054) and says it hasn't otherwise.
- **`/ssh`** goes through the daemon's terminal socket (`/term`,
  [[ADR-028-Terminal]]) rather than an `ssh` started here: Oraknid's key
  stays in the daemon's keychain, the shell is audited and follows the
  terminal's on/off setting as the web's does. Ctrl+] leaves it.
- **Notifications**: a line at the top and the bell for `inbox.opened`
  and danger (`machine.incident`); the bell is always on (no setting yet).
- **Terminal only**: `install.sh --gui` / `--no-gui`, asked through
  `/dev/tty` when neither is given ([[ADR-036-One-Script-Install]] → With
  or without the web UI); `.oraknid-install.json` gains `gui`; updates
  pass it on; `oraknid install --gui` builds the web UI in place. Without
  a web build the daemon answers every page with a few lines of text; on
  an install recorded terminal only (`system.status.webUi` false; a
  developer's clone, whose web UI Vite serves, is not), `oraknid open`,
  `oraknid pair` and `nest.pairAway` say a browser or a phone needs the
  web UI.
- **Not done**: the terminal app can't create a project, a server or a
  Leg, or edit the plan (the web UI does); a long reply wraps in the
  terminal and the transcript scrolls by lines, not by wrapped rows; no
  mouse.
