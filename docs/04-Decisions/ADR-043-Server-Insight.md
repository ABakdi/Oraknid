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

## Consequences
- The state document (ADR-026) is fed by what this finds.
- Reading the Docker socket needs the user in the `docker` group, or a
  rule I add; Oraknid says so instead of asking for root.

Related: [[ADR-027-Oraknid-Monitor]] · [[ADR-026-Servers]] · [[ADR-044-Backups]] · [[Servers]] · [[Web-UI]]
