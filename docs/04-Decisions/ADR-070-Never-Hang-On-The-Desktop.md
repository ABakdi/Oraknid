# ADR-070 — Never hang on the desktop

**Status:** Accepted · 2026-10-16 · extends [[ADR-036-One-Script-Install]], [[ADR-048-Updates]], [[ADR-012-Sleep-Inhibition]]

## Context
On 2026-10-16, after a reboot, http://127.0.0.1:7417/ loaded forever.
The daemon was up: `/health` answered and `/api/*` said 401 at once,
but the index, every asset and `/live` hung. Mail failed with "Socket
timeout". `systemctl --user restart oraknid` waited the whole stop
timeout and then killed it ("Failed with result 'timeout'").

What the process and the journal showed:

1. **Oraknid started the keychain itself.** `oraknid.service`
   (`WantedBy=default.target`) started at 15:18:58; the Wayland session
   at 15:19:31. At 15:19:00 Oraknid's first Secret Service call
   D-Bus-activated a gnome-keyring of its own, before any login had
   unlocked it ("Started dbus-:1.2-org.freedesktop.secrets@0.service").
   The collection was locked, the keyring tried to prompt, the prompter
   failed ("couldn't create system prompt … NameHasNoOwner"), and the
   call never returned. At 15:19:35 the session's own keyring found
   "discover_other_daemon: 1": Oraknid had broken the desktop's keyring
   startup.
2. **The calls held the thread pool.** The native keyring runs its
   D-Bus calls on Node's libuv pool, 4 threads by default, with no
   deadline. All 4 sat in poll. Every file read (`express.static`,
   `res.sendFile`), every `dns.lookup` and the rest queued behind them
   forever. 358 of the process's 393 Unix sockets were D-Bus connections
   that had never closed.
3. **17 `notify-send --wait`** processes had been alive 15 to 20
   minutes, each waiting for a click.
4. **Nothing noticed.** systemd's watchdog is pinged from the main
   loop, which was fine; the stop waited on work that waited on the pool.

## Decision
**Oraknid never makes a call to the desktop that can wait forever, never
starts a desktop service itself, and the web UI never waits behind
anything.**

### 1. Never activate the Secret Service
Before any keychain call the session bus is asked whether
`org.freedesktop.secrets` has an owner (`NameHasOwner`, answered by the
bus itself, which starts nothing), then whether the default collection
is locked (its `Locked` property, read with auto-start off). Through
`busctl --user`, else `dbus-send`.

- No owner: no call. "Waiting for the desktop keychain: the Secret
  Service isn't running yet (it starts with the desktop session)."
- Locked: no call, and never `Unlock` or anything that prompts.
  "Waiting for the keychain to unlock."
- No session bus at all (a headless machine): no keychain; the
  encrypted file store, as before.
- Neither tool installed: the call is made, bounded as below.

What the bus said is kept 30 s when unlocked, 2 s otherwise, and asked
again after any failure. The daemon starts serving at once; secrets
start in "waiting" and the daemon asks again in the background (2 s,
doubling, up to 5 minutes) until the keychain answers or the encrypted
file is opened instead. Features that need a secret meanwhile say
"Waiting for the keychain to unlock" instead of hanging.

### 2. The keychain runs in a helper process with a deadline
Keychain calls run in a helper process (`node -e`, the native keyring's
synchronous calls, one request per line), never on the daemon's pool:

- one call in flight; others queue (32 at most, then "busy");
- 5 s per call: past it, the helper is killed (its D-Bus connection
  closes with it) and the call, and those queued behind it, fail with
  "The desktop keychain didn't answer within 5 s (locked, or not
  started yet)". The link's growing pause applies (1 s doubling to 60 s),
  without the immediate retry a closed connection gets;
- an idle helper ends after 15 s; the next call starts one;
- a dropped connection is closed, and the daemon ends its helper when it
  stops. A test makes 100 calls to a keychain that never answers and
  finds no connection left open, never more than two at once.

### 3. The web UI is never hostage
- The thread pool is 16 threads: the entry (`dist/cli.mjs`) sets
  `UV_THREADPOOL_SIZE` before anything loads, and the service's unit
  sets it too.
- The web UI's files are read into memory at start (64 MB at most; the
  rest from disk) and served from there: the index for every page of
  the app, the assets by path. A new build (newer index.html, one
  `statSync`) is read again. A test fills the pool and loads the page.

### 4. notify-send is bounded
At most 4 `notify-send --wait` wait for a click; a new one ends the
oldest, and one with the same tag ends the one it replaces on screen.
Each waits 10 minutes at most, then is ended (TERM, then KILL) and
reaped. The daemon ends its own when it stops.

### 5. The daemon looks at itself
Every 30 s it reads a small file through the pool (`<data>/.alive`) and
asks for its own page, each within 10 s. Failing for 2 minutes on end,
it logs why and exits with 70, so the service manager starts it again;
only under one (`ORAKNID_SUPERVISED=1` from the service, or systemd's
`INVOCATION_ID`). Otherwise it keeps running and says how to restart.
The first look is 30 s after start and the exit at least 2 minutes after
the first failure, after the updater's one minute "it must start" check
(ADR-048) has passed, so an update can't be taken for a failed start
because of it.

### 6. Stopping has a deadline
Jobs keep their time to reach a safe point (BR-7, up to 140 s). The
rest of the stop has 10 s; past it the daemon logs the step it was
still waiting on and exits regardless. Its notify-send processes and
the keychain helper are ended first. `TimeoutStopSec=150` stays as
systemd's backstop: lower would cut a job's safe point short.

### 7. Start with the desktop when there is one
`oraknid install` writes the systemd user unit with `After=dbus.socket`,
and on a desktop (systemd's `graphical-session.target` running when it
installs) `After=` and `WantedBy=graphical-session.target`: it starts
once the session, and its keychain, are up. Elsewhere `WantedBy=
default.target` (at boot with linger). Compositors that never start
`graphical-session.target` (Hyprland without uwsm) count as no desktop,
or the service would never start: there §1 stands alone. The ordering
is the extra; §1 is the fix.

### 8. Existing installs get it on update
Every update runs `oraknid install` (install.sh), which rewrites the
unit. When the unit changed, the service is re-enabled (`reenable`
moves its `WantedBy` link) and restarted on the new settings, instead
of `enable --now`. OpenRC's and runit's scripts carry the same
environment.

## Consequences
- After a reboot, the page loads at once; secrets that need the
  keychain wait for the login that unlocks it, and the keychain the
  desktop starts is the desktop's own.
- On a desktop with `graphical-session.target`, Oraknid starts at login,
  not at boot; jobs resume then.
- A keychain locked during a session is not asked to unlock: secrets
  wait until it is unlocked by other means.
- The helper is a second Node process for up to 15 s after each burst
  of keychain use.
- Questions to systemd and logind from the daemon (`oraknid doctor`,
  the service's status) give up after 10 s.
