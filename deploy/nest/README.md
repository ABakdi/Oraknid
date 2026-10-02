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

## On a server that already runs nginx

`install.sh` does it all in one go on Debian or Ubuntu: installs what is
missing, runs The Nest in Docker on a free local port, adds one nginx
site for the domain (checked with `nginx -t` before a reload), gets the
certificate with certbot, and prints the id and secret for Settings.
Other sites and containers are left alone; running it again updates it.

    curl -fsSL https://raw.githubusercontent.com/ABakdi/Oraknid/main/deploy/nest/install.sh -o install.sh
    sudo sh install.sh nest.example.com --email me@example.com

On a small server, build the image elsewhere and pass it with
`--image nest.tar.gz` (see the top of the script).
