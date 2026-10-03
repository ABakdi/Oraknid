# Web UI

**Is:** the one place I watch and steer everything. It's simple to use
and packed with features, with nothing hidden in deep menus. Live
everywhere, usable on a phone.
**Is not:** a chat app. Conversation with Legs is limited to answering
their questions and redirecting The Eye.

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

## Layout

```
┌───────────────────────────────────────────────────────────────┐
│ Oraknid  ◉ live  ☕ awake (1 job)   Inbox (3)   ⌘K  ⚙         │ header
├──────────┬────────────────────────────────────────────────────┤
│ Overview │                                                    │
│ Jobs     │        main view                                   │
│ Projects │                                                    │
│ Inbox    │                                                    │
│ Legs     │                                                    │
│ Skills   │                                                    │
│ Logs     │                                                    │
│ Settings │                                                    │
└──────────┴────────────────────────────────────────────────────┘
```

- **Command palette (⌘K / Ctrl+K)**: jump to anything, and run any
  control (pause job, new job, approve…).
- **The sidebar folds** to icons (a button, or `[`), remembered per
  device; pages with a side panel of their own (Chats, Terminal, Email,
  a job) fold it by themselves while they are open.
- **Pages use their space** (2026-10-03): a page with more than one
  concern is in tabs, the tab in the address; each tab fills the height
  it needs, a conversation takes the whole height like Chats; changing
  tabs never jumps the page. Nothing runs off the right edge on a phone:
  long names are cut with their full text on hover, and wrap in legends.
- **Keyboard**: `?` lists every shortcut; `g` then `o`/`j`/`p`/`i`/`l`/
  `c`/`s`/`t`/`m` goes to Overview, Jobs, Projects, Inbox, Legs, Chats,
  Servers, Terminal, Mail; `[` folds the sidebar; `n` new work.
- **On mobile:** the sidebar becomes a bottom tab bar (Overview, Jobs,
  Inbox, Legs, More). Every control is reachable within two taps, and
  touch targets are at least 44 px (buttons, fields, tabs and the close
  of every dialog, on any touch screen). More closes on a tap outside,
  on Esc and when I pick a page; nothing on a phone traps me.
- **Going back** (2026-10-03): everything I drill into has a back
  control before its title: a job, a draft, a Leg opened from elsewhere,
  a skill, an inbox item, and on a phone a project, a server and a chat.
  It goes back where I came from when that was in Oraknid, else to the
  page above (Jobs, Projects…). Settings opened from a "Settings" link
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
  one, disconnecting GitHub, pruning logs, clearing the helper.

## Screens

### Overview (live)

| Panel | Shows |
| :-- | :-- |
| **Legs now** | One card per Leg: state (idle / working / waiting / rate-limited / down), the model in use, the current task, tokens this window, remaining quota (exact or *estimated*), reset time, context used by the current session. |
| **Activity stream** | Every Leg's and The Eye's actions as they happen, filterable by job, Leg and kind. Leg output appears as condensed lines that expand. |
| **Problems** | Errors, drift events, kills, escalations, blocked jobs. Each links to the evidence. |
| **Resources** | Per Leg and per process: CPU, RAM, GPU and VRAM (local models), disk I/O, network. Sparklines, with the full chart a click away. |
| **Totals** | Tokens today, by Leg. Jobs running and queued. Inbox count. |

### Job

- **The Web**, an animated graph that updates live. Nodes are tasks,
  coloured by state, showing the Leg's avatar while assigned. When a
  task moves from one Leg to another, a handoff animation travels along
  the edge. A running node pulses. Clicking a node opens the task drawer.
- **Task drawer:** instructions, scope, verify commands and their latest
  output, attempts and sessions, escalation history, checkpoints (with
  rollback), the diff, and the routing reason.
- **Tabs, in the address** (`/jobs/<id>/<tab>`): The Web (first: the
  graph and its task drawer) · The Eye (a conversation filling the page,
  as in Chats) · Agents · Activity · Silk · Inbox (this job) · Budget &
  stats · Result (once there is one) · Settings. A header above them
  keeps the title, state and controls; nothing else is above the tabs.
- **Controls** always visible: Pause / Resume, Cancel, Redirect, Edit plan,
  autonomy level.
- **Agents**: every session of the job (Legs and The Eye's reasoning),
  live or finished; opening one shows its whole output as a terminal-like
  log: text, tool calls with their commands and results, permission
  decisions, usage. It follows along while a session runs. The task
  drawer shows the task's own sessions the same way.
- **The Eye**: the prompt to The Eye and the conversation so far, above
  The Web. Each reply says what The Eye made of my message and what it
  did.
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

A list with totals. Each project page: history of jobs, tokens and time
spent, tasks completed, failures, breakdown by Leg, and a link to the
workspace and its Silk mirror. **New work** in its header starts a job
there; its Servers tab adds a server or sets one up in place, its Skills
tab shows which tools a skill still needs.

### New work

Options on the left, my prompt and the conversation with The Eye on
the right ([[Jobs-and-Projects]] → Starting work). The draft is saved as
I go; **Start**, **Delete** and the drafts list in Jobs. **Start** stays
disabled until there is a goal and a project, and says why; what it
waits for that can be set up (a Leg, a tool) is offered beside it. New
work from a project's page starts with that project chosen.

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
this computer, each server. Shortcuts (the browser keeps `Ctrl+Shift+T`
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
  server was out of reach), Account settings… (auto-send, keep what I
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

### The helper

A floating button at the bottom left of every screen opens the Oraknid
helper ([[Chats-and-Helper]]).

### Markdown

Everything a Leg or The Eye writes (session logs, the activity stream,
the Eye's conversation, chats, the helper) is rendered as markdown.

### Inbox

Approvals and questions from all jobs. Each item can be answered in
place, and reads well at any width: long commands and text wrap inside
the card, never past it. Interview rounds appear as a short form. Each item names its
project and job. Filters: project, job, kind, state, and a search over
the text.

### Legs

The registry: health, kind, model, quota, observed performance. Each
Leg is a card collapsed to one line (name, health, kind, quota), opened
to see its models and configure it: test, log in, pause, enable,
sessions at once, rename, remove; a Leg named on the Overview links
here, opened. **Add Leg** with a live test, and **Find agents on this
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
  minutes), the paired devices, The Nest's connection.
- **Connections**: email accounts ([[ADR-032-Email]]), GitHub, tools for skills.

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
