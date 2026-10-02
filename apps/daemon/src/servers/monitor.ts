import { createHash } from "node:crypto";

// oraknid-monitor (ADR-027): one POSIX shell file on the server, asked for
// one JSON reading over SSH. It reads /proc, df, ss and systemctl; it
// writes nothing and runs nothing in the background.

export const MONITOR_PATH = ".local/bin/oraknid-monitor";

export const MONITOR_SCRIPT = `#!/bin/sh
# oraknid-monitor: one reading of this machine as JSON, for Oraknid.
# Installed by Oraknid; asked over SSH; writes nothing, keeps nothing.
set -u
case "\${1:-sample}" in
  version) echo 1; exit 0 ;;
  sample) ;;
  *) echo "usage: oraknid-monitor [sample|version]" >&2; exit 2 ;;
esac
cpu() { awk '/^cpu /{print $2+$3+$4+$5+$6+$7+$8, $5+$6}' /proc/stat; }
a=$(cpu); sleep 1; b=$(cpu)
cpu_pct=$(printf '%s %s\\n' "$a" "$b" | awk '{t=$3-$1; i=$4-$2; if (t>0) printf "%.1f", (t-i)*100/t; else print 0}')
load1=$(cut -d' ' -f1 /proc/loadavg)
# Plain integers: mawk (Debian's awk) prints big numbers in e-notation, and %d can overflow.
mem_total=$(awk '/^MemTotal:/{printf "%.0f", $2*1024}' /proc/meminfo)
mem_avail=$(awk '/^MemAvailable:/{printf "%.0f", $2*1024}' /proc/meminfo)
mem_used=$(awk -v t="$mem_total" -v a="$mem_avail" 'BEGIN{printf "%.0f", t-a}')
set -- $(df -P -B1 / | awk 'NR==2{print $2, $3}')
disk_total=\${1:-0}; disk_used=\${2:-0}
net=$(awk -F'[: ]+' 'NR>2 && $2!="lo"{rx+=$3; tx+=$11} END{printf "%.0f %.0f", rx, tx}' /proc/net/dev)
rx=\${net% *}; tx=\${net#* }
conns=$( (ss -tnH state established 2>/dev/null || true) | wc -l)
uptime_s=$(cut -d. -f1 /proc/uptime)
json_list() { awk 'BEGIN{printf "["} NF{gsub(/["\\\\]/,""); printf "%s\\"%s\\"", (n++?",":""), $0} END{printf "]"}'; }
services=$( (systemctl list-units --type=service --state=running --no-pager --no-legend 2>/dev/null || true) | awk '{print $1}' | head -60 | json_list)
ports=$( (ss -tlnH 2>/dev/null || true) | awk '{print $4}' | sort -u | head -60 | json_list)
printf '{"cpuPercent":%s,"load1":%s,"memUsed":%s,"memTotal":%s,"diskUsed":%s,"diskTotal":%s,"rxBytes":%s,"txBytes":%s,"connections":%s,"uptimeSec":%s,"services":%s,"ports":%s}\\n' \\
  "$cpu_pct" "$load1" "$mem_used" "$mem_total" "$disk_used" "$disk_total" "$rx" "$tx" "$conns" "$uptime_s" "$services" "$ports"
`;

export const MONITOR_HASH = createHash("sha256").update(MONITOR_SCRIPT).digest("hex").slice(0, 16);
