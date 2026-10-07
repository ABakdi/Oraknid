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
- **The mark** (2026-10-03): a big round eye with an amber iris and a
  tall slit pupil with a gentle wave along it (changed from a horizontal
  pupil the same day: I kept this mark over the concepts), on eight jointed spider legs in violet, on a
  dark tile. `icon.svg` is the favicon and the mark in the sidebar, the
  lock screen and pairing; PNG icons (192, 512, maskable) and an
  `apple-touch-icon` for a phone's home screen; `logo.svg` is the mark
  alone. The Nest's loader uses the same.

- The three concepts drawn for a new mark stay in
  `docs/assets/logo-concepts/`, with the kept mark beside them
  (`chosen.svg`, `chosen-icon.svg`, `chosen.png`); I kept the current mark, with its pupil
  made vertical and gently wavy ([[Phase-11-Workspace]] → M11.6).

## Layout

```
┌───────────────────────────────────────────────────────────────┐
│ Oraknid  ◉ live  ☕ awake (1 job)  Inbox (3)  ⌘K  ⚙  New work  │ header
├───────────────┬───────────────────────────────────────────────┤
│ Overview      │                                               │
│ Projects      │                                               │
│ Repos         │        main view                              │
│ Inbox         │                                               │
│ Mail          │                                               │
│ Legs          │                                               │
│ Models        │                                               │
│ Chats         │                                               │
│ Servers       │                                               │
│ Cloud storage │                                               │
│ Terminal      │                                               │
│ Skills        │                                               │
│ Logs          │                                               │
│ Docs          │                                               │
│ Settings      │                                               │
└───────────────┴───────────────────────────────────────────────┘
```

New work is a button in the header, and in More on a phone; Cloud
storage sits between Servers and Terminal (2026-10-03); Models after
Legs (2026-10-07).

- **Command palette (⌘K / Ctrl+K)**: jump to anything, and run any
  control (pause job, new job, approve…). A job shows its name with its
  description under it, and is found by either (2026-10-04).
  As built (2026-10-07, `command-palette.tsx`, `lib/palette.ts`): it
  jumps to the pages, my projects, jobs, inbox items, chats, servers,
  Legs, local models, skills, GitHub repos and the guide's pages, and runs
  New work, New chat, Open the terminal, Check for updates, Pause, Resume
  and Cancel a job (Cancel asks a second time, naming what happens) and
  each option of an open approval (Approve, Deny…). The search is fuzzy
  (each word's letters in order, a plain match and a word's start first),
  over the name, what is under it and its words, at most eight of a group
  so every group shows. With nothing typed it lists what I opened from it
  lately (eight, on this device), then the pages and controls. Its lists
  load when it opens, each on its own (no GitHub leaves the rest).
- **The sidebar folds** to icons (a button, or `[`), remembered per
  device; pages with a side panel of their own (Chats, Terminal, Email,
  a job opened in a project's Work tab) fold it by themselves while
  they are open. Above the fold button, Oraknid's version and whether
  an update waits (2026-10-04, [[ADR-048-Updates]]; Settings → About & updates).
  When the sleep lock can't be taken, **may sleep** in the header (yellow,
  its reason in a tooltip; [[Durability]] → Sleep inhibition, 2026-10-07).
- **Pages use their space** (2026-10-03): a page with more than one
  concern is in tabs, the tab in the address; each tab fills the height
  it needs, a conversation takes the whole height like Chats; changing
  tabs never jumps the page. Nothing runs off the right edge on a phone:
  long names are cut with their full text on hover, and wrap in legends.
- **Keyboard**: `?` lists every shortcut; `g` then `o`/`p`/`r`/`i`/`l`/`e`/
  `c`/`s`/`t`/`m`/`y`/`k`/`d`/`,` goes to Overview, Projects, Repos, Inbox, Legs, Models,
  Chats, Servers, Terminal, Mail, Cloud storage, Skills, Docs, Settings (`g j` went with the
  Jobs page, 2026-10-03); `1`…`9` goes to that tab on a page with tabs
  (a job's own tabs inside Work don't take them); `[` folds the sidebar; `n` new work; Ctrl+K
  the command palette. Single keys stay out of the way while I type. The
  key after `g` is `g`'s alone: no page's own shortcut sees it (`g r` on
  Mail goes to Repos without replying).
- **On mobile:** the sidebar becomes a bottom tab bar (Overview,
  Projects, Inbox, Legs, More). Every control is reachable within two taps, and
  touch targets are at least 44 px (buttons, fields, tabs and the close
  of every dialog, on any touch screen). More closes on a tap outside,
  on Esc and when I pick a page; nothing on a phone traps me.
