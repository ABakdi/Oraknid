#!/bin/sh
# The Nest in one go, on a Debian or Ubuntu server, behind nginx with HTTPS.
#
#   curl -fsSL https://raw.githubusercontent.com/ABakdi/Oraknid/main/deploy/nest/install.sh -o install.sh
#   sudo sh install.sh oraknid.example.com [--email me@example.com] [--ref main]
#
# On a small server, build the image elsewhere and bring it, so the build
# doesn't take memory from what already runs there:
#   docker build -f deploy/nest/Dockerfile -t oraknid-nest:latest . && docker save oraknid-nest:latest | gzip > nest.tar.gz
#   sudo sh install.sh oraknid.example.com --image nest.tar.gz
#
# What it does, and nothing else:
# - installs what is missing: git, curl, openssl, Docker, nginx, certbot;
# - clones (or updates) Oraknid in /opt/oraknid and builds The Nest's image;
# - runs The Nest in Docker, listening on 127.0.0.1 only, on a free port;
# - adds one nginx site for the domain (WebSockets included), checks the
#   whole nginx config before reloading, and never restarts nginx;
# - gets a certificate with certbot and redirects HTTP to HTTPS;
# - keeps the daemon id and secret in /etc/oraknid-nest/env (same ones on
#   a rerun) and prints them for Settings → Away from home.
# Other sites, containers and ports are left as they are. Running it again
# updates The Nest.
set -eu

DOMAIN=""
EMAIL=""
REF="main"
IMAGE=""
DIR="/opt/oraknid"
REPO="https://github.com/ABakdi/Oraknid.git"
CONF_DIR="/etc/oraknid-nest"
ENV_FILE="$CONF_DIR/env"
PROJECT="oraknid-nest"

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --email) EMAIL="${2:-}"; shift 2 ;;
    --ref) REF="${2:-}"; shift 2 ;;
    --dir) DIR="${2:-}"; shift 2 ;;
    --image) IMAGE="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    -*) die "unknown option $1" ;;
    *) DOMAIN="$1"; shift ;;
  esac
done

[ -n "$DOMAIN" ] || die "usage: sh install.sh <domain> [--email you@example.com] [--ref main]"
printf '%s' "$DOMAIN" | grep -Eq '^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' || die "\"$DOMAIN\" isn't a domain name"
[ "$(id -u)" -eq 0 ] || die "run it as root (sudo sh install.sh $DOMAIN)"
command -v apt-get >/dev/null || die "this script knows Debian and Ubuntu (apt-get) only"

# --- What is missing -------------------------------------------------------
need=""
for p in git curl openssl nginx certbot; do
  command -v "$p" >/dev/null || need="$need $p"
done
if [ -n "$need" ]; then
  say "Installing:$need"
  pkgs=$(echo "$need" | sed 's/certbot/certbot python3-certbot-nginx/')
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $pkgs >/dev/null
fi
# certbot's nginx plugin, when certbot was there without it
if ! certbot plugins 2>/dev/null | grep -q nginx; then
  say "Installing certbot's nginx plugin"
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3-certbot-nginx >/dev/null
fi
if ! command -v docker >/dev/null; then
  say "Installing Docker"
  curl -fsSL https://get.docker.com | sh >/dev/null
fi
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is missing (docker compose)"

