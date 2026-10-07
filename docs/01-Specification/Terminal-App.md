# Terminal app

**Is:** Oraknid in a terminal ([[ADR-055-Terminal-App]]): The Eye's
conversation of the current project above, a prompt at the bottom, and
everything else through slash commands, in the style of Claude Code.
The third client of the API, beside the web UI and the phone.
**Is not:** a second implementation. Every action is an API procedure the
web uses too; the terminal adds none of its own.

## Opening it

- `oraknid` with no arguments, or `oraknid tui`, opens it full screen (the
  terminal's alternate screen, given back as it was on leaving). The
  daemon must be running; the app reaches it on 127.0.0.1 with the CLI's
  token from the runtime file, which needs no pairing and no PIN.
- Ink (React for the terminal) is loaded only then, from its own chunk of
  the build: the service, `oraknid run`, never loads Ink or React.
- The current project, the server and whether the prompt talks to the
  server's Eye are remembered in `<config>/tui.json` for the next opening.
  With one project it is chosen; with several and none remembered, the
  app says to pick one (`/projects`).

## The screen

From the top:

1. **A notice line**, when something asks for me: a question or an
   approval (`inbox.opened`), danger on this computer (`machine.incident`,
   level danger), or at the start how many items wait. With the bell.
2. **The conversation**, or the panel a command opened (below). It is
   the web's transcript ([[Web-UI]] → The Eye's conversation): my prompts
   marked `›` in bold; The Eye's replies as Markdown rendered for the
   terminal (headings, emphasis, code, lists, links with their address,
   tables' cells apart), with `[intent] · what it did · the job` under
   each; its open questions with their options numbered and "Answer with
   /answer"; a rule with the job's title where the conversation moves to
   another job; each reasoning call live (what it does, its time, its
   model, "Esc stops" when it can be stopped, and the last lines it
   writes, the reasoning dim), then folded to one line ("✓ Planned 9 tasks
   in 41 s · Claude · Opus"), three or more quick ones in a row as "Thought
   N times"; "The Eye is reading your message…" before its first thought;
   and a line per running task (the task, what it does now, its Leg, model
   and time). The newest at the bottom; PgUp/PgDn scroll back.
3. **The thinking bar**, while The Eye thinks: what it is doing, and
   either "Esc stops it" or, once I write, the two ways my message can go,
   "stop and redo with this" or "add as context", the chosen one in
   brackets: guessed from my words as the web does, **Tab** switches it.
4. **The command menu**, while I type `/` and a word: the commands
   starting with it, then those containing it, those that fit where I am
   (a job, a server) first; eight at a time around the chosen one.
5. **A line of feedback**: what a command did, or why it couldn't, in
   words (green or red), for a few seconds.
6. **The prompt**, framed; its frame is amber when what I type answers
   the panel above rather than going to The Eye.
7. **Where I am**: the project (or the server's Eye), the server, the job,
   and the live socket's state.

## Keys

- **Enter** sends; a line ending in `\` goes on to a new one; a paste
  keeps its lines.
- **Esc**: closes the menu; else goes back one panel; else stops The
  Eye's thinking (`projects.stopThinking`); else clears the prompt.
- **Tab**: completes the command chosen in the menu; while The Eye thinks,
  switches what my message does.
- **↑↓**: in the menu, choose; in a list, move; in a text panel, scroll;
  else the prompts I sent before. **PgUp/PgDn** scroll.
- **Ctrl+U** clears the prompt, **Ctrl+W** a word; **Ctrl+C** clears, and
  on an empty prompt twice leaves (Oraknid keeps running).

## Panels and numbered lists

A command opens a panel over the conversation: a numbered list, lines, or
both. A number picks an item, at once when no longer number fits (3 in a
list of 5) and with Enter when one could (1 in a list of 12); **↑↓** and
**Enter** pick too. **Esc** goes back to the panel before, then to the
conversation. A panel that follows something live (a job, the inbox, a
server, a followed log) reads itself again when its live topic moves.
Where a panel takes an answer (an inbox item, a question, a setting's new
value), what I type goes to it, not to The Eye.

## Commands

Each with its one line of help (`/help`):

- `/projects`, `/project <n|name>`: the projects (archived and servers' own
  left out); picking one makes it the current project and the prompt
  talks to its Eye.
- `/jobs [all]`, `/job <n|name>`: the project's jobs (every project's with
  `all`), newest first; a job's panel shows its state, tasks done,
  tokens, why it is paused or blocked, its branch, and its plan as a tree
  (each task under the first task it depends on, with its state, Leg and
  model, why it waits); a number opens a task (its instructions, checks,
  scope). The job opened becomes the current job.
- `/logs`: on the current server (or a server chosen and no job), its log
  sources, a number following one live (`logs-open` on the live socket,
  stopped on Esc); on the current job, its sessions, a number showing
  that session's log, read again as it grows; else Oraknid's own log.
- `/pause`, `/resume`, `/cancel`, `/redirect <instruction>`: the current
  job.
- `/inbox`: open items, approvals and questions; a number opens one, then
  a number picks its option or my words answer it; items asked with
  questions go through them one at a time.
- `/answer`: The Eye's open questions in this conversation, one at a time,
  a number picking an option (several as `1,3` where a question takes
  several), my words where it takes them.
- `/stop`: what Esc does while The Eye thinks.
- `/servers`, `/server <n|name>`: the servers; picking one makes it the
  current server and shows its overview (address, production, set up,
  last seen, errors, its latest reading).
- On the current server: `/chat` (the prompt talks to the server's Eye,
  [[ADR-049-Server-Chat-And-Server-Jobs]]; again: back to the project's),
  `/docker`, `/db`, `/proxy` (sites, upstreams, certificates and when they
  end), `/state` (its state document), `/ssh`, `/backups` (also without a
  server: every plan).
- `/ssh`: the app makes way for a shell on the server through the
  daemon's terminal socket (`/term`, [[ADR-028-Terminal]]): Oraknid's key
  never leaves the daemon, the shell is audited like the web's, and it is
  off until turned on (`/settings terminal on`; off, it says so).
  **Ctrl+]** leaves it and the app comes back where it was.
- `/agents`: the Legs, their health, models and fullest plan window; a
  number shows a Leg's plan windows and models. `/models`: local models
  ([[ADR-054-Local-Models]]) when the daemon has their procedures (it says
  it hasn't, otherwise), then each Leg's models.
- `/usage` (Oraknid's use, the plan windows), `/health` (this computer:
  state, tasks running of the limit, the reading, incidents, tasks paused
  for room).
- `/mail` (accounts, then a number: their threads), `/repos` (GitHub),
  `/storage` (Oraknid's disk use, the biggest jobs' logs, cloud storage),
  `/chats` (a number: the conversation), `/skills`.
- `/settings`: the common ones by name, with their values:
  `max-running-jobs`, `max-tasks-per-job` (a number or `auto`),
  `interview-rounds`, `terminal` (on/off); a number asks for the new
  value, or `/settings <name> <value>` at once. The rest is in the web UI.
- `/update`: the version, channel, newer releases or work on dev; "Update
  now" when there is one and this is an install by the script.
  `/doctor`: the checks, with what to do.
- `/help`, `/quit`.

A command that needs a job or a server says so when none is chosen ("No
server chosen: pick one with /servers."); an unknown one says to see
`/help`; a procedure the daemon hasn't got is said in words, never a
crash.

## Without the web UI

A terminal-only install ([[ADR-036-One-Script-Install]] → With or without
the web UI) builds no web UI. The daemon then answers `/` (and any page)
with a few lines of text: this Oraknid has no web UI, use `oraknid` in a
terminal, `oraknid install --gui` adds it. `system.status` says `webUi:
false` when the install record says `"gui": false` (a clone without a web
build still has the web UI: Vite serves it in development); then `oraknid
open` and `oraknid pair` say a browser or a phone needs the web UI, and
pairing a phone for away (`nest.pairAway`) says the phone needs it.

Related: [[Web-UI]] · [[ADR-055-Terminal-App]] · [[The-Eye]] · [[Servers]]