- **Full rights, on the device** (2026-10-07, [[ADR-030-Device-Rights]]):
  a device with full rights shows it in the header on every page ("Full
  rights", "Full rights, away" through The Nest), and on the Terminal
  away from home, with what it allows and that each use away from home
  is in the audit log. A standard device shows nothing.
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
| **Activity stream** | Every Leg's and The Eye's actions as they happen, filterable by job, Leg and kind. Leg output appears as condensed lines that expand. As built (2026-10-07, `overview-activity.tsx`, `lib/events.ts`): each line says what happened in words ("Said", "Task", "Asks you", "Used away from home"…, the raw type on hover), with its Leg and its job; three filters (every job / a job, every Leg / a Leg, every kind / jobs, tasks, Leg output, Legs, inbox, approvals and rules, The Eye, the helper, projects and repos, servers and terminal, devices and the lock, Oraknid itself); a Leg's output (what it said, thought or ran) is its first line, cut at 140 characters, and opens to all of it. A project's Activity tab names its lines the same way. |
| **Health** | (2026-10-04, [[ADR-050-Parallel-By-Default]]) The computer: all good, needs a look, or in danger; tasks running at once of the most allowed (decided by this computer, or my limit); memory, CPU and swap now; anything wrong (memory and swap, a full disk, the OOM killer, heat, a session running away) with what Oraknid did; the tasks paused to make room. While in danger a red banner says the same on every page. |
| **Problems** | Errors, drift events, kills, escalations, blocked jobs. Each links to the evidence. |
| **Resources** | Per Leg and per process: CPU, RAM, GPU and VRAM (local models), disk I/O, network. Sparklines, with the full chart a click away. As built (2026-10-07, `overview-resources.tsx`): the computer (CPU, memory, disk I/O, network, each GPU with its VRAM), then the processes grouped per Leg (each session's process tree under its Leg, local models together, Oraknid's own last), each group's sum and each process's CPU, RAM, VRAM and disk read and written. Network is measured for the whole computer, not per process (said under the list). A sparkline, or a process's CPU or RAM, opens its full chart in a dialog, over 5 minutes, 15 minutes or an hour (what the daemon keeps), live. |
| **Running now** | (2026-10-03, [[ADR-034-Projects-First]]) Every job going, waiting, paused or queued, across projects: its name and description (2026-10-04), its project, its progress, a queued mark, and Pause or Resume on its row. A job opens in its project's Work tab. `/jobs` comes here. |
| **Totals** | Tokens today, by Leg. Jobs running and queued (the tile goes to Running now). Inbox count. |
| **The last two weeks** | (2026-10-03) The charts across every project (Charts, below): tasks done per day, success and failure by Leg and by task kind, the Legs compared, cost once money is counted. |

### Job

There is no job page ([[ADR-034-Projects-First]], 2026-10-03): a job
is opened in its project's Work tab (below), with everything the job
page had. `/jobs/<id>` and `/jobs/<id>/<tab>` (from notifications, push,
old links) open the job's project at Work with that job open, its old
Eye tab at the project's Eye tab; a draft opens on New work.

**Its header** (2026-10-04, [[Jobs-and-Projects]] → A job's name and
description): the job's name with a pencil to rename it (a dialog: name
and description, either kept as mine from then on), its description
(what it's for, then what it did; "The Eye names and describes it as
soon as a model can" until then), its state, branch and tokens, and
**What I asked**: my goal as I wrote it, folded until I open it.

- **The Web**, an animated graph that updates live. Nodes are tasks,
  coloured by state, showing the Leg's avatar while assigned. When a
  task moves from one Leg to another, a handoff animation travels along
  the edge. A running node pulses. Clicking a node opens the task drawer.
  As built (2026-10-03): a Leg's avatar is its initials on a colour
  from its name and kind (each kind a family of hues), the same on its
  tasks, Legs, Overview's Legs now and a job's Agents. A task shows it
  while assigned, running, verifying and once done. When a task's Leg
  changes (a reassignment, a step-up to another Leg, a fallback), the
  task shows both avatars for six seconds with a dot travelling from
  the first to the second, on the node rather than along an edge; under
  reduced motion the dot is left out and an arrow stays between them.
- **Task drawer:** instructions, scope, verify commands and their latest
  output, attempts and sessions, escalation history, checkpoints (with
  rollback), the diff, and the routing reason.
- **A job opened** (`/projects/<p>/work/<job>/<part>`): a header with its
  title, state, branch, tokens and controls, then its own tabs: Tasks
  (its Web, the task drawer, add a task, order, the plan beside its
  shadow) · Result (once completed) · Agents · Activity · Silk · Inbox
  (this job) · Budget & stats · Settings. Back goes to the Work list.
- **Controls** always visible: Pause / Resume, Cancel, Redirect, priority,
  autonomy level (Auto, Careful, Full; [[ADR-053-Auto-Mode]]); Edit plan
  in Tasks. New work's Autonomy says in a line what each level asks of
  me; the job's Settings tab marks each gate "never automatic: asks
  unless waived" (send, spend, publish) or "the judge decides at Auto".
- **Agents**: every session of the job (Legs and The Eye's reasoning),
  live or finished; opening one shows its whole output as a terminal-like
  log: text, tool calls with their commands and results, permission
  decisions with their layer and reason ("allowed: … (rules: git only
  reads)", "refused: … (judge: [Crossing a trust boundary] …)", "refused
  by the Leg's auto mode: …"), usage. It follows along while a session runs. The task
  drawer shows the task's own sessions the same way.
- **Result**: once the job is completed, where the work is (folder,
  branch, commits), Open (on this computer) and Merge into the work
  branch, with a confirmation; conflicting files are listed.
- **Plan editor:** drag to reorder dependencies, edit task text, add and
  remove tasks. Running tasks are paused before an edit is applied.

A finished job's **result** (the folder, branch, commits, Merge) also
has **Remove worktree** (its folder goes, its branch stays; work not
merged or not committed is said and asked again) and **Export** (the
job as a zip, [[ADR-061-Moving-Oraknid]]), 2026-10-07. A project's page
has **Export** (every job of it) and, for a project with GitHub-linked
repos, **Clone again** (a folder missing on this computer, after a
move).

### Charts (job, project and global level)

Token usage over time (stacked by Leg), cost (when any), task
throughput, success and failure rates by Leg and task kind, Leg
performance comparison (success, tokens per verified task, time per
task), budget burn against limits.

As built (2026-10-03, `stats.charts`):
- **Where**: Overview, under Tokens today, "The last two weeks" (by
  day, every project); a project's Budget & stats (by day, attempts of
  the last 30 days, burn against the project's token limit over its
  whole life); a job's Budget & stats in Work (by hour, burn against
  the job's token limit).
- **Budget burn**: the tokens used so far as a step line, the limit a
  dashed line (red for a hard limit, amber for an alarm), the share
  used in the legend; "No token limit is set." without one. Not on
  Overview, which has no budget.
- **Cost**: only once a Leg counts money; none does yet.
- **Tasks done**: tasks verified and attempts failed per day or hour,
  stacked, every bucket between the first and the last.
- **Success and failure by Leg** (with its avatar) **and by task
  kind**: a bar per row split into verified, failed, and handed on or
  stopped, the share verified said beside it.
- **Legs compared**: per Leg its success, tokens per verified task and
  time per verified task (every token and minute of its attempts,
  failed and handed-on ones included, over the tasks it verified).
- Each chart says "Nothing yet." when empty. Legends are lists under
  the chart, one entry per line on a phone, so nothing runs off its
  edge; two charts side by side from 1024 px.

### Projects

A list with totals, and the project open beside it: **the place I
work** ([[ADR-034-Projects-First]], 2026-10-03). Each card in the list
has a **…** menu (Archive or Unarchive, Delete); archived projects are
in their own **Archived projects** section at the bottom, closed until
I open it or one of them is open (2026-10-04). The project's header has
an "Archived" mark when it is, and the same **…** menu after New work.
Its page is in tabs, in the address (`/projects/<id>/<tab>`):

- **The Eye**: the project's one conversation with The Eye, filling the
  page, read like a terminal's transcript (M13.25, 2026-10-04): one
  column at full width, message after message, no bubbles. My prompts
  are marked with a "›" and a left rule, slightly emphasised; The Eye's
  replies are markdown under them, what it did in a muted monospace
  line; its thinking (The-Eye → Thinking out loud) is a monospace row,
  live while it runs (a spinner, "Planning the work…", its time and
  model, what it writes in a short box that follows it) and folded to
  one line once it ends ("Planned 9 tasks in 41 s · Claude · Opus —
  show"); three or more quick judgements in a row (commands judged) are
  one line, opened on demand; the agents working now are a line each at
  the end (task, last tool or line, model, time). Beside it, a slim rail
  of my prompts, a dot and their first words each, the one being read
  lit (IntersectionObserver); a click scrolls to it. On a phone the rail
  is a "N prompts" button opening the same list in a sheet. While The
  Eye thinks, a bar over the composer says what it is doing, with
  **Stop**; with text written it offers **Stop and redo with this** or
  **Add as context**, the one my words suggest chosen, and Enter sends
  that way; the composer stays usable. I ask for work here; The Eye passes it to the job
  running, starts a follow-up when the last has ended, or a first job
  ([[The-Eye]] → Talking to The Eye). Each reply links the job it
  touched (and the follow-up it started); a request The Eye took to a
  server's chat or another project (The-Eye → Resolving what it doesn't
  know) links that chat ("spinet-staging's chat") and the job started
  there. While a job of the conversation hasn't ended, the header has
  **Cancel** (2026-10-07): "Cancel “<title>”? The work so far stays in
  its folder.", Keep it focused; with several going, a small menu lists
  them (title and state) to pick which. A question a job asked through
  the inbox shows "No longer asked: the job has ended." once it ended,
  without its form. A line marks where the
  conversation moves to another job. The header says which job it talks
  to now. A reply with questions shows them under it (Questions, below)
  until I answer; my answers show as a short list. What The Eye says on
  its own ([[ADR-045-The-Eye-Speaks-Up]]) shows as such: a task done is
  one compact muted line with a check mark (its commit at its end, on a
  wide screen); the job done is a card (a green edge, "Job done") with
  its summary, its facts (branch and commits, merged into, pushed, a
  link to GitHub), **Left to you** and **Open the result**; blocked,
  waiting, a denial, a task left out, a stop and a folder put back are
  short notes with an edge and a word saying which. A waiting note's
  question is answered under it like any.
- **Workflow** (the project's Web, named so in the UI, 2026-10-03,
  [[ADR-034-Projects-First]] → Changed): only the diagram, filling the
  tab, its controls floating over it (Compact / Expanded at the top
  left, zoom and fit at the bottom right); pinch and drag on a phone.
  **Compact**, the default: a box per job in the order they ran (name,
  a line of its description, state, tasks done; the description in full
  on hover), the job the project is about now highlighted.
  Selecting a box goes inside it, `/projects/<id>/workflow/<job>`: that
  job's own tasks, with **All jobs** to come back and "Open in Work".
  **Expanded**: every job's tasks drawn in full, each inside a frame
  named by its job (a click on the name goes inside it), one after
  another, left to right on a computer, top to bottom on a phone. The
  choice is kept per project on the device. A task opens its drawer.
  `/projects/<id>/web` (the old address) opens Workflow. A ready task
  that waits says why on its box (2026-10-04, [[ADR-050-Parallel-By-Default]]:
  "waiting for memory: …", "Claude busy with 3 sessions", "overlaps
  “X”: both change src/auth"), and the job's header, here and in Work,
  says "4 tasks running at once · 2 waiting: …".
- **Work**: the jobs as a timeline, newest first: name and description
  (two lines at most), state, progress, branch, tokens, a queued mark,
  Pause or Resume. Opening one
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
  by Leg, then the charts (Charts, below: budget burn, tasks done,
  success and failure by Leg and by task kind, the Legs compared).
- **Repo** (after Work; [[ADR-038-Project-Accounts]] → Changed): what
  is on the linked GitHub repo (owner/name, who can see it, the account,
  its last push; the latest commits on its default branch, its branches,
  its open pull requests, each opening in Repos), **Browse the code** and
  **Open on GitHub**; below, the link itself: Change and Unlink (a second
  step), or "Link a repo" (account, a new or an existing repository,
  owner, name, who can see it). A repo still to be created says so.
  Under them, **Its repo**: the project's one repo, its folder and
  branches, **Add a repo** and **Find repos in its folder**. A project of
  several repos ([[ADR-042-Several-Repos-And-Servers]]) shows **Its
  repos** first (each repo's name, folder, release / work branches and
  GitHub repo or "not on GitHub yet", a pencil to rename it or change
  its release and work branches in a dialog, and an ✕ to take it out,
  with a confirmation), then a section per repo with what's on its GitHub repo
  and its own link card ("GitHub repo of api"). Add a repo is a dialog:
  where from (a folder of the project that is a repo, a new empty repo,
  a clone of my GitHub repo or of a git URL), the folder, its name.
- **Settings**: its **servers**, each ticked one with its role (a word,
  suggestions testing, staging, production, saved when I leave the
  field, as wide as its word; on a phone under the name) and a
  **Production** mark, "live" beside a production server;
  then its repos (the same card), the folder and branches (each repo's
  for several), **Archive…** / **Unarchive…** and **Delete…**, and
  the project's command rules.
- **Archive and delete dialogs** (2026-10-04, [[Jobs-and-Projects]] →
  Archiving and deleting a project; `components/project-removal.tsx`):
  each lists what it would do as checkboxes, read when it opens. Delete
  says it can't be undone; "Always: Oraknid's records" is fixed; **Delete
  the project folder from this computer** shows the path and size and,
  ticked, what would be lost; **Delete the GitHub repo owner/name**, one
  per linked repo, disabled with its reason when the account doesn't own
  it, warning when the token lacks `delete_repo`. A folder or a repo
  ticked asks me to type the project's name (or the one repo's full
  name); **Delete** stays disabled until it matches, and while a job runs
  until I tick **Cancel its running jobs first**. Archive has **Archive
  the GitHub repo** per linked repo and **Delete the project folder from
  this computer to free space**, disabled with each reason when
  something isn't pushed or committed. Unarchive says the folder comes
  back from GitHub when archiving deleted it (and which repo it is
  cloning) and offers to unarchive the repos it archived. After, the
  dialog lists each step with a mark: done, not done (with why), skipped.
- In the projects list, a project of several repos says how many; New
  project (below) says how many repos it found, and their names. A job's Result
  lists each repo's branch, merged or not, and its commits; Merge
  merges each. `/servers?add=1` opens Servers' add dialog (The Eye's link
  when it waits for a new server).
