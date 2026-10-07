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
