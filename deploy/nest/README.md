# Deploying The Nest

The Nest is the relay that lets my devices reach Oraknid at home from
anywhere ([[The-Nest]], [[Nest-Protocol]], ADR-017 to 019). It carries
only end-to-end encrypted traffic and keeps no data.

1. A small VPS with Docker, and a domain (or subdomain) pointed at it.
2. Clone this repository on it, then in `deploy/nest/`:
   `cp .env.example .env`, set `NEST_DOMAIN`, and set `NEST_DAEMONS` to
   `home-1:<a long random secret>` (`openssl rand -base64 32`).
3. `docker compose up -d --build`. Caddy gets the certificate by itself.
4. At home, in Oraknid: Settings → Away from home → The Nest's address
   (`https://<NEST_DOMAIN>`), the same secret, and the same daemon id
   (`home-1`).
5. Pair a phone: Settings → Away from home → Make its link, and scan the
   code with the phone. Compare the loader fingerprint shown at home
   with the one at the bottom of the Nest's page.

Updating: `git pull && docker compose up -d --build`.