- **Skills**, **Servers**, **Network** (the ports on this computer its
  jobs may reach, like a local database; [[Sandboxing]]).
- **Secrets** (2026-10-07, [[ADR-059-Project-Secrets]]): the project's API
  keys and `.env` values for one environment at a time (`dev`, `testing`,
  `production`, chosen at the top), and which one new jobs run in. Each
  is a row: its name, `••••••••`, when it was set, **Replace** (a
  password box, empty: the old value is never shown) and **Remove**
  (asked first). **Add** takes a name (upper case, an environment
  variable's) and a value; a pasted `.env` sets many at once and says
  the lines it skipped, by number, never by value. Changing them away
  from home needs a device with full rights.

**Open folder** and **Terminal here** in its header (2026-10-04): the
project's folder in this computer's file manager, to look at or test the
work by hand (away from home, its path is copied instead), and a terminal
on this computer started in that folder (`/terminal/project:<id>`: the
terminal takes the project's id, never a path, ADR-028). **New work** in its header opens its Eye tab. Its Servers tab adds a
server or sets one up in place, its Skills tab shows which tools a
skill still needs. With a job open, the list of projects steps aside
below 1280 px.

### New work

Options on the left, my prompt and the conversation with The Eye on
the right ([[Jobs-and-Projects]] → Starting work). It is for a first
request, a new project or a draft; more work in a project is asked in
its Eye tab. "A new project…" shows New project's form (below), the
same name, choices and sentence; a folder I have that isn't a repo is
made one there. A new project from a new GitHub repo is made on the GitHub
account I pick (the default first). The drafts are listed above the form. The draft is saved as
I go; **Start** and **Delete**. **Start** stays disabled until there is
a goal and a project, and says why; what it waits for that can be set
up (a Leg, a tool) is offered beside it. Its budget starts as the
chosen project's. Once started, it lands in the project's Eye tab.
When the sandbox doesn't work on this computer (2026-10-07,
[[ADR-006-Sandbox]]) a red note says so with why and that `oraknid
doctor` says how to fix it; a draft then has the switch **Run this job
without the sandbox (asks first)**, and Start asks "Run this job without
the sandbox?" (its agents get my rights on this computer; recorded,
shown in red). Without the switch Start is refused in words.

