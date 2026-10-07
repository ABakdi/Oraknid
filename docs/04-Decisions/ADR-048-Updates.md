# ADR-048 — Updates from inside Oraknid

**Status:** Accepted · 2026-10-04

## Context
Running `install.sh` again updates Oraknid ([[ADR-036-One-Script-Install]]),
and since v0.1.0 there are releases to update to ([[ADR-047-Releases]]).
But nothing tells me a new version is out, and updating means finding
the command again. I want Oraknid to say it is up to date, or that an
update is available with what is in it, and to update in one click
without losing anything. It must follow what I installed: installed from
`dev`, pre-releases and new work on dev count; installed from `main`,
only real releases do.

## Decision
- **install.sh records what it installed** in `<dir>/.oraknid-install.json`:
  `ref` (the branch or tag asked for), `channel`, `commit`, `version`,
  `installedAt`, `from` (the repository, a full path for a clone on this
  computer) and `service` (false with `--no-service`). The channel is
  `dev` for `--dev` (`--ref dev`) and `stable` for anything else: `main`,
  a release's tag, another branch. It is written after a good build and
  link, and kept out of git (`.git/info/exclude`, like `.tools/`).
- **How Oraknid runs**: the record in the folder it runs from means
  install.sh installed it, and Oraknid can update itself. No record, it
  runs from a developer's clone: it says "Running from a clone at
  <path>: update it with git", has no Update now, and never asks GitHub
  on its own (Check now still says what is out).
- **Checks**: GitHub's releases API, without an account, a minute after
  start and then every six hours, and on **Check now**. Each request
  sends the last answer's ETag (`If-None-Match`): an unchanged list is a
  304, which costs nothing against GitHub's 60 requests an hour. Offline
  or limited, the check keeps its last answer and says why in a
  sentence; it never fails loudly.
- **What counts as an update**, by semantic version against the version
  running: on the **stable** channel, the newest release that is
  neither a draft nor a pre-release; on the **dev** channel, pre-releases
  too, and the commits on `dev` past the installed one (GitHub's compare,
  `compare/<commit>...dev`), shown as **New work on dev (N commits)**.
  The notes of every newer release are shown, with their links.
