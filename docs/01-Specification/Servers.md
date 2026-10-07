# Servers

**Is:** the machines I run things on, known to Oraknid: how to reach
them, what is on them (a state document kept up to date), how they are
doing (oraknid-monitor), and a terminal into them.
**Is not:** a configuration manager. Oraknid changes a server only when
a job I started does so, through its approvals: a job of a project that
has the server, or one I asked for in the server's own chat
([[ADR-049-Server-Chat-And-Server-Jobs]]).

## Adding a server

On the **Servers** page, **Add a server**: a name, the host, the port
and the user, how to log in (a password, or a private key), and in my
words what it is and what it has ("the VPS for my sites: nginx, two
Node apps under pm2, Postgres"). **Fix wording** next to the
description rewrites it with a quick model (Chats-and-Helper → Fix
wording); **Undo** brings mine back.

A private key is given as **its file** first (2026-10-04): a box to
choose the file or drop it on, which then shows the file's name and
what was read ("id_ed25519 · OpenSSH private key", and "with a
passphrase" when its header says so). **Paste it instead** opens a box
of fixed size that scrolls both ways, without wrapping, so a long key
never stretches the dialog. Before anything is sent the form looks at
the key lightly: a public key (`ssh-ed25519 …`, a `.pub`) or text that
isn't a key is said in words and can't be saved; the daemon has the
last word when it connects.

### Testing the connection (2026-10-04)

**Test connection**, in the add dialog and the edit one, tries the form
as it is, before anything is saved (`servers.test`): it connects over
SSH with a 10-second limit and runs `uname -sr; uname -n`. It says
either "Logged in as root: Linux 6.1.0 (vps1)." with the host key's
fingerprint, or why not, in plain words (the same words the backups'
checks use, `sshWords` in `servers/ssh.ts`): the login refused (wrong
password or key), the key has a passphrase and none was given, the
passphrase doesn't open the key, it is a public key, no host by that
name, the connection refused (SSH not running on that port), no answer
(off, or a firewall), or another host key than the one pinned, with
its fingerprint. Nothing is pinned or kept by a test. Away from home
it is refused like adding a server.

### Editing a server (2026-10-04)

**Edit**, in a server's header, and **Fix the connection** next to an
error (also on a project's servers, "Can't connect: fix it"), opens the
same dialog filled in with the server: its name, description, host,
port and user, and empty credentials, which mean "keep the current
ones". Anything can be changed (`servers.update`):

- A **new host or port** forgets the pinned host key (the next
  connection pins the new one, shown by Test connection) and
  oraknid-monitor's install there.
- A **new private key** (with its passphrase, or none) replaces the
  kept key or password; a **passphrase alone** goes with the key kept.
- A **new password** replaces the key, and the server is to set up
  again: Set up installs Oraknid's key with it, as for a new one.
- Its connection is dropped and its error cleared: the next use
  connects with what was saved.

`server.updated` names the fields changed, never a secret.

The first connection checks the host key and shows its fingerprint;
it is pinned from then on, and a different key later stops every
connection until I accept it again. Then, with my click:

1. **Oraknid's own key**: Oraknid makes a key pair for this server and
   adds its public key to the user's `authorized_keys`. From then on it
   logs in with that key; a password I gave is deleted.
2. **Discovery**, read-only: Oraknid runs a fixed list of commands that
   only read (system, disks, memory, services, open ports, containers,
   web server sites, scheduled jobs, the main folders) and keeps what
   they printed.
3. **The state document**: The Eye writes what the server is and what
   is on it, from my description and the discovery, in markdown. I can
   read it and edit it; each version is kept, with the job whose end wrote it
   (the State document tab lists them, `servers.history`).
4. **oraknid-monitor** is installed (below).

## The state document

The one place that says what a server has and what must not be broken:
its system, its services and how they run, sites and domains, ports,
databases, where things live, and what to be careful with. It is
updated:

- when I press **Discover again**;
- after every job that had the server, from a new discovery and what
  the job changed (2026-10-07: also a job that stopped on a failure or
  was cancelled, when a task that wasn't only looking ran since the last
  refresh: what may have changed is still there, its tasks named as not
  finished); a server job's version ends with **Changes by job
  “…”**, the tasks that changed something and the checks that proved
  them, and The Eye's report of the job shows the diff from the version
  before (below);
- by my own edits.

## Servers in projects

A project's settings list my servers; I tick the ones its jobs may use
(none by default). A job's sessions then get, for each of them, its
state document in their context, and a way in: an SSH host alias in
the Leg's own SSH config with a key file in the Leg's home, never my
own SSH folder. Commands on a server go through Oraknid's approvals
like any other that reaches outside ([[Approvals-and-Autonomy]]); the
state document says what is there, so the work avoids breaking it.

**A role in each project** (2026-10-03, [[ADR-042-Several-Repos-And-Servers]]):
next to each ticked server, a word of mine for what it is there
(testing, staging, production…) and a **Production** mark; a role named
`production` or `prod` is production without the mark. A server can
have a different role in each project. A job's sessions get each
server's role with its state document, production said loud, and the
one The Eye chose for the job marked as the server for its work. Which
server a deploy goes to, and when production is confirmed:
[[The-Eye]] → A project's repos and servers. A server I marked
production on its own page is production in every project
([[ADR-049-Server-Chat-And-Server-Jobs]]).

## A server's chat and its jobs (2026-10-04, [[ADR-049-Server-Chat-And-Server-Jobs]])

Each server has a project of its own, made with its first message and
hidden from the Projects list: its folder a scratch folder of Oraknid's
(`<data>/server-jobs/<server id>`), the server its one server, the
built-in **server-work** method its skill. Its conversation is the
server's **Chat** tab; its jobs are the server's **Jobs** tab, and are
jobs like any other (Silk, Workflow, inbox, notifications), opened in
that project's Work tab.

In the **Chat** tab I write to The Eye about the server:

- With a job going on the server, my message goes to it, as in a project.
- A **question** its state document and readings answer ("what runs on
  it?", "which node does it have?") is answered there, without a job.
- **Work** ("install fail2ban", "rotate the logs of app y", "upgrade
  node on this box"), or a question that needs looking on the server
  ("why does nginx return 502 for x.com"), becomes a **server job**: its
  goal my request made precise, this server its server.

A server job is planned like any job (a small one is one task); a task
that only looks is research and changes nothing. Its sessions get the
state document, the server's role and production, and the way in of
Servers in projects; they are told the work is on the server, the
folder only for notes. Before anything changes, **the plan says what
will change and waits for my approval** ("Approve what will change on
vps"), unless the job runs at Full autonomy on a server that isn't
production; a job that only looks starts at once.

**Checks on the server**: a check written `ssh <alias> <command>` runs
on the server, run by Oraknid over its own connection with the pinned
host key (`ssh oraknid-vps systemctl is-active fail2ban`). A check only
reads; on production one that could change something is refused.

**Commands on a server** go through the approvals like every command,
judged as what runs there: in `ssh <alias> '…'` with nothing after it
on the line, `sudo` is the server's business and is not refused as
root on this computer; what is never allowed stays refused.
**Production** — my **Production** mark on the server's Overview, or
its role in a project — asks before anything that doesn't only read,
at any autonomy, in every project and in its own chat; `scp` and
`rsync` to it always ask.

When the job ends, a new discovery writes the next version of the state
document (above), what was read of the server is read again, and The
Eye reports in the Chat what was done, with the version, its diff, and
the backup plans to look at when its data changed. Away from home,
asking for work on a server and the Production mark are home only for
a device without full rights, like every server action.

## oraknid-monitor

A small POSIX shell program Oraknid installs on the server, in the
user's home (`~/.local/bin/oraknid-monitor`), with nothing to run in
the background. While Oraknid is running, it asks it every 15 seconds,
over the server's SSH connection (encrypted), for one reading: CPU,
memory, disks, load, network bytes, open connections, the running
services and the listening ports. The Servers page shows them live,
with the last 24 hours as charts. Removing a server removes the program.

A server Oraknid can't reach (its connection failing, or no reading for
three rounds, at least two minutes) is **stale** (2026-10-07): its page
shows its last state document and readings, marked "stale since …";
the last reading is kept past the 24 hours until a new one comes.

## What runs there ([[ADR-043-Server-Insight]])

A ready server's page is in tabs: **Overview** (the readings, its name,
description and address, its Production mark, edit, remove), **Chat**
and **Jobs** ([[ADR-049-Server-Chat-And-Server-Jobs]]), **Docker**,
**Databases**, **Proxy & traffic**, **Logs**, **Backups**
([[ADR-044-Backups]]), **Terminal** and **State document**. oraknid-monitor reads each part
only while its tab is open (and again every 30 s to 2 min while the page
is in sight; **Refresh** reads it now), over the same SSH connection; the
daemon keeps a reading 20 seconds so the tabs and the helper share it,
and nothing of it is stored.

| Part | What it shows | How it is read |
| :-- | :-- | :-- |
| Docker (or Podman) | Containers grouped by compose project: state, health, uptime, ports, CPU and memory; images (size, unused); volumes (unused); networks | `docker ps -a`, `docker stats --no-stream`, `images`, `volume ls`, `network ls`, `inspect` |
| Databases | PostgreSQL, MySQL/MariaDB, MongoDB, Redis as services, processes or containers: kind, version, state, port; size of its data folder only when the user can read all of it; SQLite files the state document or a backup plan names, sized when readable; each database's size with a backup plan's login (PostgreSQL, MySQL/MariaDB; 2026-10-07) | `systemctl list-units --all`, `pgrep`, the client's `--version`, `ss -tln`, `du -sk` |
| Reverse proxy | nginx, Caddy, Traefik, HAProxy: which, its state, version, sites (names, ports, upstreams, root or redirect), certificates and when they end (red under two weeks), `nginx -t` when the user is root or has sudo without a password | `nginx -T` (or the config files), the Caddyfile, `haproxy.cfg`, Traefik's labels; `openssl x509 -enddate` |
| Traffic | The last 15 minutes: requests per minute, status codes, top paths (without their query) and clients, bytes; established connections per listening port | the access logs the proxy names, `tail -n 5000` each (never the whole file); `ss -tn` |
| Logs | A service's (`journalctl`), a container's (`docker logs`) or the proxy's files: the last lines, a search through the last 20 000, or followed live | `oraknid-monitor logs …`; followed over the live socket, stopped on the server when the tab or page closes |

What a part can't read, it says, with why: "add the user to the docker
group", a log "not readable (it belongs to www-data:adm): add the user to
the adm group", "nginx -t needs root", the journal showing only the
user's own messages. Oraknid never asks for root for these.

**Restart**, on a container, a database's service or container, or the
proxy's service, is the one change these screens make: it asks first
(what will run, on which server), only names a container or service the
server has, runs `docker restart` or `systemctl restart` (as root, or
`sudo -n`; otherwise it says root is needed), and every attempt is in
the audit log. Home only for a device without full rights.

Discovery feeds the state document with what it finds: the containers,
the databases and the proxy's sites and certificates.

## Sites (2026-10-07, [[ADR-060-Sites-Domains-And-Uptime]])

**Sites**, first in the Servers list: the domains my servers' proxies
serve (read with **Find sites** and after each discovery; wildcards,
`_`, localhost and addresses left out), and those I add by hand. For
each, from this computer: its DNS (A, AAAA, CNAME, and whether it points
at its server), its certificate from a handshake (its end, red under two
weeks, its issuer, and whether it is trusted and for this domain), read
every 6 hours; and an uptime check, a GET every 5 minutes by default
(1–60), up below 500, kept 7 days. Two failed checks in a row are the
`site.down` notification, once; the first check up after is `site.up`.
Removing a site its proxy serves hides it from Find sites. The helper
(`sites`) and the terminal app (`/sites`) list them.

## The terminal

**Terminal** (web UI): a terminal in the browser (xterm.js) on this
computer, or on one of my servers over SSH. Off until I turn it on in
Settings, because it is a full shell; then only on paired devices,
each opening audited. Away from home, only on a device with full
rights, through the tunnel ([[ADR-030-Device-Rights]]). The Terminal
page is a workspace: terminals in tabs, side by side or in a grid
([[Web-UI]] → Terminal).

## Backups (2026-10-03, [[ADR-044-Backups]])

A **backup plan** is one database on one of my servers, or all of a
server's: PostgreSQL, MySQL/MariaDB, MongoDB, Redis or SQLite, on the
host (host and port, or the local socket) or in a Docker (or Podman)
container by its name; a login, whose password is in the keychain
(`backup.plan.<id>.password`). It has a **schedule** in this
computer's time (every hour at a minute, every day at a time, every
week on a day, or a five-field cron line), a **destination** (a folder
on this computer, `~` my home; or a folder on another of my servers,
from its login's home), a **retention** (the last N and none older
than D days; the newest good backup always stays) and an optional
**age key**.

**A run**, over the server's SSH connection: the native dump
(`pg_dump --clean --if-exists --no-owner --no-privileges` or
`pg_dumpall`; `mariadb-dump`/`mysqldump --single-transaction`;
`mongodump --archive`; Redis `BGSAVE`, waited for, then its RDB file;
SQLite `.backup` to a temporary file), inside its container with
`docker exec -i` when it has one. The password goes to the tool as the
first line of the command's stdin, read by the shell into the variable
the tool reads (`PGPASSWORD`, `MYSQL_PWD`, `REDISCLI_AUTH`) and handed
on by name (`docker exec -e NAME`); MongoDB's tools read it from a
config file made for the run (mode 600) and removed when it ends. It
is never in a command line, a log or an event. The dump streams to
Oraknid, is compressed (zstd), encrypted to the key's public half (age)
when the plan has one, hashed (SHA-256), and written as `<file>.part`,
renamed once the dump has said it ended well: on this computer
(folder and file mine only) or on the other server through its own SSH
connection (`umask 077`, `cat`, then `mv`). A file is
`<plan>-<id>/<YYYYMMDD-HHMMSS>-<database>.<sql|archive|rdb|sqlite>.zst[.age]`.

Each run is recorded: when, why (its schedule, a **missed** time run
when Oraknid came back, or Run now), its state, size, duration,
checksum, where, its key, and the error in plain words (no such
container, the login refused, nothing answering on the port, the tool
not installed, Docker not reachable by the SSH user). A failed run is
the `backup.failed` notification ([[Notifications]]). A time missed
while Oraknid was off runs once when it starts, said so; a run cut by
a stop is failed and its partial file removed. After a good run,
retention removes what it lets go (the file, there; the record stays,
marked).

**Keys** are age X25519 keys made by Oraknid (or imported): the public
half in SQLite, the private half in the keychain
(`backup.key.<id>`), which I can take away **once** (shown and
downloaded); it is used only for Verify and Restore. A key a plan uses,
or that kept backups were made with, can't be removed.

**Verify** reads a backup back (from this computer, or with `cat` over
the other server's SSH), checks its checksum, decrypts and decompresses
it, and checks it is a whole dump of its kind (the header and the
ending of a PostgreSQL or MySQL dump, mongodump's archive magic number
and terminator, the RDB header and EOF byte, the SQLite header and
size). **Restore** puts it back into the plan's database or another
(another container, server, database name; its password for that
restore only), in two steps: what it will replace, then the database's
name (a SQLite file's name, a server's for all) typed back within five
minutes. A Redis restore puts the file in place and stops Redis without
saving; a container is started again. Restoring is never an agent's
([[Security]] → Backups).

Related: [[ADR-026-Servers]] · [[ADR-027-Oraknid-Monitor]] · [[ADR-028-Terminal]] · [[ADR-043-Server-Insight]] · [[ADR-044-Backups]] · [[ADR-049-Server-Chat-And-Server-Jobs]] · [[Security]] · [[Web-UI]]
