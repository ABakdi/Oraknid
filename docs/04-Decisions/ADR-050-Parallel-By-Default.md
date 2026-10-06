# ADR-050 — Parallel by default, admitted by resources

**Status:** Accepted · 2026-10-04 · [[Phase-13-Projects-First]] (M13.26) · extends [[ADR-016-Parallel-Work]]

## Context
ADR-016 made tasks side by side possible but left them off: a job ran
one task at a time unless I raised a setting, two jobs ran at once, and
a Leg ran one session. So a plan with four independent tasks took four
times as long as it had to, while a Claude Max account could have run
them together. I want parallel work to be the default: "whenever there
are tasks that can be done in parallel, multiple agents work on them at
the same time".

The other half: more work at once can slow or crash the computer I work
on. The only resource rule (ADR-016 → Resources) held a session back
above 95% memory, read from memory alone. Nothing noticed swapping,
pressure, a full disk, the OOM killer, or one of Oraknid's sessions
running away, and nobody was told.

## Decision

### Parallel by default
- **Every ready task starts** whose dependencies are done and whose
  scope can't tightly overlap a running task's, up to a limit set by
  the machine, the Legs and me. There is no per-job limit unless I set
  one (`jobs.maxTasks`, now optional).
- **One place admits work for every job** (`Work`, in the daemon): it
  knows every task running across jobs, so jobs side by side (four by
  default, was two) share one budget of machine and Legs. When room is
  short, a waiting task of a job with a higher priority (or waiting
  longer) goes first.
