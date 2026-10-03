# Servers

**Is:** the machines I run things on, known to Oraknid: how to reach
them, what is on them (a state document kept up to date), how they are
doing (oraknid-monitor), and a terminal into them.
**Is not:** a configuration manager. Oraknid changes a server only when
a job I started does so, through its approvals.

## Adding a server

On the **Servers** page, **Add a server**: a name, the host, the port
and the user, how to log in (a password, or a private key I paste),
and in my words what it is and what it has ("the VPS for my sites:
nginx, two Node apps under pm2, Postgres").

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
   read it and edit it; each version is kept.
4. **oraknid-monitor** is installed (below).

## The state document

The one place that says what a server has and what must not be broken:
its system, its services and how they run, sites and domains, ports,
databases, where things live, and what to be careful with. It is
updated:

- when I press **Discover again**;
- after every job that had the server, from a new discovery and what
  the job changed;
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
[[The-Eye]] → A project's repos and servers.

## oraknid-monitor

A small POSIX shell program Oraknid installs on the server, in the
user's home (`~/.local/bin/oraknid-monitor`), with nothing to run in
the background. While Oraknid is running, it asks it every 15 seconds,
over the server's SSH connection (encrypted), for one reading: CPU,
memory, disks, load, network bytes, open connections, the running
services and the listening ports. The Servers page shows them live,
with the last 24 hours as charts. Removing a server removes the program.

## What runs there ([[ADR-043-Server-Insight]])

A ready server's page is in tabs: **Overview** (the readings, its name,
description and address, edit, remove), **Docker**, **Databases**,
**Proxy & traffic**, **Logs**, **Backups** ([[ADR-044-Backups]]),
**Terminal** and **State document**. oraknid-monitor reads each part
only while its tab is open (and again every 30 s to 2 min while the page
is in sight; **Refresh** reads it now), over the same SSH connection; the
daemon keeps a reading 20 seconds so the tabs and the helper share it,
and nothing of it is stored.

| Part | What it shows | How it is read |
| :-- | :-- | :-- |
| Docker (or Podman) | Containers grouped by compose project: state, health, uptime, ports, CPU and memory; images (size, unused); volumes (unused); networks | `docker ps -a`, `docker stats --no-stream`, `images`, `volume ls`, `network ls`, `inspect` |
| Databases | PostgreSQL, MySQL/MariaDB, MongoDB, Redis as services, processes or containers: kind, version, state, port; size of its data folder only when the user can read all of it | `systemctl list-units --all`, `pgrep`, the client's `--version`, `ss -tln`, `du -sk` |
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

Related: [[ADR-026-Servers]] · [[ADR-027-Oraknid-Monitor]] · [[ADR-028-Terminal]] · [[ADR-043-Server-Insight]] · [[ADR-044-Backups]] · [[Security]] · [[Web-UI]]
