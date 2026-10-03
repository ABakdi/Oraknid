# Web UI

**Is:** the one place I watch and steer everything. It's simple to use
and packed with features, with nothing hidden in deep menus. Live
everywhere, usable on a phone.
**Is not:** only a chat app. Work goes through jobs; Chats and The
Eye's conversation sit beside them ([[Chats-and-Helper]]).

## Look

- A dense "mission control" style: dark first, with a light theme and
  a system-follow option. Built with shadcn/ui and Tailwind, restyled
  into Oraknid's own system (tokens in `apps/web/src/index.css`).
- **It follows the mark** (`public/logo.svg`): ink surfaces, **violet**
  (#8F7CFF) for what I act on (buttons, focus, the page I'm on, the
  running state), and **amber** from The Eye's iris, sparingly: what
  wants my eye (the Inbox count, the PIN dots, an interview, a
  terminal's cursor). State colours (green, gold, red, teal) carry a
  word or an icon too, never colour alone, and pass WCAG AA in both
  themes.
- **Surfaces in layers**: the frame (header and sidebar) is recessed,
  the canvas above it, cards above that, menus and dialogs highest.
  Fields are wells a step below what holds them. Height reads as a
  hairline border and an edge of light on ink; as a soft shadow on
  paper. Corners are small (8px cards, 6px controls); tags are
  squared, not pills.
- **Type**: IBM Plex Sans for the interface, JetBrains Mono for code,
  terminals, figures and small uppercase labels (table heads, groups,
  stats). Both self-hosted (the policy allows fonts from Oraknid only),
  Latin only.
- Touch targets are at least 44px on a touch screen.
- English only for now. Every string goes through an i18n layer so other
  languages can be added later.
- Updates in real time, with no refresh button anywhere. A connection
  indicator shows live / reconnecting / offline. When offline, the last
  known state stays on screen, clearly marked stale.
- A PWA, installable on desktop and phone.
- **The mark** (2026-10-03): an octopus's eye, round with a horizontal
  pupil and an amber iris, on eight jointed spider legs in violet, on a
  dark tile. `icon.svg` is the favicon and the mark in the sidebar, the
  lock screen and pairing; PNG icons (192, 512, maskable) and an
  `apple-touch-icon` for a phone's home screen; `logo.svg` is the mark
  alone. The Nest's loader uses the same.

- **A new mark is being chosen** ([[Phase-11-Workspace]] → M11.6): a
  big octopus eye with spider legs from its edges, all pointing down,
  two at the top meeting in a V. Three concepts are in
  `docs/assets/logo-concepts/`; the chosen one replaces the current
  mark in the app, the loader and the site.

## Layout

```
┌───────────────────────────────────────────────────────────────┐
│ Oraknid  ◉ live  ☕ awake (1 job)   Inbox (3)   ⌘K  ⚙         │ header
├──────────┬────────────────────────────────────────────────────┤
│ New work │                                                    │
│ Overview │                                                    │
│ Projects │        main view                                   │
│ Inbox    │                                                    │
│ Mail     │                                                    │
│ Legs     │                                                    │
│ Chats    │                                                    │
│ Servers  │                                                    │
│ Terminal │                                                    │
│ Skills   │                                                    │
│ Logs     │                                                    │
│ Docs     │                                                    │
│ Settings │                                                    │
└──────────┴────────────────────────────────────────────────────┘
```

- **Command palette (⌘K / Ctrl+K)**: jump to anything, and run any
  control (pause job, new job, approve…).
- **The sidebar folds** to icons (a button, or `[`), remembered per
  device; pages with a side panel of their own (Chats, Terminal, Email,
  a job opened in a project's Work tab) fold it by themselves while
  they are open.
- **Pages use their space** (2026-10-03): a page with more than one
  concern is in tabs, the tab in the address; each tab fills the height
  it needs, a conversation takes the whole height like Chats; changing
  tabs never jumps the page. Nothing runs off the right edge on a phone:
  long names are cut with their full text on hover, and wrap in legends.
- **Keyboard**: `?` lists every shortcut; `g` then `o`/`p`/`i`/`l`/
  `c`/`s`/`t`/`m`/`k`/`d`/`,` goes to Overview, Projects, Inbox, Legs,
  Chats, Servers, Terminal, Mail, Skills, Docs, Settings (`g j` went with the
  Jobs page, 2026-10-03); `1`…`9` goes to that tab on a page with tabs
  (a job's own tabs inside Work don't take them); `[` folds the sidebar; `n` new work; Ctrl+K
  the command palette. Single keys stay out of the way while I type.
- **On mobile:** the sidebar becomes a bottom tab bar (Overview,
  Projects, Inbox, Legs, More). Every control is reachable within two taps, and
  touch targets are at least 44 px (buttons, fields, tabs and the close
  of every dialog, on any touch screen). More closes on a tap outside,
  on Esc and when I pick a page; nothing on a phone traps me.
- **Going back** (2026-10-03): everything I drill into has a back
  control before its title: a job (back to its project's Work), a draft,
  a Leg opened from elsewhere, a skill, an inbox item, and on a phone a
  project, a server and a chat. It goes back where I came from when
  that was in Oraknid, else to the page above (Projects, New work…). Settings opened from a "Settings" link
  next to a control has one too. A job's task drawer is a step of its
  own: the phone's back, Esc or ✕ close it. Every dialog closes with Esc
  and has a visible ✕; buttons sit with the main one on the right.
- **Set up in place** (2026-10-03): a page that needs something set up
  elsewhere offers it right there, in a dialog holding the same card as
  Settings, with "Open in Settings" as a link: a Leg (find agents, or
  add one) where none is healthy (Overview, New work, a new chat), the
  tools a skill needs (New work, a job, a skill, a project's skills),
  GitHub (New work), a server (a project's servers, with Set it up for
  one not set up yet), the terminal (turned on from the Terminal page,
  with the same confirmation), a skill from a .md file (New work).
- **A second step** for what can't be taken back, naming what happens:
  cancelling a job, removing a task, rolling a task back, deleting a
  draft, a project, a skill or a chat, removing a Leg, a server or a
  tool, accepting a changed host key, revoking a device, unpairing this
  one, removing a GitHub account, unlinking a project's GitHub repo,
  pruning logs, clearing the helper.

## Screens

### Overview (live)

| Panel | Shows |
| :-- | :-- |
| **Plan usage** | (2026-10-03, [[ADR-039-Plan-Usage-In-View]]) A row per Claude Code Leg (and any Leg with windows), the one closest to a limit first: each window fullest first, as a bar and a percentage, when it resets, Oraknid's tokens in it, and how old the figures are ("as of 4 min ago"); near (80%) and at (100%) the limit said in words. Fresh figures are asked for every minute while it is open. |
| **Legs now** | One card per Leg: state (idle / working / waiting / rate-limited / down), the model in use, the current task, context used by the current session. Its windows are in Plan usage. |
| **Activity stream** | Every Leg's and The Eye's actions as they happen, filterable by job, Leg and kind. Leg output appears as condensed lines that expand. |
| **Problems** | Errors, drift events, kills, escalations, blocked jobs. Each links to the evidence. |
| **Resources** | Per Leg and per process: CPU, RAM, GPU and VRAM (local models), disk I/O, network. Sparklines, with the full chart a click away. |
| **Running now** | (2026-10-03, [[ADR-034-Projects-First]]) Every job going, waiting, paused or queued, across projects: its title, its project, its progress, a queued mark, and Pause or Resume on its row. A job opens in its project's Work tab. `/jobs` comes here. |
| **Totals** | Tokens today, by Leg. Jobs running and queued (the tile goes to Running now). Inbox count. |

### Job

There is no job page ([[ADR-034-Projects-First]], 2026-10-03): a job
is opened in its project's Work tab (below), with everything the job
page had. `/jobs/<id>` and `/jobs/<id>/<tab>` (from notifications, push,
old links) open the job's project at Work with that job open, its old
Eye tab at the project's Eye tab; a draft opens on New work.

- **The Web**, an animated graph that updates live. Nodes are tasks,
  coloured by state, showing the Leg's avatar while assigned. When a
  task moves from one Leg to another, a handoff animation travels along
  the edge. A running node pulses. Clicking a node opens the task drawer.
- **Task drawer:** instructions, scope, verify commands and their latest
  output, attempts and sessions, escalation history, checkpoints (with
  rollback), the diff, and the routing reason.
- **A job opened** (`/projects/<p>/work/<job>/<part>`): a header with its
  title, state, branch, tokens and controls, then its own tabs: Tasks
  (its Web, the task drawer, add a task, order, the plan beside its
  shadow) · Result (once completed) · Agents · Activity · Silk · Inbox
  (this job) · Budget & stats · Settings. Back goes to the Work list.
- **Controls** always visible: Pause / Resume, Cancel, Redirect, priority,
  autonomy level; Edit plan in Tasks.
- **Agents**: every session of the job (Legs and The Eye's reasoning),
  live or finished; opening one shows its whole output as a terminal-like
  log: text, tool calls with their commands and results, permission
  decisions, usage. It follows along while a session runs. The task
  drawer shows the task's own sessions the same way.
- **Result**: once the job is completed, where the work is (folder,
  branch, commits), Open (on this computer) and Merge into the work
  branch, with a confirmation; conflicting files are listed.
- **Plan editor:** drag to reorder dependencies, edit task text, add and
  remove tasks. Running tasks are paused before an edit is applied.

### Charts (job, project and global level)

Token usage over time (stacked by Leg), cost (when any), task
throughput, success and failure rates by Leg and task kind, Leg
performance comparison (success, tokens per verified task, time per
task), budget burn against limits.

### Projects

A list with totals, and the project open beside it: **the place I
work** ([[ADR-034-Projects-First]], 2026-10-03). Its page is in tabs, in
the address (`/projects/<id>/<tab>`):

- **The Eye**: the project's one conversation with The Eye, filling the
  page like a chat. I ask for work here; The Eye passes it to the job
  running, starts a follow-up when the last has ended, or a first job
  ([[The-Eye]] → Talking to The Eye). Each reply links the job it
  touched (and the follow-up it started); a line marks where the
  conversation moves to another job. The header says which job it talks
  to now. A reply with questions shows them under it (Questions, below)
  until I answer; my answers show as a short list.
- **Workflow** (the project's Web, named so in the UI, 2026-10-03,
  [[ADR-034-Projects-First]] → Changed): only the diagram, filling the
  tab, its controls floating over it (Compact / Expanded at the top
  left, zoom and fit at the bottom right); pinch and drag on a phone.
  **Compact**, the default: a box per job in the order they ran (title,
  state, tasks done), the job the project is about now highlighted.
  Selecting a box goes inside it, `/projects/<id>/workflow/<job>`: that
  job's own tasks, with **All jobs** to come back and "Open in Work".
  **Expanded**: every job's tasks drawn in full, each inside a frame
  named by its job (a click on the name goes inside it), one after
  another, left to right on a computer, top to bottom on a phone. The
  choice is kept per project on the device. A task opens its drawer.
  `/projects/<id>/web` (the old address) opens Workflow.
- **Work**: the jobs as a timeline, newest first: title, state,
  progress, branch, tokens, a queued mark, Pause or Resume. Opening one
  shows it in place (Job, above); a draft opens on New work.
- **Inbox**: the project's approvals and questions, answered in place.
- **Silk**: the project's Silk kept by job, newest job first, the newest
  open ([[Silk]] → Per project); a decision I add goes to the job The
  Eye talks to now.
- **Activity**: every job's events, live, each line naming its job.
- **Budget & stats**: the project's budget across its jobs (what they
  used against it, a note while a job waits at its limit, and a dialog
  to change it; [[Budgets-and-Quotas]] → A project's budget), then
  tokens, time, tasks done, success, tokens per day and the breakdown
  by Leg.
- **Settings**: its **GitHub repo** beside its **servers**
  ([[ADR-038-Project-Accounts]]): the linked repository (owner/name, who
  can see it, "to be created" until it is, the account), Change and
  Unlink (a second step), or "Link a repo" (account, a new or an
  existing repository, owner, name, who can see it); then the folder and
  branches, archive or delete, and the project's command rules.
- **Skills**, **Servers**, **Network** (the ports on this computer its
  jobs may reach, like a local database; [[Sandboxing]]).

**New work** in its header opens its Eye tab. Its Servers tab adds a
server or sets one up in place, its Skills tab shows which tools a
skill still needs. With a job open, the list of projects steps aside
below 1280 px.

### New work

Options on the left, my prompt and the conversation with The Eye on
the right ([[Jobs-and-Projects]] → Starting work). It is for a first
request, a new project or a draft; more work in a project is asked in
its Eye tab. The drafts are listed above the form. The draft is saved as
I go; **Start** and **Delete**. **Start** stays disabled until there is
a goal and a project, and says why; what it waits for that can be set
up (a Leg, a tool) is offered beside it. Its budget starts as the
chosen project's. Once started, it lands in the project's Eye tab.

### Chats

My chats with any Leg and model, like a chat app ([[Chats-and-Helper]]).

### Servers

My servers ([[Servers]]): each with its state, its state document,
oraknid-monitor's readings live and over 24 hours, services and ports;
add, discover again, edit the document, edit its name and description,
open a terminal, remove.

### Terminal

A terminal workspace (xterm.js), when turned on in Settings → Security
or on this page itself while it is off ([[ADR-028-Terminal]]): terminals in tabs, and side by side or in a grid
(one, two columns, two by two). A new terminal is picked from cards:
this computer, each server. Away from home it opens only on a device
with full rights ([[ADR-030-Device-Rights]]). Shortcuts (the browser keeps `Ctrl+Shift+T`
and `W` for itself, and `Ctrl+Shift+Q` quits Chrome on Linux):
`Ctrl+Shift+Enter` new, `Ctrl+Shift+X` close, `Ctrl+Shift+←/→`
previous and next, `Ctrl+Shift+1…9` go to, `Ctrl+Shift+D` side by side,
`Ctrl+Shift+G` grid, `Ctrl+Shift+F` one at a time; copy on select,
`Ctrl+Shift+V` paste.

### Mail

An email client ([[ADR-032-Email]]) at `/mail`, in the sidebar. Three
panes on a wide screen: accounts and their folders, the conversations
of a folder, the open conversation. On a phone the list fills the
screen: a button in its header (and the account and folder named under
it) opens the folders and accounts in a drawer, which closes once I
pick one; Write is beside the search; an open conversation has "Back
to the list". Everything works at 390 px wide.

- **The list** is virtual: only the rows on screen are drawn, and pages
  of a hundred conversations are fetched as they scroll into view, so a
  folder of ten thousand scrolls smoothly. Each row: who wrote, how
  many messages, the subject, a snippet, unread, starred, attachments,
  an agent's draft waiting. A search box searches the folder, here and
  on the server (IMAP). New mail appears on its own (IDLE for IMAP, a
  check every two minutes for POP); a button checks now.
- **The conversation**: each message once, the last and the unread
  ones open; opening it marks it read (on the server, for IMAP).
  Archive, delete, mark unread, star, move to a folder, reply, reply
  all, forward. Attachments download. HTML is cleaned and shown in a
  sandboxed frame; remote images are hidden, with "Show images" and
  "Always from this sender".
- **Writing**: a dialog with From (when there are several accounts),
  To, Cc/Bcc, Subject, a rich text editor (bold, italic, lists, quote),
  attachments up to 25 MB; Send (Ctrl+Enter) or Save draft. A reply is
  addressed and quoted for me.
- **Agents' drafts** are marked "Written by an agent" in their
  conversation, with Approve and send, Edit, Discard; those waiting for
  me are also in a "Waiting for you" folder, and in the inbox when a
  job wrote them.
- **Accounts, here**: "Add an account" under the folders (and on the
  empty page) opens the same form as Settings. Each account has a menu:
  Check for mail, Reconnect… (a new password, or the one kept after the
  server was out of reach), Account settings… (its name, auto-send, keep what I
  send in Sent, and for POP delete from the server), and Remove from
  Oraknid…, after a second step. Not from away, except checking.
- **Reconnect**: an account whose login stopped working says so above
  the list, with a Reconnect button that asks for the new password.
- **Keys**: c write, / search, j and k next and previous conversation,
  e archive, # delete, r reply, a reply all, f forward, s star, u
  unread, Esc back.

Settings → Connections has **Email accounts** too: add Gmail, Outlook
(with an app password, and a link to where each provider makes one) or
another server, by IMAP or POP3 with SMTP; remove one; auto-send per
account (off by default), file sent mail in Sent, and for POP delete
from the server (off by default). Sign-in with Google or Microsoft
(OAuth) waits until a few releases from now. Not from away.

Adding an account: the address's servers are found from its MX records
and filled in (Namecheap, Google, Microsoft, Zoho, Fastmail and others);
port and security move together; **Test** checks the incoming server
and SMTP each on its own; a refusal says in plain words what to check
([[ADR-032-Email]] → Fixed after a failed Namecheap POP account).

### Questions (2026-10-03, [[ADR-037-Questions-With-Options]])

One component answers the interview (New work, the inbox) and The Eye's
questions in a project's conversation:

- The questions in **tabs**, one shown at a time, a check on those
  answered, and a **Summary** tab last listing each answer (a click goes
  back to its question).
- Options as rows: their number, a radio (`single`, `confirm`) or a box
  (`multi`), the label and its detail; the recommended one marked in
  amber and selected from the start. A row "Other" takes a typed answer
  (in a single choice it replaces the option). A `text` question is a
  text box.
- Keys, while the questions have the focus: ↑/↓ move between options
  (and Other), Space selects (toggles in a `multi`), Enter confirms and
  goes to the next question (on a single choice it takes the option it
  is on; in a text answer Shift+Enter is a new line), ←/→ or Tab
  (Shift+Tab back) move between questions, 1–9 pick an option; on the
  Summary, Enter submits. The page's own shortcuts never see these
  keys. A hint line says them on a wide screen.
- Rows at least 44 px, tabs too on a touch screen; Next, back and
  Submit at the bottom. **Submit** sends every answer; a question left
  unanswered takes its recommended option, else goes as unanswered.

### The helper

A floating button at the bottom left of every screen opens the Oraknid
helper ([[Chats-and-Helper]]). It knows the guide and a map of the
screens, and shows me things here: it opens a page, rings a control
with a short note (opening the menu, dialog or drawer that holds it),
or fills a field for me to check ([[ADR-041-Docs-And-A-Guiding-Helper]]).
The controls it can point at carry a `data-help` id from the map
(`src/lib/help-map.ts`). On a phone its panel steps aside while it
shows me something and comes back with a tap on its button.

### Docs

The guide (`/docs`, `/docs/<page>`, `/docs/<page>/<heading>`, `g d`), in
the sidebar and in More on a phone ([[ADR-041-Docs-And-A-Guiding-Helper]]):
the site's own pages (`apps/site/docs/*.md`, their order in
`guide.json`), put in the app when it is built so they read the same
offline and through The Nest. The pages are listed beside the one open
(on a phone the list, then the page with a way back); a search over
headings and text lists the places it found, with a snippet; each
heading has a link to itself; Previous and Next at the end. The site's
links (`jobs.html`) open the app's pages. Each page has **Ask the helper
about this**, which opens the helper with that page as its context.

### Markdown

Everything a Leg or The Eye writes (session logs, the activity stream,
the Eye's conversation, chats, the helper) is rendered as markdown.

### Inbox

Approvals and questions from all jobs. Each item can be answered in
place, and reads well at any width: long commands and text wrap inside
the card, never past it; a command in a title shows as code. An
interview round, and any question asked with options, opens the
questions component (Questions, below), with "Enough, start" beside
Submit for a round; an old round asked in prose shows as before. Each item names its
project and job. Filters: project, job, kind, state, and a search over
the text.

### Legs

The registry: health, kind, model, quota, observed performance. Each
Leg is a card collapsed to one line (name, health, kind, quota), opened
to see its models and configure it: test, log in, pause, enable,
sessions at once, rename, remove; a Leg named on the Overview links
here, opened. An opened Leg shows its **plan usage**
([[ADR-039-Plan-Usage-In-View]]): each window larger, with its reset,
how old it is and where it was read, the models' share of Oraknid's
tokens in it, and the last eight days as a line with when it filled and
reset; another kind says what it has instead. **Add Leg** with a live test, and **Find agents on this
machine**. The capability profile editor shows learned
values next to my overrides.

### Skills

The library: view (rendered markdown), upload, edit with preview,
versions. The open skill is in the address (`/skills/<id>`); on a phone
the list and the skill take turns, with a way back. An uploaded skill's
earlier versions are a choice away; a built-in is read-only, and "Make a
copy to change" opens it as a new skill of mine. Editing keeps every
front-matter field (its tools and checks too).

### Logs

The audit trail and the daemon's logs, in tabs in the address
(`/logs/<tab>`): search, filters, export; "Older" pages back and "Back
to the newest" returns.

### Settings

In tabs, each one concern in sections; the tab is in the address
(`/settings/<tab>`), and changing tabs keeps the way back to the page
that opened Settings:
- **General**: this computer (keychain, sandbox, sleep inhibition),
  storage use and pruning, notifications, theme.
- **Eye & jobs**: The Eye's models, jobs at once, same-provider fallback.
- **Security**: the PIN and idle lock ([[ADR-029-App-Lock]]), the
  allow/deny list, the terminal.
- **Devices & phone**: pairing my phone in one step (a QR code to scan;
  it needs the PIN and The Nest, and the code expires unused after ten
  minutes; "Full rights from this device", with the PIN, says what that
  means before I tick it), the paired devices with their rights (full
  rights given or taken on a device's row, at home, with the PIN;
  [[ADR-030-Device-Rights]]), The Nest's connection: "Use a public
  Nest" in one click, or "My own Nest" ([[ADR-031-Public-Nest]]).
- **Connections**: email accounts ([[ADR-032-Email]]), GitHub (my
  accounts by name, the first the default, each token checked, with
  why GitHub refuses one; add one, remove one after a second step;
  [[ADR-038-Project-Accounts]]), tools for skills.

### The lock

With the PIN set, a device opens on a PIN pad (digits big enough for a
thumb) until it is unlocked; idle, it locks again. A wrong PIN says how
many tries are left before the device is unpaired.

## Empty, loading and error states

- No Legs yet → the Overview shows a single "Add your first Leg" card
  that explains what a Leg is, with Find agents and Add a Leg on it.
- Every empty list says what would be there and offers the action that
  fills it (New work, New chat, New project, Add a server, Clear the
  filters…).
- No jobs → "Start a job". If no Leg is healthy, it says why the button
  is disabled.
- Every error says what happened and what I can do. No error is shown
  only as a code (BR-17).

Related: [[Jobs-and-Projects]] · [[Realtime-Transport]] · [[Notifications]] · [[ADR-005-Charts-and-Graph-Visualization]]