- **Update now** runs install.sh with what was installed: on stable,
  `--ref <the release's tag>`; on dev, `--ref dev`; the same `--dir`,
  `--from` and `--no-service`. The script is the new version's own, read
  from the fetched commit (this version's if that fails), so a version
  that needs something new installs it. It runs **apart from the
  daemon**, which it restarts: as a transient unit (`systemd-run --user`)
  when the daemon is a systemd unit (stopping a unit ends every process
  in it), else in a session of its own. It writes `logs/update.log`, and
  how it ended in `updates/` in the data folder, which the new daemon
  and the page read.
- **Data is never touched**: the script replaces the program's folder
  only; the data folder is apart from it. Before the update starts, the
  database is copied with SQLite's online backup to
  `backups/pre-update-<time>-v<version>.db` (the last three kept), since
  the new version's migrations run at its first start.
- **A failed update goes back**: if the program was changed, the version
  before is built again from its commit (install.sh checks out a commit
  it has without fetching) and the record is put back. If nothing was
  changed (no network, a missing package without a terminal for sudo),
  it only says it failed.
- **Built is not enough: it has to start.** After install.sh, the new
  daemon must load (`cli.mjs --version`) and, with the service, answer
  `oraknid status` within a minute; else the update counts as failed and
  goes back, as above (2026-10-07: a dev build missing a package said
  "succeeded" and left the daemon restarting in a loop).
- **Running jobs**: Update now is refused while jobs run unless I confirm,
  and says how many. They lose nothing: the daemon's shutdown stops each
  at a safe point and keeps its state, and recovery resumes it at the
  next start (Durability).
- **Who may update**: the CLI and a device at home; away from home, only
  a device with full rights ([[ADR-030-Device-Rights]]).
- **Telling me**: a notification once per new release (`update.available`:
  desktop and push, no email; changeable like the others), a line on the
  Overview, and the sidebar's foot. The new daemon says once how the
  update ended (`update.finished`).
- **From the terminal**: `oraknid update` (and `oraknid update --check`)
  does the same, with the daemon running or not, and follows the log.

## Consequences
- Before 1.0 every release is published as a pre-release
  ([[ADR-047-Releases]]), so an install from `main` (stable) is told of
  none until a release is published as a full release; installs from
  `dev` are told of every one. Publishing a release as a release is
  what tells `main`'s installs.
- On OpenRC and runit the service's files are root's, and an update has
  no terminal for sudo: their supervisors restart the daemon on the new
  build, and the files stay as they were (the same so far in every
  version).
- An update downloads and builds: minutes, during which Oraknid keeps
  running until the script restarts it.
- A pairing code is not printed in the update's log (`ORAKNID_UPDATE=1`).
- An install made by v0.1.0's install.sh has no record. Oraknid knows
  one by the `/.tools/` install.sh always kept out of git, and says to
  run install.sh once more (with `--dev` for dev); from then on it
  updates itself. It never guesses the channel.

## As built (2026-10-04)
- install.sh: `write_record` after the build and link; a 40-digit commit
  the checkout has is checked out without fetching; `ORAKNID_UPDATE=1`
  prints no pairing code; `ORAKNID_INSTALL_LIB=1` only defines its
  functions (the tests run them).
- The daemon: `apps/daemon/src/updates/` — `semver.ts` (semver's order,
  pre-releases included), `github.ts` (releases and the dev comparison
  with ETags; why a check failed, in words), `install.ts` (the app's
  folder, found from the program, and its record), `runner.ts` (the
  database's copy, the update script, its start through `systemd-run`
  when `INVOCATION_ID` says the daemon is a unit, and the run read back
  from `updates/status.json`, `pid`, `result` and the log), `service.ts`
  (`Updates`: the checks and their state in the setting `updates.state`,
  the view, Update now, the events). Procedures `updates.status`,
  `updates.check`, `updates.run({confirm})`; `/updates/run` is HOME_ONLY
  for a standard device away from home, and refused in the procedure
  too.
- The update script (`updates/run-update.sh`, written per update) passes
  on the service's PATH, HOME, XDG and ORAKNID variables, and without
  the service starts Oraknid again by hand (`oraknid stop`, `start`).
  Its states: running, succeeded, rolled-back, failed, interrupted (its
  process gone without a result).
- The web: the sidebar's foot (`UpdateBadge`), a line on the Overview
  (`UpdateNotice`), Settings → **About & updates** (`UpdatesCard`),
  which polls the status every 2 s while an update runs, says "Oraknid
  is restarting…" while it doesn't answer, and offers **Reload the page**
  once the version or, installed by the script, the commit changed (a dev
  update keeps the version). Every page, wherever it is open, checks
  the build the daemon serves when its live socket comes back and when
  its tab is shown again (`lib/fresh.ts`, the entry script's hashed
  name): a page out of sight reloads by itself, one in front of me
  offers **Reload** ("Oraknid was updated"). Away from home the loader
  brings the app, so this check is skipped there.
- Tested (no network, nothing of the owner's touched): `updates.test.ts`
  (semver; stable and dev with drafts and pre-releases; new work on dev;
  a clone; an install from before the record; checks on their own only when installed; the ETag and a 304;
  offline and rate-limited; one notification per version; full rights
  away; refusal with running jobs; the arguments per channel; detached
  or `systemd-run`, and its failure; the database copied and three kept;
  the run's states and its end told once), `install-script.test.ts`
  (install.sh's own functions on real git repositories in temp folders:
  the record for dev, a tag and `--no-service`, a quote in a path, going
  back to a commit without fetching; the update script run for real: a
  release installed with the new version's script, a failing one rolled
  back with its record, one that can't be fetched leaving all as it
  was), `api/updates.test.ts` (the CLI and a device at home may update;
  away from home only with full rights; refused while a job runs unless
  confirmed), `notify/router.test.ts` (the notification), web
  `updates.test.tsx` (every state of the sidebar's word and the card).

Related: [[ADR-036-One-Script-Install]] · [[ADR-047-Releases]] · [[ADR-030-Device-Rights]] · [[Durability]] · [[Notifications]]