# --- The domain points here? ----------------------------------------------
here=$(curl -fsS4 --max-time 10 https://api.ipify.org 2>/dev/null || true)
there=$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR==1{print $1}')
if [ -z "$there" ]; then
  die "$DOMAIN doesn't resolve yet; point it at this server first"
elif [ -n "$here" ] && [ "$here" != "$there" ]; then
  die "$DOMAIN points at $there, but this server is $here"
fi

# --- The code --------------------------------------------------------------
if [ -d "$DIR/.git" ]; then
  say "Updating $DIR to $REF"
  git -C "$DIR" fetch -q --depth 1 origin "$REF"
  git -C "$DIR" checkout -q --force FETCH_HEAD
else
  say "Cloning Oraknid ($REF) into $DIR"
  git clone -q --depth 1 --branch "$REF" "$REPO" "$DIR"
fi

# --- Secret and port, kept across reruns ------------------------------------
mkdir -p "$CONF_DIR"
chmod 700 "$CONF_DIR"
NEST_ID=""; NEST_SECRET=""; NEST_PORT=""
# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && . "$ENV_FILE"
[ -n "$NEST_ID" ] || NEST_ID="home-1"
[ -n "$NEST_SECRET" ] || NEST_SECRET=$(openssl rand -base64 32 | tr -d '\n=' | tr '+/' '-_')
port_free() { ! ss -tlnH "sport = :$1" 2>/dev/null | grep -q .; }
if [ -z "$NEST_PORT" ]; then
  NEST_PORT=8787
  while ! port_free "$NEST_PORT"; do NEST_PORT=$((NEST_PORT + 1)); done
fi
umask 077
cat >"$ENV_FILE" <<EOF
NEST_ID=$NEST_ID
NEST_SECRET=$NEST_SECRET
NEST_PORT=$NEST_PORT
NEST_DAEMONS=$NEST_ID:$NEST_SECRET
EOF
umask 022

# --- The Nest in Docker, on localhost only ---------------------------------
build="--build"
if [ -n "$IMAGE" ]; then
  [ -f "$IMAGE" ] || die "no image file $IMAGE"
  say "Loading the image from $IMAGE"
  gunzip -c "$IMAGE" 2>/dev/null | docker load -q || docker load -q -i "$IMAGE"
  build="--no-build"
fi
say "Starting The Nest (127.0.0.1:$NEST_PORT)"
cat >"$CONF_DIR/compose.yml" <<EOF
# Written by install.sh: The Nest alone, nginx in front of it.
name: $PROJECT
services:
  nest:
    build:
      context: $DIR
      dockerfile: deploy/nest/Dockerfile
    image: oraknid-nest:latest
    restart: unless-stopped
    environment:
      NEST_DAEMONS: \${NEST_DAEMONS}
    ports:
      - "127.0.0.1:$NEST_PORT:8080"
EOF
docker compose --env-file "$ENV_FILE" -f "$CONF_DIR/compose.yml" up -d $build --remove-orphans

tries=0
until curl -fsS --max-time 3 "http://127.0.0.1:$NEST_PORT/health" >/dev/null 2>&1; do
  tries=$((tries + 1))
  [ "$tries" -lt 30 ] || die "The Nest didn't answer on 127.0.0.1:$NEST_PORT (docker compose -f $CONF_DIR/compose.yml logs)"
  sleep 2
done

# --- nginx: one site of its own --------------------------------------------
if [ -d /etc/nginx/sites-available ]; then
  SITE="/etc/nginx/sites-available/$DOMAIN.conf"
  LINK="/etc/nginx/sites-enabled/$DOMAIN.conf"
else
  SITE="/etc/nginx/conf.d/$DOMAIN.conf"
  LINK=""
fi
# certbot adds its HTTPS lines to the site; on a rerun only the port can change.
if [ -f "$SITE" ] && grep -q "managed by Certbot" "$SITE"; then
  say "Keeping the nginx site, pointing it at port $NEST_PORT"
  sed -i "s#proxy_pass http://127.0.0.1:[0-9]*;#proxy_pass http://127.0.0.1:$NEST_PORT;#" "$SITE"
else
  say "Writing the nginx site $SITE"
  backup=""
  [ -f "$SITE" ] && backup="$SITE.bak.$(date +%s)" && cp "$SITE" "$backup"
  map_var="oraknid_nest_connection"
  cat >"$SITE" <<EOF
# The Nest (Oraknid's relay), written by deploy/nest/install.sh.
map \$http_upgrade \$$map_var {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    client_max_body_size 2m;

    location / {
        proxy_pass http://127.0.0.1:$NEST_PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$$map_var;
        proxy_set_header Host \$host;
        # Its own address only: The Nest limits connections per address.
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
        proxy_buffering off;
    }
}
EOF
fi
[ -n "$LINK" ] && ln -sf "$SITE" "$LINK"
if ! nginx -t >/dev/null 2>&1; then
  nginx -t || true
  rm -f "$LINK"
  if [ -n "${backup:-}" ]; then mv "$backup" "$SITE"; else rm -f "$SITE"; fi
  [ -n "${backup:-}" ] && [ -n "$LINK" ] && ln -sf "$SITE" "$LINK"
  die "nginx refused the new site; it was taken out again and nginx was not reloaded"
fi
systemctl reload nginx

# --- HTTPS -----------------------------------------------------------------
say "Getting the certificate for $DOMAIN"
if [ -n "$EMAIL" ]; then who="--email $EMAIL"; else who="--register-unsafely-without-email"; fi
# shellcheck disable=SC2086
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos $who --redirect --keep-until-expiring
nginx -t >/dev/null 2>&1 && systemctl reload nginx

# --- Check from outside -----------------------------------------------------
if curl -fsS --max-time 10 "https://$DOMAIN/health" >/dev/null; then
  say "The Nest answers on https://$DOMAIN"
else
  say "The Nest runs, but https://$DOMAIN/health didn't answer from here yet; check DNS and the firewall (ports 80 and 443)"
fi

cat <<EOF

The Nest is up. At home, in Oraknid: Settings → Devices & phone → The Nest
  Address:    https://$DOMAIN
  Daemon id:  $NEST_ID
  Secret:     $NEST_SECRET
(kept in $ENV_FILE, readable by root only)

Update later:   sh $DIR/deploy/nest/install.sh $DOMAIN --ref $REF  (add --image to bring a prebuilt one)
Logs:           docker compose -f $CONF_DIR/compose.yml logs -f
Remove:         docker compose -f $CONF_DIR/compose.yml down; rm $LINK $SITE; systemctl reload nginx
EOF
