# ADR-043 — What runs on a server, seen from Oraknid

**Status:** Accepted · 2026-10-03

## Context
oraknid-monitor (ADR-027) shows a server's CPU, memory, disk and network.
I want to see what runs there: Docker containers and images, databases,
the reverse proxy (nginx, Traefik, Caddy, HAProxy) and its sites, the
traffic it serves, and the logs, on the web interface and from the
helper.

## Decision
- **oraknid-monitor reads more, still read-only, still pulled over SSH**
  (ADR-027), a sample of each part only when its screen is open (and a
  light one every few minutes for the server's state), with what it
  can't read saying why (no access to the Docker socket, a log not
  readable by the user):
  - **Docker** (and Podman): containers (name, image, state, health,
    uptime, ports, CPU and memory), images (tag, size, in use or not),
    volumes and networks; compose projects grouped.
  - **Databases**: PostgreSQL, MySQL/MariaDB, MongoDB, Redis, SQLite
    files known to the state document, found as services or containers:
    kind, version, state, port, size when it can be read without
    credentials; more with the credentials of ADR-044.
  - **Reverse proxy**: which one, its state, the sites or routes it
    serves (server names, upstreams, certificates and their expiry), a
    config check (`nginx -t`) when allowed.
  - **Traffic**: requests per minute, status codes, top paths and
    clients, bytes, from the proxy's access log (the last minutes, read
    with `tail`, never shipped whole); connections per port from `ss`.
  - **Logs**: a service's, a container's or the proxy's, the last lines
    and live while open (`journalctl -f`, `docker logs -f`), with a
    search; nothing is kept beyond what's on screen.
- **Servers → a server**, in tabs: Overview (as today), **Docker**,
  **Databases**, **Proxy & traffic**, **Logs**, Backups (ADR-044),
  Terminal, State document. Actions there are few and gated: restart a
  container or a service (asks, like any change on a server, ADR-026).
- **The helper** reads all of it through the API and can take me to
  any of it.

## As built (2026-10-03, [[Phase-13-Projects-First]] M13.12)
- **oraknid-monitor version 2**: `sample docker|databases|proxy|traffic
  [LOG…]` print one JSON line each; `logs unit:NAME|container:NAME|file:PATH
  [-n N] [-g TEXT] [-f]` prints the lines as they are. Still one POSIX sh
  file with awk (each JSON string built character by character, sizes and
  counts printed with `%.0f`), tried under dash and mawk on a real Debian
  server. The script is a raw string in the daemon, so the shell's `\`
  stay as written; it is updated on the server when its hash changes.
- **Following stops on the server**: `logs -f` runs the follower in the
  background and waits on the channel's input; when the daemon ends the
  input (the screen or the socket closed), it kills the follower. Nothing
  stays running.
- **Only when asked**: the daemon reads a part when a tab or the helper
  asks, keeps it 20 seconds so they share it, and stores nothing. The
  tabs read again every 30 s (Docker, traffic), 1 min (databases) or
  2 min (the proxy) while the page is in sight. The "light reading every
  few minutes for the state document" became: every discovery (setup,
  Discover again, after a job) adds what runs there to what The Eye
  writes the document from.
- **Traffic** reads the access logs the proxy names (nginx's
  `access_log`s and its default, Caddy's `output file`, HAProxy's and
  Traefik's usual files), `tail -n 5000` each, at most ten; it reads the
  common and combined formats, nginx formats with a bracketed time and a
  quoted request (a client only when the line starts with one), and the
  JSON lines of Caddy and Traefik. Times are compared with the server's
  own clock, so no time zone is needed. Paths are counted without their
  query string.
- **Databases**: Debian's `postgresql.service` (it only starts the
  clusters) is left out when a `postgresql@…` unit is there; a database
  process inside a container is that container, shown once. Sizes are the
  data folder's (`du -sk`) when the user can read all of it; SQLite files
  and sizes inside containers wait for the credentials of ADR-044.
- **Logs** go over the existing live socket (`logs-open` / `log` /
  `log-end` / `logs-close`), so they also work away from home through The
  Nest's tunnel without a channel of their own.
- **Restart** is `servers.restart` with `confirm: true`; the container or
  service must be one the server has; services through `systemctl` as
  root or `sudo -n`, otherwise "needs root"; audited as `server.restarted`.
- **The helper** has read actions `server_docker`, `server_databases`,
  `server_proxy`, `server_traffic`, `server_log_sources` and
  `server_logs`, all wrapped as untrusted data.
- Tried read-only on the real staging server (Debian 11, dash, mawk,
  Docker 27, nginx 1.18): 19 containers in 5 compose projects (one
  unhealthy), 46 images (28 unused), 3 MongoDB containers, 37 nginx
  server blocks merged into 19 sites, 6 certificates (two already ended),
  `nginx -t` ok, 104 requests in 15 minutes from two access logs, and a
  followed container log stopped with nothing left running.
- **A database container's login** (2026-10-04, for a backup plan's
  form, [[ADR-044-Backups]] → As built): the databases part adds
  `login: {user, database, passwordSet}` to each container, from its
  environment, filtered on the server so a password's value never
  leaves it; the monitor script itself is unchanged.

## Consequences
- The state document (ADR-026) is fed by what this finds.
- Reading the Docker socket needs the user in the `docker` group, or a
  rule I add; Oraknid says so instead of asking for root.

Related: [[ADR-027-Oraknid-Monitor]] · [[ADR-026-Servers]] · [[ADR-044-Backups]] · [[Servers]] · [[Web-UI]]