### New project (2026-10-04, M13.19)

A dialog from Projects (and the form of New work's "A new project…";
[[Jobs-and-Projects]] → Making a project). **Name** first; then **Where
it comes from**, three cards, each with its line: **New** (chosen;
"A new folder, made a git repo"), **A folder on this computer** ("One
you have: a repo, or a folder of several"), **From GitHub** ("One of
your repos, or a link"). Each shows its own fields:

- New: **Where it goes** (a folder, with the picker), **Folder name**
  (the name slugified until I type one), and with GitHub connected
  **Also a new GitHub repo** (the account when I have several,
  **Private** on); without, a line and **Connect GitHub**.
- A folder on this computer: **The project's folder**, with the picker;
  a folder that isn't a repo asks how to keep its checkpoints, as
  before.
- From GitHub: with an account, **One of my repos** (a searchable list
  of every account's, or one's, each with the project it already is
  and a lock when private) or **A link**; without one, only the link,
  saying only a public repo can be cloned, with **Connect GitHub**.
  Then **Clone it into**, with the picker.

Under them, the sentence saying what will happen, with the real paths,
or what is still missing; **Create project** waits for it. The parent
folder last used is offered again (New work's too). Once made, the
project opens.

### The folder picker (2026-10-04, M13.19)

Wherever the app asks for a folder on this computer (New project, New
work's new project, a backup plan kept on this computer), the field has
**Choose…** beside it. A browser can't give a folder's full path, and
from a phone the folder is on the computer, so the daemon lists them
(`files.folders`, [[API-Contract]]): a dialog with breadcrumbs (each a
way back), **Up**, **Home**, **New folder** (an empty one, made where I
am, then opened), **Show hidden**, the folders of the one I'm in (a
repo marked **git**, a link marked, one Oraknid may not open shown with
a lock and not opened) and **Or type a path** (a full path or `~/…`,
**Go**). The footer says the folder I'm in, and **Choose this folder**
picks it. It opens where the field's path is, or at my home, saying
why, when that isn't there. It lists folders only, never a file. The
field stays typeable. Away from home it needs full rights, like making
a project.

### Repos (2026-10-03, [[ADR-040-Repos-Page]])

My GitHub repositories at `/repos`, in the sidebar and the phone's
More, `g r`. Read through GitHub's API by the daemon with an account's
token (never sent to the browser), kept a minute; nothing is cloned to
browse.

- **The list** on the left: the repositories of every account (each
  listed once) or of one, newest push first, a search (name,
  description, project) and a visibility filter. Each row: owner/name,
  public or private, its description, default branch, last push, the
  account that reads it, and the project linking it. An account GitHub
  can't read is named above the list with why. **New repository**
  (account, name, description, private by default; with a README) opens
  it once made; not away from home.
- **Accounts**: with no repository open, the right side holds the same
  GitHub card as Settings (add, check, remove) and each account's hourly
  allowance in words ("4,983 of 5,000 requests left this hour; full
  again at 08:51, in 30 minutes"); on a phone, **Accounts** above the
  list opens them in a dialog.
- **A repository** (`/repos/<owner>/<name>/<tab>/…`), with Open on
  GitHub in its header, in tabs in the address:
  - **Code** (`/code/<branch>/tree|blob/<path>`): a branch picker, the
    path as links, the folder (folders first, sizes), and on the root
    its README rendered as Markdown. A file shows with line numbers and
    syntax colouring (highlight.js, loaded when a file opens), scrolling
    inside its block; a binary file or one over 512 KB says so, with
    GitHub a click away. An empty repository says nothing is pushed yet.
  - **Commits** (`/commits/<branch>/<sha>`): a branch's history, 30 at a
    time with Older commits; a commit with its message, author, date and
    its diff.
  - **Branches**: each with default and protected marked, its code and
    its commits a click away.
  - **Pull requests** (`/pulls/open|closed/<number>`): open or closed
    (merged said), one with its description (Markdown), its commits and
    its diff.
  - **Project**: the project linking it (Open the project, New work on
    it, which opens its Eye tab; change or unlink in its Settings), or
    Link to a project (an existing repository through the account that
    reads it; a project linked elsewhere asks first) and New work on it,
    which opens New work with the repository to clone through its
    account.
- **Diffs**: per file, folded with a click, its status and +/− counts,
  then the unified diff in a block that scrolls inside itself, old and
  new line numbers, added lines green with +, removed red with −, a
  binary file said in words. More than 25 files: each opened on demand.
- **On a phone**: the list fills the screen, a repository opens full
  screen with a way back; code and diffs scroll inside their block, the
  page never sideways.
- **GitLab, Gitea and Forgejo** (2026-10-07, [[ADR-062-Git-Hosts]]):
  their accounts in a card under GitHub's (here and in Settings →
  Connections: kind, address, token, the steps to make one for each;
  add, check, remove; not away from home). Their repositories are in the
  same list, a badge naming the host, and the account filter lists
  `login · host` too; New repository may be made on one. A repository
  there is at `/repos/<host>!<owner>/<name>/…` (a GitLab group's
  subgroups in the owner), with its host named in the header, Open on
  `<host>`, and Merge requests for Pull requests on GitLab; linking it to
  a project and New work on it go through its host. New work's repo
  picker lists every host's, the host named on each.

### Chats

My chats with any Leg and model, like a chat app ([[Chats-and-Helper]]).

### Servers

My servers ([[Servers]]): each with its state, its state document,
oraknid-monitor's readings live and over 24 hours, services and ports;
add, discover again, edit the document, edit its name and description,
open a terminal, remove. A server's page is in tabs
([[ADR-043-Server-Insight]]): **Overview** (the readings, then what was
About, with a **Production** switch: every job that reaches it asks
before any change), **Chat** (2026-10-04, [[ADR-049-Server-Chat-And-Server-Jobs]]:
The Eye's conversation about the server, the same chat as a project's
The Eye tab; a question answered without a job, work sent into the
server as a job, each reply linking the job it started; **Cancel** in
its header while a server job hasn't ended), **Jobs** (the
jobs that worked on the server as Work rows, newest first, opened in the
server's project's Work tab, and above them what they wait on from me),
**Docker** (containers by compose project, each with Logs and
Restart; images, volumes and networks folded), **Databases**, **Proxy &
traffic** (sites, certificates, the config check, then the last 15
minutes of traffic as bars, status tiles and top lists), **Logs** (a log
picked from the server's services, containers and proxy files; Follow on
by default, a filter while following, a search on the server when not),
**Backups** (`ServerBackupsTab`, [[ADR-044-Backups]]: its backup plans
and those keeping their backups on it, each with its backups, and New
backup plan with the databases found on it to pick from, or one
described), **Terminal** (one shell, opened with a click) and **State
document** (its versions to pick from, each "after “<job>”" when a job's
end wrote it). A server marked production, on its page or in a project,
has a red **production** badge in its header. Each part shows when it was read and a Refresh; what it
couldn't read is in a yellow box with why. On a phone everything is a
list that wraps, nothing scrolls sideways.

A server not reached for a while ([[ADR-026-Servers]]) keeps its last
document and readings, with a **stale since …** badge in its header and a
yellow dot in the list (2026-10-07).

**Sites** (2026-10-07, [[ADR-060-Sites-Domains-And-Uptime]]), first in
the Servers list (`/servers/sites`): every domain across my servers, a
row each: up, down (since when) or not checked; its server and proxy, or
"added by hand"; the last check (status, latency, or the error in
words) and its uptime over 24 hours and 7 days, with the last day's
latency as a sparkline; the certificate's end (red under two weeks, or
ended) and issuer; DNS (its addresses, a CNAME, whether it points at
its server). **Find sites** reads my servers' proxies; a domain or a URL
can be added by hand; each row has Check now, Remove (asked first), a
switch to stop checking it and how often (1 to 60 minutes). It reads
again every minute while in sight.

### Cloud storage (2026-10-03, [[ADR-046-Cloud-Storage]])

`/storage` in the sidebar (More on a phone), `g y`. Without rclone, it
says how to install it. Otherwise the pool, with **Providers** and
**Where uploads go** beside it (below it on a phone):

- **The pool**: breadcrumbs (the folder is in the address,
  `/storage/<path>`), a search (file names, every provider, under the
  folder open), **Upload** (several files; or dropped on the list) with
  where they go (the rule, or a provider for these), **New folder**
  (opens an empty folder, kept once a file goes in), and the list:
  folders first, merged across providers (each shows those holding
  it), then files, each with its provider, size and date; a row's `…`
  has Download, Rename or move (path, and provider for a file), Delete
  (a second step naming the provider, or every provider for a folder).
  Each upload shows its progress, to Oraknid (the browser's) then to the
  provider (`transfer` frames on `storage`), then where it went, or why
  it failed in words; a name taken asks to replace. Away from home,
  uploads and downloads are off, said in a line.
- **Providers**: each with its kind, what it is (preset, bucket and
  endpoint, account, folder), used and free space as a bar, when it was
  checked, its error; Check, Edit (name; a space limit or pay as you go
  for object storage and any provider that can't say its free space),
  Remove (a second step: its files stay in the account). **Add a
  provider**: a dialog with five tiles; S3 (service, endpoint, region,
  bucket, keys, space; a link to rclone's full S3 form), Google Drive
  and Dropbox (**Sign in** gives rclone's sign-in page to open on this
  computer, then Add; away from home it says to do it there), MEGA
  (e-mail, password); each with the folder the pool shows.
  **Another provider** (2026-10-04) lists rclone's own backends (its
  `config providers`: 55 with rclone v1.75.1, not the wrappers, this
  computer or the read-only ones) with a search by name or another
  name, a badge for those that sign in through a browser and those
  that keep buckets; Google Drive, Dropbox and MEGA found there open
  their short forms. A picked one gets a form made of rclone's
  description of it: Name; the service first when it has several (S3's
  53, Koofr's, Storj's), its other options shown only once one is
  picked; the options it needs (marked *), its everyday ones, the rest
  under **Advanced (n)**, closed; each typed (a switch, a choice, a
  number, a size, a duration, a text with suggestions), its first line
  of help as the label and the rest as the hint; passwords, keys and
  tokens as password fields (a PEM key as a text area). One that signs
  in through a browser has **Sign in** as Drive does, and Add only once
  signed in; a bucket-keeping one asks the bucket and folder, and its
  space limit. After Add, rclone's own questions, if any (OneDrive's
  type of connection and drive, a two-factor code), come one at a time
  with **Continue** and **Cancel**, and what was wrong with an answer.
- **Where uploads go**: Automatic by a rule (most free space, my
  priority order with up and down arrows, by size with "large from") or
  always one provider.

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
from the server (off by default). Not from away.

**Sign-in with Google and Microsoft** (2026-10-07, [[ADR-063-Mail-OAuth]]):
a card under Email accounts holds the app I registered with each, the
steps to register it, the redirect to give it (with Copy), its client ID
and, for Google, its client secret (never shown back: "Kept; type to
replace it"), each said ready or not set up. Once one is ready, **Sign
in with Google** or **with Microsoft** is above the add form (here and
in Mail's Add an account): Google's page opens in a new tab and comes
back to Oraknid; Microsoft's shows a code to type on its page, with the
link, while Oraknid waits. An account signed in this way is marked so,
and its Reconnect signs in again instead of asking a password.

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
shows me something and comes back with a tap on its button. A control in
a dialog: the panel steps aside on any screen, the ring's note says to
close the dialog, and the panel comes back once it is closed. What it
couldn't show is said to me and told to the helper, whose next reply
knows.

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
Submit for a round; an old round asked in prose shows as before. An
approval's buttons each carry the line saying what that answer leads to
(ADR-045), side by side on a wide screen and one under the other on a
phone; a question that only explains an item's own options shows them
in the component, not again as buttons beside Submit. An agent stuck on
blocks (ADR-053) is an approval listing each blocked action and its
reason, answered "Let it run this one" or "Keep it blocked". Each item names its
project and job (the job's description on hover, 2026-10-04). Filters: project, job, kind, state, and a search over
the text. As built (2026-10-07): State is Open (the default), Answered,
Withdrawn, Expired or every state; with Open, "Show answered (n)"
under the list goes to every state; the item I came to see stays shown
whatever the filters.

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
values next to my overrides. Add Leg offers **Oraknid's own agent**: an
endpoint, its models (empty: all it lists) and a key
([[ADR-052-A-Harness-For-Any-Model]] §6).

### Models (2026-10-07, [[ADR-054-Local-Models]])

`/models` in the sidebar after Legs (More on a phone), `g e`. Two
columns, one on a phone:
- **On this computer**: each model with its kinds, runner, quantisation,
  size, state and roles; a download's progress bar with Pause or Resume
  download; a loaded model's measured speed, VRAM, memory, context and
  GPU layers; Load, Unload, Settings (keep loaded, idle minutes, context
  and GPU layers, automatic when empty) and Remove (asked first; a model
  in Ollama stays in Ollama).
- **Find a model**: a search, where (everywhere, Hugging Face, Ollama's
  library), the kind, and **Fits this computer** (on by default). Each
  result shows its kinds, licence and downloads, and each file its
  quantisation, size and fit (fits the GPU, GPU and memory, CPU slow, too
  big, with the reason as a tooltip); **Download** shows the licence,
  size and fit before it starts, and is off for one that doesn't fit.
- **This computer**: each GPU's memory, free memory, what the models
  take, free disk (red under the floor), and whether llama-server, Ollama
  and whisper.cpp are found, with `install.sh --local-models` when
  llama-server isn't.
- **Roles**: one choice per role among the models of its kind,
  *Suggested* by default, and what each role is for.

The page follows `model.*` events (progress, state, roles).

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
  storage use and pruning, notifications, theme. Storage also lists
  **Finished jobs' worktrees** with their sizes, what each would lose
  (commits not merged, files not committed), a remove button each (it
  asks, and says what is lost) and **Clean up finished jobs' worktrees**
  (the ones with nothing to lose; the others named), and **Import a job
  or project zip** (2026-10-07, [[Sandboxing]] → Worktrees,
  [[ADR-061-Moving-Oraknid]]).
- **Eye & jobs**: The Eye's models and the interview's rounds; **Jobs at
  once** (jobs at once, tasks at once in a job, and **Claude share of a
  job**, 2026-10-07, [[ADR-052-A-Harness-For-Any-Model]] §3: Claude as
  needed, only when nothing else can, or at most 25, 50 or 75% of a
  job's attempts); same-provider fallback;
  and **Work at once** (2026-10-04, [[ADR-050-Parallel-By-Default]]): tasks
  at once across all jobs (Automatic, what this computer takes, or a
  number), heavy tasks at once, the memory to keep free, the CPU above
  which no new task starts, the disk to keep free, and "Pause work when
  the computer is busy with my own things".
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
- **Backups** ([[ADR-044-Backups]]): every backup plan (what, when,
  where to: this computer, another server, or cloud storage, the pool
  or one provider, [[ADR-046-Cloud-Storage]]; how many kept, its key, its last run and error; Run now, a
  switch to pause, edit, remove), the latest backups (size, duration,
  checksum, where; Download, as stored or decrypted with its key, on
  this computer; Verify; Restore in two steps, the database's name
  typed back), and the encryption keys (public halves; Make a key shows
  the private one once to download or copy; Import a key).
- **The plan's form** (2026-10-04, [[ADR-044-Backups]] → Changed): one
  form per plan (keyed by its id), opened with every value it was saved
  with, the password and a MongoDB connection string as "kept; type to
  change"; pausing stays the plan's switch, never the form's. A database
  picked from those found fills in its kind, container or port, and the
  user and database its container's environment gives, with "a password
  is set in the container's environment" instead of any password.
  **Advanced: <kind>'s own fields** folds each kind's fields (PostgreSQL
  sslmode, dump format, schemas, more pg_dump options checked against
  the daemon's list; MySQL/MariaDB TLS and four switches; MongoDB
  authentication database, replica set, TLS, read preference, a
  connection string instead of the fields; Redis database number and
  TLS, the user labelled as Redis's ACL user). **Test connection**
  beside Save sends the form as it is (`backups.testPlan`, the plan's id
  for its kept secrets) and lists Server, Database and Where to, each
  ✓, ✗ or not tried with its words; a database it lists is one click
  away. At 390 px every field is one column, nothing scrolls sideways.
- **About & updates → Moving** (2026-10-07, [[ADR-061-Moving-Oraknid]]):
  **Move to another computer**: a passphrase typed twice (12 characters
  or more) and **Export everything** (a one-time download of the
  encrypted archive, with what it holds); on a fresh install, an archive
  and its passphrase and **Import** (its secrets and settings now; "Restart
  Oraknid to finish", and how many projects' folders aren't here).
  Otherwise it says importing is for a fresh install, or `oraknid import
  --replace`.
- **About & updates** (2026-10-04, [[ADR-048-Updates]]): the version
  running, its channel (dev or stable) and how it was installed
  (install.sh, from which ref, into which folder; or "running from a
  clone at <path>: update it with git", with no Update now), when it
  last looked, **Check now**, a sentence when GitHub couldn't be
  reached, the notes of every newer release on the channel (the newest
  open, each with its link to GitHub), on the dev channel **New work on
  dev (N commits)** with the newest of them, and **Update now** after a
  confirm that says what happens (the database copied first; fetched,
  built, restarted; my data kept; how many jobs run, and that they pause
  and go on after the restart). Then the update's progress, its log as
  it is written, "Oraknid is restarting…" while the daemon doesn't
  answer, and the end: "Updated to v0.2.0" with **Reload the page**, or
  that it failed and went back to the version before. Any other page
  left open learns of the new build when it reconnects or is shown
  again: out of sight it reloads, in front of me it says "Oraknid was
  updated" with **Reload**. Away from home,
  Update now needs a device with full rights; the button says why it is
  greyed out.

The sidebar's foot shows the version and, at a glance, whether there is
an update ("0.1.0 · Up to date", "0.1.0 · Update available: v0.2.0",
"Updating…"; folded, a dot), opening About & updates; the Overview has
a line under its title while an update waits ([[ADR-048-Updates]]).

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
