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

Related: [[ADR-026-Servers]] · [[ADR-027-Oraknid-Monitor]] · [[ADR-028-Terminal]] · [[ADR-043-Server-Insight]] · [[Security]] · [[Web-UI]]
