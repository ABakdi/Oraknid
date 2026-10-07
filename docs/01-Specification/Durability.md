# Durability

**Is:** Oraknid surviving everything a machine does: crashes, reboots,
power cuts, sleep, and me pressing pause. It never loses work and never
does anything twice.
**Is not:** backups of my workspace. My git repo is mine to back up.

## Background service

- The daemon runs as a **systemd user service** (`oraknid.service`),
  enabled at login, with lingering enabled so it starts at boot even
  before I log in ([[OS-Integration]]); where there is no systemd, an
  OpenRC or runit service running as me ([[ADR-036-One-Script-Install]]).
- `oraknid` CLI: alone, the terminal app ([[Terminal-App]]); `start`,
  `stop`, `status`, `logs`, `open` (opens the UI), `pair`, `pin`,
  `doctor` (checks the setup and says what is wrong), `install`
  (`--gui` adds the web UI), `uninstall`, `update` ([[ADR-048-Updates]]).
- **An update must start** (2026-10-07): after the install script, the
  new version has to load and, with the service, answer `oraknid status`
  within a minute; otherwise the update is rolled back to the version
  before, its database copy kept ([[ADR-048-Updates]]).
- Windows comes in the final phase, behind the same interfaces.

## Sleep inhibition

- While any job is active (BR-11), the daemon holds a logind inhibitor
  lock for `sleep` and `idle`. Shutdown isn't blocked.
- The lock is released within 60 s of the last job leaving an active
  state.
- The UI's header shows whether the inhibitor is held and why.
- If taking the lock fails, the job continues, the UI shows a warning,
  and I'm notified once.

## Crash and reboot recovery

On start, the daemon runs recovery before the API answers anyone:

1. Open the database (WAL) and run any pending migrations.
2. Steps the journal shows as unfinished are forgotten, so they run again.
3. Every session that was running is marked `crashed`. Its Leg processes
   are found by recorded PID and start time, and killed if still alive
   (a recovery hook, from M1.4).
4. For each task that was `running`:
   - The worktree state is compared with the last checkpoint. Changes
     since then are kept, recorded in a new checkpoint, and noted in a
     Silk handoff built from the event log.
   - The task returns to `ready` with that handoff.
5. Side effects caught in `performing` are reconciled (BR-6): the
   action's reconciler checks whether it happened (e.g. is the commit
   on the remote, is the email in Sent). If the check is impossible, an
   inbox question asks me and the job waits. Nothing is re-run blindly.
   Actions still `intended` or `approved` never started, so they simply
   continue.
6. Jobs return to the state they were in: active jobs restart their
   program, which replays completed steps from the journal. A paused job
   stays paused.
7. An event "Recovered after crash/reboot" lists what was found and
   done. I'm notified.

## Lossless pause and resume (BR-7)

**Pause** requests a safe point from every running session. A safe
point is a step boundary; the step in flight sees its abort signal:

1. Ask the Leg to finish its current turn. Up to 120 s by default. Past
   that, the UI is told the pause is overdue.
2. If it doesn't finish in time, interrupt. The partial work stays on
   disk. An external action cut short by the pause is marked for
   checking on resume, like after a crash.
3. Record a checkpoint and a handoff for each task.
4. The job becomes `paused`. The UI said "Pausing…" until this point.

**Resume** restarts each task from its handoff and checkpoint. The same
model taking it up again resumes its own native session where its Leg
can (its probe says so), told why it stopped; another model, a Leg that
can't resume, or work that was rolled back gets a fresh session from a
context pack (BR-2; until 2026-10-07 a native session was never resumed,
[[ADR-052-A-Harness-For-Any-Model]] §1).

Pausing never runs verification, never replans, and never touches
side effects.

After [[Audit-1]]: a pause, a restart or a crash never counts as a
failed attempt; the attempt cut short by a crash is closed as abandoned
at the next start, and the next attempt builds its handoff from that
session's log. A message to The Eye left without a reply is handled at
the next start. Shutdown stops every timer first and starts no new run.

**Kept across a restart** (2026-10-07, [[ADR-056-The-Harness]] stage 1):
each task's memory (`task.memory.<task>`): that it read untrusted content
(a resumed session isn't trusted again), what I let run once, what I
refused (asking again is a gate bypass, D8) and the stuck rule's count.
Questions The Eye or a Leg raised for an attempt a crash cut short are
withdrawn when the job starts again. Cleared when the task settles.

**Paused for room** (2026-10-04, [[ADR-050-Parallel-By-Default]]): when
the computer is in danger, Oraknid pauses one running task the same
way, at a safe point with a checkpoint and a handoff, while its job
goes on; it isn't a failed attempt, and the task starts again by itself
from its handoff once the danger has passed. The pause is in memory:
after a restart the task is simply ready and is admitted like any other.

## Watchdog

- systemd restarts the daemon if it dies (`Restart=always`), and
  `WatchdogSec` catches a hung event loop. The daemon pings systemd's
  watchdog from its main loop.
- Inside the daemon, a Leg supervisor watches every child process: exit
  codes, heartbeats (output or progress within the stall window), memory
  limits. A Leg process that dies unexpectedly ends its session as
  `crashed`, and The Eye treats it as drift step 2.

## Durability rules

- BR-8: the database first, then the world.
- All writes for one transition happen in one transaction.
- The event log is append-only.

Related: [[Persistence-and-Recovery]] · [[OS-Integration]] · [[Business-Rules]] · [[Jobs-and-Projects]]