- **The limit** is the smallest of:
  - **mine** (Settings → Work at once: *Automatic* or a number, across
    all jobs);
  - **the machine's** (automatic): three of every four cores, and half
    the memory at 0.6 GB a session, never more than twelve;
  - **the Legs'**: each Leg runs its own number of task sessions
    (default: 3 for Claude Code, a subscription runs several; 2 for
    OpenCode and Antigravity; 1 for a local model server). Admitted
    tasks not yet holding a session count against them. Routing
    spreads work: a Leg with sessions running scores a little lower,
    so a second account takes the next task. Quota rules are unchanged
    (scarce windows kept for hard tasks, a job's quota share).
- **Scopes: tight or loose.** Two tasks whose scopes name the same file,
  or the same folder two levels down or deeper (`src/auth/**`), are a
  *tight* overlap: one waits for the other ("overlaps “Write the login
  page”: both change src/auth"). Scopes that meet only through a broad
  glob (the whole repo, `src/**`, `**/*.ts`) are *loose*: they run side
  by side, each in its own worktree, and a conflict at the merge is
  redone on top of the newer work (ADR-016). A broad scope says little
  about what a task will change; serialising on it made every plan run
  one task at a time. The planner's scopes are used, not the wider
  scope drift control allows.
- **Worktrees**: a plan in which two tasks could ever run at once gives
  every task a worktree and a merge (ADR-016); a chain works in the
  job's own tree, one task after another, as before. A job never goes
  back from worktrees to its own tree (a redone task's base lives in
  its worktree's history).
- **Why a ready task waits** is shown on it, in words: "waiting for
  memory: 2.1 GB free, it may need 2.6 GB", "Claude busy with 3
  sessions", "overlaps “X”: both change src/auth", "heavy, like “Build
  the API”: heavy tasks run one at a time", "waiting for CPU: 92% busy",
  "waiting for disk space", "waiting for the computer to recover".

### Admission: before each task starts
Checked in order (`admit`, `@oraknid/core`): danger on the machine; my
cap; the Legs' sessions; disk (data folder and each running project,
2 GB free by default); **heavy beside heavy** (a task whose checks or
instructions build, install or run a whole suite, or whose class was
seen to take 1.5 GB or two cores, never runs beside another heavy one;
one at once by default); **memory** (after what the task may need, 15%
of memory must stay free; tasks started in the last 20 s have their
expected memory set aside, since readings don't show it yet); memory
pressure (PSI some avg10 ≥ 10%); **CPU** above 85% (ten-second
average) or load above twice the cores. With nothing of Oraknid's
running, one task may always start unless the machine is in danger,
out of disk, or would fall under 10% free memory, so work never stalls
on a computer busy with my own things — unless I turn on **"pause work
when the computer is busy with my own things"**.

A task's expected cost: a session is 0.6 GB; a heavy task 2 GB more.
Oraknid learns: each session's process tree is sampled with the
metrics (peak RSS and CPU), and when it ends its peak is folded into
its class (`kind:heavy|light`, a moving average in `work.costs`); after
two sessions the class's figure replaces the guess.

### The guard: while work runs
Every five seconds it reads the machine (the metrics loop's samples,
now with swap, swap-in rate, load, `/proc/pressure`, the OOM killer's
count from `/proc/vmstat`, thermal throttling where the kernel keeps a
count, zombies per session tree; disks every 30 s). It finds:
- **memory**: available under 10% while swapping or stalling (or under
  5%, or with no swap), said with CPU when both are nearly full;
- **swap thrashing**: 20 MB/s read back from swap, or memory stalled
  10% of the time;
- **overload**: load above four times the cores with memory short;
- **disk** nearly full (a warning; a danger under a quarter of the
  floor); **the OOM killer** having killed; **thermal throttling**;
- **a session running away**: memory doubled past 2 GB over two
  minutes and still growing, a fork bomb (400 processes, or 150 more
  in 30 s), a core pegged for five minutes with nothing said, 50
  zombies;
- with my switch on, **the computer busy with my own work**.

Each finding is an **incident**, open while it lasts and closed only
well clear of where it opened (hysteresis: memory closes above 15%,
swap below 2 MB/s, and only after 30 s without it). While a memory,
swap or overload incident is open nothing new starts, and every 20 s
Oraknid **pauses one task at a safe point**: the heaviest when it
clearly is, else the newest (its work kept on a checkpoint with a
handoff, like a Leg's pause); it starts again by itself once the
incident closes. A runaway session's task is paused and held back ten
minutes. Oraknid never touches my own processes.

### Telling me
One notice per incident, never repeated while it lasts: the event
`machine.danger` (desktop and phone by default, through quiet hours),
saying what is happening and what Oraknid did ("Memory is nearly full
(96% used, 0.6 GB left), and the computer is swapping. Paused “Build
the API” to free memory; it resumes when memory is back."); a red
banner on every page while in danger; a **Health** card on the
Overview (the state, tasks at once of the limit, the reading, what is
wrong, what was paused). Busy with my own work is shown, not sent.

## Consequences
- More worktrees and merges: a plan that can run side by side pays a
  merge and its checks again after it, even when the machine admits
  only one task at a time.
- Quota windows empty faster when several sessions run on one account;
  routing's scarce-window rule and a job's quota share still apply.
- A task can wait on resources with nothing running in its job; the
  job stays *running* and says why.
- The thresholds are settings (Settings → Work at once).

## As built (2026-10-04)
- `@oraknid/core` `admission.ts`: `readingOf`, `taskCost`/`learnCost`,
  `autoTasksAtOnce`, `defaultLegSessions`, `admit`, `assess`,
  `stepGuard`, `runaway`, `pickToPause`; `web.ts`: `scopeConflict`,
  `canRunSideBySide`; routing's `sessions` spread.
- Daemon `resources/work.ts` (admission for every job, waiting reasons
  as `task.waiting` events when what a task waits for changes, learned
  costs), `resources/guard.ts` (incidents `machine.incident` /
  `machine.health` / `machine.recovered`), `resources/disks.ts`;
  `runTasks` rewritten around them; `pauseForRoom` beside the Leg
  pause; the supervisor knows each session's task and last output.
- `packages/os` reads swap, `/proc/vmstat`, `/proc/loadavg`,
  `/proc/pressure/*`, the package throttle count and process states.
- API `machine.health`, `settings.resources` / `setResources`;
  `settings.maxTasksPerJob` nullable; `TaskView.waitingReason`.
- Web: the danger banner, the Overview's Health card, "4 tasks running
  at once · 2 waiting: …" in a job's header and its Workflow, the
  reason on each waiting task's box, Settings → Work at once.

Related: [[ADR-016-Parallel-Work]] · [[ADR-013-Model-Aware-Routing]] · [[Jobs-and-Projects]] · [[Notifications]] · [[Durability]]
