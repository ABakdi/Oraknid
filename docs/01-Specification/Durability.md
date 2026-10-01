# Durability

**Is:** Oraknid surviving everything a machine does: crashes, reboots,
power cuts, sleep, and me pressing pause. It never loses work and never
does anything twice.
**Is not:** backups of my workspace. My git repo is mine to back up.

## Background service

- The daemon runs as a **systemd user service** (`oraknid.service`),
  enabled at login, with lingering enabled so it starts at boot even
  before I log in ([[OS-Integration]]).
- `oraknid` CLI: `start`, `stop`, `status`, `logs`, `open` (opens the UI),
  `doctor` (checks the setup and says what is wrong).
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

On start, the daemon runs recovery before anything else:

1. Open the database (WAL) and run any pending migrations.
2. Every job in an active state is set to `recovering`, internally.
3. Every session that was running is marked `crashed`. Its Leg processes
   are found by recorded PID and start time, and killed if still alive.
4. For each task that was `running`:
   - The worktree state is compared with the last checkpoint. Changes
     since then are kept, recorded in a new checkpoint, and noted in a
     Silk handoff built from the event log.
   - The task returns to `ready` with that handoff.
5. Side effects in `intended` or `approved` are reconciled (BR-6): the
   adapter checks whether the action happened (e.g. is the commit on
   the remote, is the email in Sent). If the check is impossible, an
   inbox question asks me. Nothing is re-run blindly.
6. Jobs return to the state they were in (a paused job stays paused).
7. An event "Recovered after crash/reboot" lists what was found and
   done. I'm notified.

## Lossless pause and resume (BR-7)

**Pause** requests a safe point from every running session:

1. Ask the Leg to finish its current turn. Up to 120 s by default.
2. If it doesn't finish in time, interrupt. The partial work stays on
   disk.
3. Record a checkpoint and a handoff for each task.
4. The job becomes `paused`. The UI said "Pausing…" until this point.

**Resume** restarts each task from its handoff and checkpoint. Where the
Leg's native session can still be resumed and is under the context
threshold, it's resumed. Otherwise a fresh session starts from a context
pack.

Pausing never runs verification, never replans, and never touches
side effects.

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
