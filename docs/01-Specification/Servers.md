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

## The terminal

**Terminal** (web UI): a terminal in the browser (xterm.js) on this
computer, or on one of my servers over SSH. Off until I turn it on in
Settings, because it is a full shell; then only on paired devices,
each opening audited. Away from home, only on a device with full
rights, through the tunnel ([[ADR-030-Device-Rights]]). The Terminal
page is a workspace: terminals in tabs, side by side or in a grid
([[Web-UI]] → Terminal).

Related: [[ADR-026-Servers]] · [[ADR-027-Oraknid-Monitor]] · [[ADR-028-Terminal]] · [[Security]] · [[Web-UI]]
