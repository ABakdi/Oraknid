# Deploying The Nest

The Nest is the relay that lets my devices reach Oraknid at home from
anywhere ([[The-Nest]], [[Nest-Protocol]], ADR-017 to 019). It carries
only end-to-end encrypted traffic and can't read it.

A Nest is **private** (the default: only the daemons in `NEST_DAEMONS`)
or **public** (`NEST_MODE=public`, [[ADR-031-Public-Nest]]): other
people's daemons register themselves from Settings → Devices & phone →
The Nest → Use a public Nest, and get their own id and secret; the Nest
keeps only a hash of each secret, in `/data/daemons.json` on its volume.
`NEST_INVITE` makes registering need a code. A public Nest limits
registrations per address per hour, the number of daemons, devices and
bytes per daemon per day, and forgets a daemon unseen for 30 days. It
sees who connects and how much, never what. Its page says whether it is
public, and shows its loader fingerprint as before.

1. A small VPS with Docker, and a domain (or subdomain) pointed at it.
2. Clone this repository on it, then in `deploy/nest/`:
   `cp .env.example .env`, set `NEST_DOMAIN`, and set `NEST_DAEMONS` to
   `home-1:<a long random secret>` (`openssl rand -base64 32`). For a
   public Nest, set `NEST_MODE=public` (and `NEST_INVITE` if you want).
3. `docker compose up -d --build`. Caddy gets the certificate by itself.
4. At home, in Oraknid: Settings → Devices & phone → The Nest → My own
   Nest: its address (`https://<NEST_DOMAIN>`), the same secret, and the
   same daemon id (`home-1`).
5. Pair a phone: Settings → Devices & phone → Show the code, and scan
   it with the phone. Compare the loader fingerprint shown at home with
   the one at the bottom of the Nest's page.

Updating: `git pull && docker compose up -d --build`.

## On a server that already runs nginx

`install.sh` does it all in one go on Debian or Ubuntu: installs what is
missing, runs The Nest in Docker on a free local port, adds one nginx
site for the domain (checked with `nginx -t` before a reload), gets the
certificate with certbot, and prints the id and secret for Settings.
Other sites and containers are left alone; running it again updates it.

    curl -fsSL https://raw.githubusercontent.com/ABakdi/Oraknid/main/deploy/nest/install.sh -o install.sh
    sudo sh install.sh nest.example.com --email me@example.com

`--public` or `--private` (the default) chooses the mode, `--invite CODE`
an invite code (`--no-invite` drops it); a rerun keeps both unless given
again. On a small server, build the image elsewhere and pass it with
`--image nest.tar.gz` (see the top of the script).

### Two Nests on one server

Each domain gets a Nest of its own: its compose project and container
(`oraknid-nest-<domain with dashes>`), its data volume
(`oraknid-nest-<…>-data`), its settings in `/etc/oraknid-nest/<domain>/`
(`env`, `compose.yml`), its nginx site and its own free port. Run the
script once per domain:

    sudo sh install.sh oraknid.example.com --public
    sudo sh install.sh private.oraknid.example.com --private

Both use the one image `oraknid-nest:latest`: updating one rebuilds it,
and the other picks it up at its own next rerun.

An install from before there could be two kept its settings in
`/etc/oraknid-nest/env` and ran as the compose project `oraknid-nest`.
Rerunning the script for that domain moves it into the layout above: it
keeps its id, secret and port, stops the old project, sets its files
aside as `*.moved-to-<domain>`, and starts the new one.
