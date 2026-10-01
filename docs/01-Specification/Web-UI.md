# Web UI

**Is:** the one place I watch and steer everything. It's simple to use
and packed with features, with nothing hidden in deep menus. Live
everywhere, usable on a phone.
**Is not:** a chat app. Conversation with Legs is limited to answering
their questions and redirecting The Eye.

## Look

- A dense "mission control" style: dark first, with a light theme and
  a system-follow option. Built with shadcn/ui and Tailwind.
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
- **On mobile:** the sidebar becomes a bottom tab bar (Overview, Jobs,
  Inbox, Legs, More). Every control is reachable within two taps, and
  touch targets are at least 44 px.

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
- **Tabs:** Activity · Silk · Inbox (this job) · Budget · Stats · Settings.
- **Controls** always visible: Pause / Resume, Cancel, Redirect, Edit plan,
  autonomy level.
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
workspace and its Silk mirror.

### New job

One form ([[Jobs-and-Projects]]): goal, inputs (drop files or folders),
skill picker with preview, Legs (checkboxes with live health), budget,
autonomy level. **Start** stays disabled until the goal is filled in,
and says why.

### Inbox

Approvals and questions from all jobs. Each item can be answered in
place. Interview rounds appear as a short form. Filters: job, kind,
waiting time.

### Legs

The registry: health, kind, model, quota, observed performance. **Add
Leg** with a live test. The capability profile editor shows learned
values next to my overrides.

### Skills

The library: view (rendered markdown), upload, edit with preview,
versions.

### Logs

The audit trail and the daemon's logs: search, filters, export.

### Settings

The Eye Leg, notifications, the allow/deny list, default budgets and
thresholds, drift thresholds, devices and pairing, theme, storage use
and pruning, keychain status, sleep inhibition status.

## Empty, loading and error states

- No Legs yet → the Overview shows a single "Add your first Leg" card
  that explains what a Leg is.
- No jobs → "Start a job". If no Leg is healthy, it says why the button
  is disabled.
- Every error says what happened and what I can do. No error is shown
  only as a code (BR-17).

Related: [[Jobs-and-Projects]] · [[Realtime-Transport]] · [[Notifications]] · [[ADR-005-Charts-and-Graph-Visualization]]
