import { createHash } from "node:crypto";

// oraknid-monitor (ADR-027, ADR-043): one POSIX shell file on the server,
// asked over SSH. `sample` is the reading every 15 s (/proc, df, ss,
// systemctl); `sample docker|databases|proxy|traffic` reads one part only
// when its screen is open; `logs` prints a log, and follows it until
// Oraknid closes the channel. It only reads: it writes nothing, keeps
// nothing and leaves nothing running. Every number is printed as a plain
// integer or with a fixed number of decimals: Debian's awk (mawk) prints
// big numbers in e-notation otherwise.
//
// The script is a raw string: the shell's own `$` and `\` stay as written
// (it never uses the brace form of a variable, which TypeScript would read).

export const MONITOR_PATH = ".local/bin/oraknid-monitor";

export const MONITOR_SCRIPT = String.raw`#!/bin/sh
# oraknid-monitor: readings of this machine as JSON, for Oraknid.
# Installed by Oraknid; asked over SSH; only reads: writes nothing, keeps
# nothing, leaves nothing running. Each part is read only when asked.
set +u
R=$ORAKNID_MONITOR_ROOT
set -u
LC_ALL=C
export LC_ALL
PATH="$PATH:/usr/sbin:/sbin:/usr/local/sbin"
TAB=$(printf '\t')
ME=$(id -un 2>/dev/null || echo "this user")
ROOT=no
[ "$(id -u 2>/dev/null)" = 0 ] && ROOT=yes

usage() {
  echo "usage: oraknid-monitor [version | sample [docker|databases|proxy|traffic [LOG...]] | logs SOURCE [-n N] [-f] [-g TEXT]]" >&2
  exit 2
}

# awk helpers: a JSON string (char by char: awk's gsub mangles backslashes),
# and a size such as 85.2MiB, 231MB or 1.5kB in bytes.
J='
function js(s,   o, i, c, n) {
  o = ""; n = length(s)
  for (i = 1; i <= n; i++) {
    c = substr(s, i, 1)
    if (c == "\\") o = o "\\\\"
    else if (c == "\"") o = o "\\\""
    else if (c == "\t") o = o "\\t"
    else if (c == "\n") o = o "\\n"
    else if (c < " ") o = o " "
    else o = o c
  }
  return "\"" o "\""
}
function jn(s) { return s == "" ? "null" : js(s) }
function tob(s,   n, u) {
  n = s + 0; u = s; sub(/^[0-9.]+[ ]*/, "", u); u = tolower(u)
  if (u ~ /^ki/) n *= 1024; else if (u ~ /^mi/) n *= 1048576
  else if (u ~ /^gi/) n *= 1073741824; else if (u ~ /^ti/) n *= 1099511627776
  else if (u ~ /^k/) n *= 1000; else if (u ~ /^m/) n *= 1000000
  else if (u ~ /^g/) n *= 1000000000; else if (u ~ /^t/) n *= 1000000000000
  return sprintf("%.0f", n)
}
function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
'

# Why a file can't be read, in words.
unreadable() {
  if [ -e "$1" ] || ls "$1" 2>&1 | grep -q 'ermission denied'; then
    owner=$(ls -ld "$1" 2>/dev/null | awk '{print $3 ":" $4}')
    case "$owner" in
      *:adm) echo "not readable by $ME (it belongs to $owner): add $ME to the adm group." ;;
      "") echo "not readable by $ME." ;;
      *) echo "not readable by $ME (it belongs to $owner)." ;;
    esac
  else
    echo "not there."
  fi
}

# A service's state: active, inactive, failed… or running/stopped without systemd.
unit_state() {
  if command -v systemctl >/dev/null 2>&1; then
    s=$(systemctl is-active "$1" 2>/dev/null | head -n 1)
    [ -n "$s" ] && { echo "$s"; return; }
  fi
  if pgrep -x "$2" >/dev/null 2>&1; then echo running; else echo unknown; fi
}

# ── The reading every 15 s (ADR-027)

sample_base() {
  cpu() { awk '/^cpu /{print $2+$3+$4+$5+$6+$7+$8, $5+$6}' /proc/stat; }
  a=$(cpu); sleep 1; b=$(cpu)
  cpu_pct=$(printf '%s %s\n' "$a" "$b" | awk '{t=$3-$1; i=$4-$2; if (t>0) printf "%.1f", (t-i)*100/t; else print 0}')
  load1=$(cut -d' ' -f1 /proc/loadavg)
  # Plain integers: mawk (Debian's awk) prints big numbers in e-notation, and %d can overflow.
  mem_total=$(awk '/^MemTotal:/{printf "%.0f", $2*1024}' /proc/meminfo)
  mem_avail=$(awk '/^MemAvailable:/{printf "%.0f", $2*1024}' /proc/meminfo)
  mem_used=$(awk -v t="$mem_total" -v a="$mem_avail" 'BEGIN{printf "%.0f", t-a}')
  set -- $(df -P -k / | awk 'NR==2{printf "%.0f %.0f", $2*1024, $3*1024}') 0 0
  disk_total=$1; disk_used=$2
  set -- $(awk -F'[: ]+' 'NR>2 && $2!="lo"{rx+=$3; tx+=$11} END{printf "%.0f %.0f", rx, tx}' /proc/net/dev) 0 0
  rx=$1; tx=$2
  conns=$( (ss -tnH state established 2>/dev/null || true) | wc -l | tr -d ' ')
  uptime_s=$(cut -d. -f1 /proc/uptime)
  json_list() { awk 'BEGIN{printf "["} NF{gsub(/["\\]/,""); printf "%s\"%s\"", (n++?",":""), $0} END{printf "]"}'; }
  services=$( (systemctl list-units --type=service --state=running --no-pager --no-legend 2>/dev/null || true) | awk '{print $1}' | head -n 60 | json_list)
  ports=$( (ss -tlnH 2>/dev/null || true) | awk '{print $4}' | sort -u | head -n 60 | json_list)
  printf '{"cpuPercent":%s,"load1":%s,"memUsed":%s,"memTotal":%s,"diskUsed":%s,"diskTotal":%s,"rxBytes":%s,"txBytes":%s,"connections":%s,"uptimeSec":%s,"services":%s,"ports":%s}\n' \
    "$cpu_pct" "$load1" "$mem_used" "$mem_total" "$disk_used" "$disk_total" "$rx" "$tx" "$conns" "$uptime_s" "$services" "$ports"
}

# ── Docker and Podman (ADR-043)

# Sets E (docker, podman or empty), EV (its version) and EERR (why it can't be read).
probe_engine() {
  E=""; EV=""; EERR=""
  if command -v docker >/dev/null 2>&1; then E=docker
  elif command -v podman >/dev/null 2>&1; then E=podman
  else return 1; fi
  if [ "$E" = podman ]; then out=$(podman version --format '{{.Version}}' 2>&1)
  else out=$(docker version --format '{{.Server.Version}}' 2>&1); fi
  if [ $? -eq 0 ]; then EV=$(printf '%s\n' "$out" | tail -n 1); return 0; fi
  case "$out" in
    *ermission\ denied*)
      EERR="$ME can't reach the Docker socket: add $ME to the docker group (sudo usermod -aG docker $ME), then Oraknid reconnects." ;;
    *"Cannot connect"*|*"daemon running"*|*"onnection refused"*)
      EERR="$E is installed, but its daemon isn't running." ;;
    *) EERR="$E didn't answer: $(printf '%s\n' "$out" | grep -v '^ *$' | tail -n 1)" ;;
  esac
  return 1
}

ps_lines() {
  if [ "$E" = podman ]; then
    podman ps -a --format "{{.ID}}$TAB{{.Names}}$TAB{{.Image}}$TAB{{.State}}$TAB{{.Status}}$TAB{{.Ports}}$TAB{{index .Labels \"com.docker.compose.project\"}}$TAB{{index .Labels \"com.docker.compose.service\"}}" 2>/dev/null
  else
    docker ps -a --format "{{.ID}}$TAB{{.Names}}$TAB{{.Image}}$TAB{{.State}}$TAB{{.Status}}$TAB{{.Ports}}$TAB{{.Label \"com.docker.compose.project\"}}$TAB{{.Label \"com.docker.compose.service\"}}" 2>/dev/null
  fi | head -n 200
}

sample_docker() {
  if ! probe_engine; then
    printf '{"engine":%s,"version":null,"error":%s,"containers":[],"images":[],"volumes":[],"networks":[]}\n' \
      "$(printf '%s' "$E" | awk "$J"'{printf "%s", js($0)} END{if (NR==0) printf "null"}')" \
      "$(printf '%s' "$EERR" | awk "$J"'{printf "%s", js($0)} END{if (NR==0) printf "null"}')"
    return
  fi
  ids=$($E ps -aq 2>/dev/null | head -n 200)
  {
    $E stats --no-stream --format "{{.Name}}$TAB{{.CPUPerc}}$TAB{{.MemUsage}}" 2>/dev/null | head -n 200 | sed "s/^/S$TAB/"
    [ -n "$ids" ] && $E inspect --format '{{.Image}}' $ids 2>/dev/null | sed "s/^/U$TAB/"
    ps_lines | sed "s/^/C$TAB/"
    $E images --format "{{.Repository}}$TAB{{.Tag}}$TAB{{.ID}}$TAB{{.Size}}$TAB{{.CreatedSince}}" 2>/dev/null | head -n 200 | sed "s/^/I$TAB/"
    if [ "$E" = docker ]; then
      docker ps -a --no-trunc --format '{{.Mounts}}' 2>/dev/null | tr ',' '\n' | sed "s/^/M$TAB/"
      docker volume ls --format "{{.Name}}$TAB{{.Driver}}$TAB{{.Label \"com.docker.compose.project\"}}" 2>/dev/null | head -n 200 | sed "s/^/V$TAB/"
      docker network ls --format "{{.Name}}$TAB{{.Driver}}$TAB{{.Scope}}" 2>/dev/null | head -n 100 | sed "s/^/N$TAB/"
    else
      podman volume ls --format "{{.Name}}$TAB{{.Driver}}" 2>/dev/null | head -n 200 | sed "s/^/V$TAB/"
      podman network ls --format "{{.Name}}$TAB{{.Driver}}" 2>/dev/null | head -n 100 | sed "s/^/N$TAB/"
    fi
  } | awk -F'\t' -v engine="$E" -v version="$EV" "$J"'
function nv(s) { return s == "<no value>" ? "" : s }
function add(list, x) { return list == "" ? x : list "," x }
$1 == "S" { cpu[$2] = $3; mem[$2] = $4; next }
$1 == "U" { u = $2; sub(/^sha256:/, "", u); used[substr(u, 1, 12)] = 1; next }
$1 == "M" { if ($2 != "") mounted[$2] = 1; next }
$1 == "C" {
  name = $3; status = $6; health = ""; uptime = ""
  if (status ~ /\(healthy\)/) health = "healthy"
  else if (status ~ /\(unhealthy\)/) health = "unhealthy"
  else if (status ~ /health: starting/) health = "starting"
  if (status ~ /^Up /) { uptime = status; sub(/^Up /, "", uptime); sub(/ *\(.*$/, "", uptime) }
  c = "null"; m = "null"; l = "null"
  if (name in cpu) { c = sprintf("%.2f", cpu[name] + 0) }
  if (name in mem) { split(mem[name], mm, " / "); m = tob(trim(mm[1])); l = tob(trim(mm[2])) }
  cs = add(cs, sprintf("{\"id\":%s,\"name\":%s,\"image\":%s,\"state\":%s,\"status\":%s,\"health\":%s,\"uptime\":%s,\"ports\":%s,\"project\":%s,\"service\":%s,\"cpuPercent\":%s,\"memBytes\":%s,\"memLimit\":%s}", \
    js($2), js(name), js($4), js(tolower($5)), js(status), jn(health), jn(uptime), js($7), jn(nv($8)), jn(nv($9)), c, m, l))
  next
}
$1 == "I" {
  id = $4; sub(/^sha256:/, "", id)
  is = add(is, sprintf("{\"repository\":%s,\"tag\":%s,\"id\":%s,\"sizeBytes\":%s,\"created\":%s,\"inUse\":%s}", \
    js($2), js($3), js(substr(id, 1, 12)), tob($5), js($6), (substr(id, 1, 12) in used) ? "true" : "false"))
  next
}
$1 == "V" {
  vs = add(vs, sprintf("{\"name\":%s,\"driver\":%s,\"project\":%s,\"inUse\":%s}", js($2), js($3), jn(nv($4)), ($2 in mounted) ? "true" : "false"))
  next
}
$1 == "N" { ns = add(ns, sprintf("{\"name\":%s,\"driver\":%s,\"scope\":%s}", js($2), js($3), jn(nv($4)))); next }
END {
  printf "{\"engine\":%s,\"version\":%s,\"error\":null,\"containers\":[%s],\"images\":[%s],\"volumes\":[%s],\"networks\":[%s]}\n", \
    js(engine), jn(version), cs, is, vs, ns
}'
}

# ── Databases (ADR-043): as services, processes or containers

db_kind() {
  case "$1" in
    postgres*|postgis*|timescale*) echo postgres ;;
    mysql*|mariadb*|percona*) echo mysql ;;
    mongo*) echo mongodb ;;
    redis*|valkey*|keydb*) echo redis ;;
  esac
}

db_version() {
  case "$1" in
    postgres) v=$( (psql --version || postgres --version) 2>/dev/null | head -n 1) ;;
    mysql) v=$( (mariadbd --version || mysqld --version || mysql --version) 2>/dev/null | head -n 1) ;;
    mongodb) v=$(mongod --version 2>/dev/null | head -n 1) ;;
    redis) v=$( (redis-server --version || valkey-server --version) 2>/dev/null | head -n 1) ;;
    *) v="" ;;
  esac
  printf '%s\n' "$v" | awk '
    match($0, /Distrib [0-9]+\.[0-9]+(\.[0-9]+)?/) { print substr($0, RSTART + 8, RLENGTH - 8); exit }
    match($0, /[0-9]+\.[0-9]+(\.[0-9]+)?/) { print substr($0, RSTART, RLENGTH); exit }'
}

db_port() {
  case "$1" in postgres) echo 5432 ;; mysql) echo 3306 ;; mongodb) echo 27017 ;; redis) echo 6379 ;; esac
}

db_dir() {
  case "$1" in
    postgres) echo "$R/var/lib/postgresql" ;; mysql) echo "$R/var/lib/mysql" ;;
    mongodb) echo "$R/var/lib/mongodb" ;; redis) echo "$R/var/lib/redis" ;;
  esac
}

# Prints "size<TAB>note": the data folder's size when this user can read all of it.
db_size() {
  d=$(db_dir "$1")
  [ -d "$d" ] || { printf '\t%s\n' "No data folder at $d."; return; }
  if command -v timeout >/dev/null 2>&1; then out=$(timeout 15 du -sk "$d" 2>/dev/null)
  else out=$(du -sk "$d" 2>/dev/null); fi
  if [ $? -eq 0 ] && [ -n "$out" ]; then
    printf '%s\t\n' "$(printf '%s\n' "$out" | awk 'NR==1{printf "%.0f", $1*1024}')"
  else
    printf '\t%s\n' "Its data folder ($d) isn't readable by $ME: the size needs root or the database's credentials."
  fi
}

sample_databases() {
  listening=$( (ss -tlnH 2>/dev/null || true) | awk '{print $4}')
  rows=""
  seen=" "
  units=$( (systemctl list-units --type=service --all --no-legend --no-pager --plain 2>/dev/null || true) |
    awk '$1 ~ /^(postgresql|mysql|mysqld|mariadb|mongod|mongodb|redis|redis-server|valkey|valkey-server)(@[^ ]*)?\.service$/ { print $1, $3, $4 }')
  [ -n "$units" ] && rows=$(printf '%s\n' "$units" | while read -r unit active sub; do
    # Debian's postgresql.service only starts its clusters (postgresql@15-main).
    [ "$unit" = postgresql.service ] && [ "$sub" = exited ] && printf '%s\n' "$units" | grep -q '^postgresql@' && continue
    kind=$(db_kind "$unit")
    port=$(db_port "$kind")
    printf '%s\n' "$listening" | grep -q ":$port\$" || port=""
    set -- "$(db_size "$kind")"
    printf 'D\t%s\t%s\tservice\t%s\t%s\t%s\t%s\n' "$kind" "$unit" "$(db_version "$kind")" "$active" "$port" "$1"
  done)
  for p in postgres mysqld mariadbd mongod redis-server valkey-server; do
    kind=$(db_kind "$p")
    printf '%s\n' "$rows" | grep -q "^D$TAB$kind$TAB" && continue
    pgrep -x "$p" >/dev/null 2>&1 || continue
    port=$(db_port "$kind")
    printf '%s\n' "$listening" | grep -q ":$port\$" || port=""
    rows="$rows
$(printf 'P\t%s\t%s\tprocess\t%s\trunning\t%s\t%s' "$kind" "$p" "$(db_version "$kind")" "$port" "$(db_size "$kind")")"
  done
  note=""
  if probe_engine; then containers=$(ps_lines); else containers=""; [ -n "$EERR" ] && note="Containers not read: $EERR"; fi
  {
    printf '%s\n' "$rows"
    [ -n "$containers" ] && printf '%s\n' "$containers" | sed "s/^/C$TAB/"
  } | awk -F'\t' -v note="$note" "$J"'
function add(list, x) { return list == "" ? x : list "," x }
function kindof(img,   b, n, p) {
  b = img; sub(/@.*/, "", b); n = split(b, p, "/"); b = p[n]; sub(/:.*/, "", b)
  if (b ~ /^(postgres|postgis|timescaledb|postgresql)/) return "postgres"
  if (b ~ /^(mysql|mariadb|percona)/) return "mysql"
  if (b ~ /^mongo/) return "mongodb"
  if (b ~ /^(redis|valkey|keydb)/) return "redis"
  return ""
}
($1 == "D" || $1 == "P") && $2 != "" {
  o = sprintf("{\"kind\":%s,\"name\":%s,\"source\":%s,\"version\":%s,\"state\":%s,\"port\":%s,\"sizeBytes\":%s,\"note\":%s}", \
    js($2), js($3), js($4), jn($5), js($6), $7 == "" ? "null" : $7 + 0, $8 == "" ? "null" : $8, jn($9))
  if ($1 == "D") ds = add(ds, o); else { np++; pend[np] = o; pk[np] = $2 }
  next
}
$1 == "C" {
  k = kindof($4); if (k == "") next; cont[k] = 1
  tag = $4; sub(/@.*/, "", tag); n = split(tag, tp, "/"); tag = tp[n]; if (tag ~ /:/) sub(/^[^:]*:/, "", tag); else tag = "latest"
  port = ""; if (match($7, /:[0-9]+->/)) port = substr($7, RSTART + 1, RLENGTH - 3)
  ds = add(ds, sprintf("{\"kind\":%s,\"name\":%s,\"source\":\"container\",\"version\":%s,\"state\":%s,\"port\":%s,\"sizeBytes\":null,\"note\":%s}", \
    js(k), js($3), js(tag), js(tolower($5)), port == "" ? "null" : port + 0, \
    js("In a container: its size needs the database credentials.")))
}
END {
  # A database process inside a container is that container: shown once.
  for (i = 1; i <= np; i++) if (!(pk[i] in cont)) ds = add(ds, pend[i])
  printf "{\"databases\":[%s],\"notes\":[%s]}\n", ds, note == "" ? "" : js(note)
}'
}

# ── The reverse proxy (ADR-043): nginx, Caddy, Traefik, HAProxy

# nginx's whole configuration as nginx reads it, or its files when nginx -T isn't allowed.
nginx_conf() {
  out=$(nginx -T 2>/dev/null | head -n 50000)
  if [ -n "$out" ] && printf '%s\n' "$out" | grep -q 'server'; then printf '%s\n' "$out"; return; fi
  for f in "$R/etc/nginx/nginx.conf" "$R"/etc/nginx/conf.d/*.conf "$R"/etc/nginx/sites-enabled/*; do
    [ -f "$f" ] && [ -r "$f" ] && cat "$f"
  done
}

# One "site {json}" line per server block, and "cert", "alog", "elog" lines.
NGX='
function stmt(st,   w, n, i, k) {
  if (st == "") return
  n = split(st, w, /[ \t]+/); k = w[1]
  if (updepth && k == "server") { ups[up] = ups[up] (ups[up] == "" ? "" : " ") w[2]; return }
  if (k == "access_log" || k == "error_log") {
    if (w[2] == "off" || w[2] ~ /^(syslog:|stderr|\/dev\/)/ || w[2] ~ /\$/) return
    if (k == "access_log") { alogs[w[2]] = 1; if (sd) alog[srv] = w[2] } else elogs[w[2]] = 1
    return
  }
  if (!sd) return
  if (k == "server_name") { for (i = 2; i <= n; i++) if (w[i] != "_" && w[i] != "\"\"") names[srv] = names[srv] " " w[i] }
  else if (k == "listen") listen[srv] = listen[srv] " " w[2]
  else if (k == "root") root[srv] = w[2]
  else if (k ~ /^(proxy|fastcgi|uwsgi|grpc|scgi)_pass$/) pass[srv] = pass[srv] " " w[2]
  else if (k == "ssl_certificate" && w[2] !~ /\$/) { cert[srv] = w[2]; certs[w[2]] = 1 }
  else if (k == "return" && ret[srv] == "") ret[srv] = w[2] " " w[3]
}
function arr(s,   a, n, i, o) { n = split(trim(s), a, /[ \t]+/); o = ""; for (i = 1; i <= n; i++) if (a[i] != "" && !((a[i]) in dup)) { dup[a[i]] = 1; o = o (o == "" ? "" : ",") js(a[i]) } ; for (i in dup) delete dup[i]; return "[" o "]" }
function upstreams(s,   a, n, i, h, o) {
  n = split(trim(s), a, /[ \t]+/); o = ""
  for (i = 1; i <= n; i++) {
    h = a[i]; sub(/^[a-z]+:\/\//, "", h); sub(/[\/].*$/, "", h)
    o = o " " ((h in ups) ? ups[h] : (a[i] ~ /^unix:/ ? a[i] : h))
  }
  return arr(o)
}
{
  line = $0; sub(/#.*/, "", line); line = line " "; n = length(line)
  for (i = 1; i <= n; i++) {
    c = substr(line, i, 1)
    if (c == "{") {
      st = trim(buf); buf = ""; depth++; split(st, w, /[ \t]+/)
      if (w[1] == "server" && !sd) { srv++; sd = depth }
      else if (w[1] == "upstream") { up = w[2]; updepth = depth }
    } else if (c == "}") {
      stmt(trim(buf)); buf = ""
      if (depth == sd) sd = 0
      if (depth == updepth) { updepth = 0; up = "" }
      if (depth > 0) depth--
    } else if (c == ";") { stmt(trim(buf)); buf = "" }
    else buf = buf c
  }
}
END {
  for (s = 1; s <= srv; s++)
    printf "site {\"names\":%s,\"listen\":%s,\"upstreams\":%s,\"root\":%s,\"redirect\":%s,\"certificate\":%s,\"accessLog\":%s}\n", \
      arr(names[s]), arr(listen[s]), upstreams(pass[s]), jn(root[s]), jn(trim(ret[s])), jn(cert[s]), jn(alog[s])
  for (c in certs) print "cert " c
  for (c in alogs) print "alog " c
  for (c in elogs) print "elog " c
}'

# {"path","notAfter","error"} for each certificate path on stdin.
certs_json() {
  while read -r p; do
    [ -n "$p" ] || continue
    end=""; err=""
    if [ ! -r "$p" ]; then err=$(unreadable "$p")
    elif ! command -v openssl >/dev/null 2>&1; then err="openssl isn't installed: no expiry."
    else end=$(openssl x509 -noout -enddate -in "$p" 2>/dev/null | sed 's/^notAfter=//')
      [ -n "$end" ] || err="not a certificate openssl reads."
    fi
    printf '%s\t%s\t%s\n' "$p" "$end" "$err"
  done | awk -F'\t' "$J"'{ printf "%s{\"path\":%s,\"notAfter\":%s,\"error\":%s}", (NR > 1 ? "," : ""), js($1), jn($2), jn($3) }'
}

paths_json() { awk "$J"'NF { printf "%s%s", (n++ ? "," : ""), js($0) }'; }

# Logs that exist, from the configured ones and the usual places.
existing_logs() { for f in "$@"; do [ -e "$f" ] && echo "$f"; done | sort -u; }

# nginx -t: as root, or through sudo when it asks no password; otherwise said so.
config_check() {
  if [ "$ROOT" = yes ]; then out=$("$@" 2>&1)
  elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then out=$(sudo -n "$@" 2>&1)
  else
    printf '{"ok":null,"output":%s}' "$(printf '%s' "$* needs root to check the configuration; $ME isn't root and has no sudo without a password." | awk "$J"'{printf "%s", js($0)}')"
    return
  fi
  rc=$?
  printf '{"ok":%s,"output":%s}' "$([ $rc -eq 0 ] && echo true || echo false)" "$(printf '%s\n' "$out" | tail -n 4 | awk "$J"'{ s = s (NR > 1 ? "\n" : "") $0 } END { printf "%s", js(s) }')"
}

proxy_entry() { # kind source name state version check sites certs alogs elogs note
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$@" | awk -F'\t' "$J"'{
    printf "{\"kind\":%s,\"source\":%s,\"name\":%s,\"state\":%s,\"version\":%s,\"check\":%s,\"sites\":[%s],\"certificates\":[%s],\"accessLogs\":[%s],\"errorLogs\":[%s],\"note\":%s}", \
      js($1), js($2), js($3), js($4), jn($5), ($6 == "" ? "null" : $6), $7, $8, $9, $10, jn($11) }'
}

sample_proxy() {
  PX=""
  add() { PX="$PX$([ -n "$PX" ] && printf ',')$1"; }
  have_engine=no
  probe_engine && have_engine=yes
  containers=""
  [ "$have_engine" = yes ] && containers=$(ps_lines)
  # nginx
  if command -v nginx >/dev/null 2>&1 || [ -d "$R/etc/nginx" ]; then
    parsed=$(nginx_conf | awk "$J$NGX")
    sites=$(printf '%s\n' "$parsed" | sed -n 's/^site //p' | paste -sd, -)
    certs=$(printf '%s\n' "$parsed" | sed -n 's/^cert //p' | sort -u | certs_json)
    alogs=$(existing_logs $(printf '%s\n' "$parsed" | sed -n 's/^alog //p') "$R/var/log/nginx/access.log" | paths_json)
    elogs=$(existing_logs $(printf '%s\n' "$parsed" | sed -n 's/^elog //p') "$R/var/log/nginx/error.log" | paths_json)
    version=$(nginx -v 2>&1 | sed -n 's/.*nginx\/\([0-9.]*\).*/\1/p')
    check=""
    command -v nginx >/dev/null 2>&1 && check=$(config_check nginx -t)
    note=""
    [ -n "$sites" ] || note="No site found in nginx's configuration (or it isn't readable by $ME)."
    add "$(proxy_entry nginx service nginx "$(unit_state nginx nginx)" "$version" "$check" "$sites" "$certs" "$alogs" "$elogs" "$note")"
  fi
  # Caddy
  if command -v caddy >/dev/null 2>&1 || [ -f "$R/etc/caddy/Caddyfile" ]; then
    f="$R/etc/caddy/Caddyfile"
    sites=""; alogs=""; note="Caddy gets and renews its certificates itself."
    if [ -r "$f" ]; then
      parsed=$(awk "$J"'
function arr(s,   a, n, i, o) { n = split(trim(s), a, /[ ,\t]+/); o = ""; for (i = 1; i <= n; i++) if (a[i] != "") o = o (o == "" ? "" : ",") js(a[i]); return "[" o "]" }
{
  line = $0; sub(/#.*/, "", line); line = trim(line); if (line == "") next
  if (depth == 0 && line ~ /\{$/) { a = line; sub(/[ \t]*\{$/, "", a); if (a != "" && a !~ /^\(/) { site++; names[site] = a } else skip = 1 }
  else if (depth >= 1 && site && !skip) {
    n = split(line, w, /[ \t]+/)
    if (w[1] == "reverse_proxy") { for (i = 2; i <= n; i++) if (w[i] !~ /^[\/@{]/) ups[site] = ups[site] " " w[i] }
    else if (w[1] == "root") root[site] = w[n]
    else if (w[1] == "redir") ret[site] = w[2]
    else if (w[1] == "output" && w[2] == "file") { print "alog " w[3]; alog[site] = w[3] }
  }
  o = line; opens = gsub(/\{/, "", o); o = line; closes = gsub(/\}/, "", o); depth += opens - closes
  if (depth == 0) skip = 0
}
END { for (s = 1; s <= site; s++) printf "site {\"names\":%s,\"listen\":[],\"upstreams\":%s,\"root\":%s,\"redirect\":%s,\"certificate\":null,\"accessLog\":%s}\n", arr(names[s]), arr(ups[s]), jn(root[s]), jn(ret[s]), jn(alog[s]) }' "$f")
      sites=$(printf '%s\n' "$parsed" | sed -n 's/^site //p' | paste -sd, -)
      alogs=$(existing_logs $(printf '%s\n' "$parsed" | sed -n 's/^alog //p') | paths_json)
    elif [ -e "$f" ]; then note="$f is $(unreadable "$f")"
    fi
    version=$(caddy version 2>/dev/null | awk '{print $1; exit}' | sed 's/^v//')
    add "$(proxy_entry caddy service caddy "$(unit_state caddy caddy)" "$version" "" "$sites" "" "$alogs" "" "$note")"
  fi
  # HAProxy
  if command -v haproxy >/dev/null 2>&1 || [ -f "$R/etc/haproxy/haproxy.cfg" ]; then
    f="$R/etc/haproxy/haproxy.cfg"
    sites=""; certs=""; note=""
    if [ -r "$f" ]; then
      parsed=$(awk "$J"'
function arr(s,   a, n, i, o) { n = split(trim(s), a, /[ \t]+/); o = ""; for (i = 1; i <= n; i++) if (a[i] != "") o = o (o == "" ? "" : ",") js(a[i]); return "[" o "]" }
{ line = $0; sub(/#.*/, "", line); if (trim(line) == "") next; n = split(trim(line), w, /[ \t]+/) }
line ~ /^[^ \t]/ { sec = w[1]; name = w[2]; if (sec == "frontend" || sec == "listen") { fe++; fname[fe] = name; if (sec == "listen") { fb[fe] = name } } ; next }
(sec == "frontend" || sec == "listen") && w[1] == "bind" { bind[fe] = bind[fe] " " w[2]; for (i = 3; i < n; i++) if (w[i] == "crt") { print "cert " w[i + 1]; crt[fe] = w[i + 1] } }
(sec == "frontend" || sec == "listen") && (w[1] == "default_backend" || w[1] == "use_backend") { fb[fe] = fb[fe] " " w[2] }
(sec == "frontend" || sec == "listen") && w[1] == "acl" && line ~ /hdr\(host\)|hdr_dom\(host\)|req.hdr\(host\)/ { for (i = 4; i <= n; i++) if (w[i] !~ /^-/) hosts[fe] = hosts[fe] " " w[i] }
(sec == "backend" || sec == "listen") && w[1] == "server" { members[name] = members[name] " " w[3] }
END {
  for (f = 1; f <= fe; f++) {
    m = ""; k = split(trim(fb[f]), b, /[ \t]+/); for (i = 1; i <= k; i++) m = m " " members[b[i]]
    printf "site {\"names\":%s,\"listen\":%s,\"upstreams\":%s,\"root\":null,\"redirect\":null,\"certificate\":%s,\"accessLog\":null}\n", arr(hosts[f] == "" ? fname[f] : hosts[f]), arr(bind[f]), arr(m), jn(crt[f])
  }
}' "$f")
      sites=$(printf '%s\n' "$parsed" | sed -n 's/^site //p' | paste -sd, -)
      certs=$(printf '%s\n' "$parsed" | sed -n 's/^cert //p' | sort -u | certs_json)
    elif [ -e "$f" ]; then note="$f is $(unreadable "$f")"
    fi
    version=$(haproxy -v 2>/dev/null | sed -n 's/.*version \([0-9.]*\).*/\1/p' | head -n 1)
    alogs=$(existing_logs "$R/var/log/haproxy.log" | paths_json)
    add "$(proxy_entry haproxy service haproxy "$(unit_state haproxy haproxy)" "$version" "" "$sites" "$certs" "$alogs" "" "$note")"
  fi
  # Traefik: as a service, or a container with its routes in the other containers' labels.
  tr_container=$(printf '%s\n' "$containers" | awk -F'\t' '$3 ~ /(^|\/)traefik(:|$)/ { print $2 "\t" tolower($4); exit }')
  if command -v traefik >/dev/null 2>&1 || [ -n "$tr_container" ]; then
    sites=""
    if [ "$have_engine" = yes ]; then
      running=$($E ps -q 2>/dev/null | head -n 200)
      [ -n "$running" ] && sites=$($E inspect --format '{{.Name}}{{range $k, $v := .Config.Labels}}{{"\n"}}{{$k}}={{$v}}{{end}}' $running 2>/dev/null | awk "$J"'
/^\// { name = substr($0, 2); next }
/^traefik\.http\.routers\.[^.]+\.rule=/ {
  r = $0; sub(/^[^=]*=/, "", r); hosts = ""
  while (match(r, /Host\([^)]*\)/)) { h = substr(r, RSTART + 5, RLENGTH - 6); gsub(/[^A-Za-z0-9.*_-]+/, " ", h); hosts = hosts " " h; r = substr(r, RSTART + RLENGTH) }
  rule[name] = rule[name] hosts; next
}
/^traefik\.http\.services\.[^.]+\.loadbalancer\.server\.port=/ { p = $0; sub(/^[^=]*=/, "", p); port[name] = p }
END {
  for (c in rule) {
    n = split(trim(rule[c]), hs, /[ ]+/); o = ""; for (i = 1; i <= n; i++) if (hs[i] != "") o = o (o == "" ? "" : ",") js(hs[i])
    printf "%s{\"names\":[%s],\"listen\":[],\"upstreams\":[%s],\"root\":null,\"redirect\":null,\"certificate\":null,\"accessLog\":null}", (k++ ? "," : ""), o, js(c ((c in port) ? ":" port[c] : ""))
  }
}')
    fi
    if [ -n "$tr_container" ]; then
      name=$(printf '%s' "$tr_container" | cut -f1); state=$(printf '%s' "$tr_container" | cut -f2); src=container
    else name=traefik; state=$(unit_state traefik traefik); src=service; fi
    alogs=$(existing_logs "$R/var/log/traefik/access.log" "$R/var/log/traefik.log" | paths_json)
    add "$(proxy_entry traefik "$src" "$name" "$state" "" "" "$sites" "" "$alogs" "" "Traefik keeps its certificates in its own store (ACME); its routes come from the containers' labels.")"
  fi
  # A proxy that runs in a container (not Traefik): its configuration is inside it.
  extra=$(printf '%s\n' "$containers" | awk -F'\t' '$3 ~ /(^|\/)(nginx|caddy|haproxy)(:|$)/ { print $2 "\t" $3 "\t" tolower($4) }' | while IFS="$TAB" read -r name image state; do
    kind=$(printf '%s' "$image" | sed 's/.*\///; s/:.*//; s/-.*//')
    proxy_entry "$kind" container "$name" "$state" "" "" "" "" "" "" "It runs in a container: its sites are in the container's own configuration."
    echo
  done | paste -sd, -)
  [ -n "$extra" ] && add "$extra"
  notes=""
  [ "$have_engine" = no ] && [ -n "$EERR" ] && notes=$(printf '%s' "Containers not read: $EERR" | awk "$J"'{printf "%s", js($0)}')
  printf '{"proxies":[%s],"notes":[%s]}\n' "$PX" "$notes"
}

# ── Traffic (ADR-043): the access logs' last lines, never the whole file

TRAFFIC_LINES=5000
WINDOW=15

sample_traffic() {
  if [ $# -eq 0 ]; then
    set -- "$R"/var/log/nginx/*access*.log "$R"/var/log/caddy/*.log "$R"/var/log/haproxy.log "$R"/var/log/traefik/access.log
  fi
  logs=""; n=0
  {
    for f in "$@"; do
      [ -e "$f" ] || ls "$f" 2>&1 | grep -q 'ermission denied' || continue
      n=$((n + 1)); [ $n -le 10 ] || break
      if [ -r "$f" ]; then
        printf 'F\t%s\t\n' "$f"
        tail -n $TRAFFIC_LINES "$f" 2>/dev/null | sed "s/^/L$TAB/"
      else
        printf 'F\t%s\t%s\n' "$f" "$(unreadable "$f")"
      fi
    done
    (ss -tlnH 2>/dev/null || true) | awk '{ n = split($4, a, ":"); print "P\t" a[n] }'
    (ss -tnH state established 2>/dev/null || true) | awk '{ n = split($3, a, ":"); print "E\t" a[n] }'
  } | awk -F'\t' -v nowl="$(date +%Y-%m-%dT%H:%M)" -v nowe="$(date +%s)" -v win=$WINDOW "$J"'
function days(y, m, d) { if (m <= 2) { y--; m += 12 } ; return 365 * y + int(y / 4) - int(y / 100) + int(y / 400) + int((153 * (m - 3) + 2) / 5) + d }
# Minutes since a fixed day, from "03/Oct/2026:18:08" or "2026-10-03T18:08".
function mins(t,   y, m, d) {
  if (t ~ /^[0-9][0-9]\/[A-Z][a-z][a-z]\/[0-9][0-9][0-9][0-9]:[0-9][0-9]:[0-9][0-9]/) {
    d = substr(t, 1, 2) + 0; m = (index("JanFebMarAprMayJunJulAugSepOctNovDec", substr(t, 4, 3)) + 2) / 3; y = substr(t, 8, 4) + 0
    return days(y, m, d) * 1440 + substr(t, 13, 2) * 60 + substr(t, 16, 2)
  }
  if (t ~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9][T ][0-9][0-9]:[0-9][0-9]/)
    return days(substr(t, 1, 4) + 0, substr(t, 6, 2) + 0, substr(t, 9, 2) + 0) * 1440 + substr(t, 12, 2) * 60 + substr(t, 15, 2)
  return -1
}
function top(arr, k, label,   o, i, best, bk, x, used) {
  o = ""
  for (i = 0; i < k; i++) {
    best = 0; bk = ""
    for (x in arr) if (!(x in used) && arr[x] > best) { best = arr[x]; bk = x }
    if (bk == "") break
    used[bk] = 1
    o = o (o == "" ? "" : ",") sprintf("{\"%s\":%s,\"count\":%.0f}", label, js(bk), best)
  }
  return "[" o "]"
}
function jnum(line, key,   r) {
  if (!match(line, "\"" key "\":[0-9.]+")) return ""
  r = substr(line, RSTART, RLENGTH); sub(/^[^:]*:/, "", r); return r
}
function jstr(line, key,   r) {
  if (!match(line, "\"" key "\":\"[^\"]*\"")) return ""
  r = substr(line, RSTART, RLENGTH); sub(/^[^:]*:"/, "", r); sub(/"$/, "", r); return r
}
BEGIN { nowm = mins(nowl); nowj = int(nowe / 60) }
$1 == "F" { logs = logs (logs == "" ? "" : ",") sprintf("{\"path\":%s,\"error\":%s}", js($2), jn($3)); next }
$1 == "P" { listening[$2] = 1; next }
$1 == "E" { if ($2 in listening) conns[$2]++; next }
$1 == "L" {
  line = substr($0, 3); seen++
  if (line ~ /^\{/) {
    # JSON lines (Caddy, Traefik): ts in seconds, status, size, uri, remote_ip.
    ts = jnum(line, "ts"); if (ts == "") { bad++; next }
    ago = nowj - int(ts / 60); status = jnum(line, "status"); bytes = jnum(line, "size")
    if (bytes == "") bytes = jnum(line, "DownstreamContentSize")
    path = jstr(line, "uri"); if (path == "") path = jstr(line, "RequestPath")
    client = jstr(line, "remote_ip"); if (client == "") client = jstr(line, "ClientHost")
  } else {
    # Common and combined formats, and nginx formats with a bracketed time and a quoted request.
    if (!match(line, /\[[^]]+\]/)) { bad++; next }
    t = substr(line, RSTART + 1, RLENGTH - 2); m = mins(t); if (m < 0) { bad++; next }
    ago = nowm - m
    client = ""; if (line !~ /^\[/) { client = line; sub(/[ \t].*/, "", client) }
    rest = substr(line, RSTART + RLENGTH)
    if (!match(rest, /"[^"]*"/)) { bad++; next }
    req = substr(rest, RSTART + 1, RLENGTH - 2); rest = substr(rest, RSTART + RLENGTH)
    k = split(req, rq, " "); path = (k >= 2) ? rq[2] : rq[1]
    split(trim(rest), after, " "); status = after[1]; bytes = after[2]
  }
  if (ago < 0 || ago >= win) next
  sub(/\?.*/, "", path)
  requests++; per[win - 1 - ago]++
  if (bytes ~ /^[0-9]+$/) total += bytes
  if (status ~ /^[1-5][0-9][0-9]$/) { codes[status]++; classes[substr(status, 1, 1) "xx"]++ }
  if (path != "") paths[path]++
  if (client != "" && client != "-") clients[client]++
  next
}
END {
  pm = ""; for (i = 0; i < win; i++) pm = pm (i ? "," : "") sprintf("%.0f", per[i] + 0)
  printf "{\"windowMinutes\":%s,\"logs\":[%s],\"linesRead\":%.0f,\"unparsed\":%.0f,\"requests\":%.0f,\"bytes\":%.0f,\"perMinute\":[%s],", win, logs, seen, bad, requests, total, pm
  printf "\"statuses\":{\"2xx\":%.0f,\"3xx\":%.0f,\"4xx\":%.0f,\"5xx\":%.0f},", classes["2xx"], classes["3xx"], classes["4xx"], classes["5xx"]
  printf "\"codes\":%s,\"paths\":%s,\"clients\":%s,\"connections\":%s}\n", top(codes, 8, "code"), top(paths, 10, "path"), top(clients, 10, "client"), top(conns, 20, "port")
}'
}

# ── Logs (ADR-043): the last lines, a search, or followed until Oraknid closes the channel

fail() { echo "oraknid-monitor: $1" >&2; exit 3; }

# Runs a follower until it ends or Oraknid closes the channel (stdin ends):
# nothing stays running after the screen closes.
follow() {
  exec 3<&0
  "$@" 2>&1 &
  p=$!
  (cat <&3 >/dev/null 2>&1; kill "$p" 2>/dev/null) >/dev/null 2>&1 &
  w=$!
  exec 3<&-
  wait "$p"
  kill "$w" 2>/dev/null
  return 0
}

logs_cmd() {
  [ $# -ge 1 ] || usage
  src=$1; shift
  n=200; f=""; g=""
  while [ $# -gt 0 ]; do
    case "$1" in
      -n) [ $# -ge 2 ] || usage; n=$2; shift 2 ;;
      -f) f=1; shift ;;
      -g) [ $# -ge 2 ] || usage; g=$2; shift 2 ;;
      *) usage ;;
    esac
  done
  case "$n" in ''|*[!0-9]*) n=200 ;; esac
  [ "$n" -gt 5000 ] && n=5000
  kind=$(printf '%s' "$src" | cut -d: -f1)
  name=$(printf '%s' "$src" | cut -d: -f2-)
  case "$kind" in
    unit)
      printf '%s' "$name" | grep -q '^[A-Za-z0-9@_.:-]*$' && [ -n "$name" ] || fail "not a service name: $name"
      command -v journalctl >/dev/null 2>&1 || fail "journalctl isn't here: this system keeps no systemd journal."
      if [ "$ROOT" = no ] && ! id -Gn 2>/dev/null | tr ' ' '\n' | grep -qxE 'systemd-journal|adm|wheel'; then
        echo "oraknid-monitor: $ME sees only its own messages in the journal: add $ME to the systemd-journal group." >&2
      fi
      if [ -n "$f" ]; then follow journalctl -u "$name" --no-pager -o short-iso -n "$n" -f
      elif [ -n "$g" ]; then journalctl -u "$name" --no-pager -o short-iso -n 20000 2>&1 | grep -iF -- "$g" | tail -n "$n"
      else journalctl -u "$name" --no-pager -o short-iso -n "$n" 2>&1; fi ;;
    container)
      printf '%s' "$name" | grep -q '^[A-Za-z0-9][A-Za-z0-9_.-]*$' || fail "not a container name: $name"
      probe_engine || fail "$([ -n "$EERR" ] && echo "$EERR" || echo "neither docker nor podman is here.")"
      if [ -n "$f" ]; then follow $E logs --timestamps --tail "$n" -f "$name"
      elif [ -n "$g" ]; then $E logs --timestamps --tail 20000 "$name" 2>&1 | grep -iF -- "$g" | tail -n "$n"
      else $E logs --timestamps --tail "$n" "$name" 2>&1; fi ;;
    file)
      case "$name" in /*) ;; *) fail "a log file is given by its full path." ;; esac
      case "$name" in *..*) fail "not a log file: $name" ;; esac
      [ -r "$name" ] || fail "$name is $(unreadable "$name")"
      if [ -n "$f" ]; then follow tail -n "$n" -f "$name"
      elif [ -n "$g" ]; then tail -n 20000 "$name" | grep -iF -- "$g" | tail -n "$n"
      else tail -n "$n" "$name"; fi ;;
    *) fail "a log is unit:NAME, container:NAME or file:PATH." ;;
  esac
}

[ $# -ge 1 ] || set -- sample
case "$1" in
  version) echo 2 ;;
  sample)
    [ $# -ge 2 ] || { sample_base; exit 0; }
    part=$2; shift 2
    case "$part" in
      docker) sample_docker ;;
      databases) sample_databases ;;
      proxy) sample_proxy ;;
      traffic) sample_traffic "$@" ;;
      *) usage ;;
    esac ;;
  logs) shift; logs_cmd "$@" ;;
  *) usage ;;
esac
`;

export const MONITOR_HASH = createHash("sha256").update(MONITOR_SCRIPT).digest("hex").slice(0, 16);
