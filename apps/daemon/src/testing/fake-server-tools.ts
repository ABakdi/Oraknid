import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Stand-in tools of a small server (ADR-043) for the stand-in SSH server:
 * docker with two containers, systemctl, ss, nginx with one site, a
 * journal, and a sudo that wants a password. A restart is written to
 * `$HOME/restarted`; a followed container log writes its pid to
 * `$HOME/follower.pid`. Returns the folder to put before the PATH.
 */
export function fakeServerTools(): string {
  const bin = mkdtempSync(join(tmpdir(), "oraknid-fake-tools-"));
  mkdirSync(bin, { recursive: true });
  const fake = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  fake(
    "docker",
    `case "$1 $2" in
  "version --format") echo 27.0.3 ;;
  "ps -aq") echo aaaaaaaaaaaa; echo bbbbbbbbbbbb ;;
  "ps -q") echo aaaaaaaaaaaa ;;
  "ps -a")
    if [ "$3" = --no-trunc ]; then echo pgdata
    else printf 'aaaaaaaaaaaa\\tweb\\tapp:1\\trunning\\tUp 2 hours (healthy)\\t127.0.0.1:3000->3000/tcp\\tshop\\tweb\\nbbbbbbbbbbbb\\tdb\\tpostgres:16\\trunning\\tUp 2 hours\\t\\tshop\\tdb\\n'
    fi ;;
  "stats --no-stream") printf 'web\\t1.50%%\\t100MiB / 1GiB\\n' ;;
  "inspect --format") echo sha256:cccccccccccc ;;
  "images --format") printf 'app\\t1\\tcccccccccccc\\t120MB\\t2 hours ago\\n' ;;
  "volume ls") printf 'pgdata\\tlocal\\tshop\\n' ;;
  "network ls") printf 'bridge\\tbridge\\tlocal\\n' ;;
  "restart web"|"restart db") echo "$2" >> "$HOME/restarted"; echo "$2" ;;
  "restart "*) echo "Error response from daemon: No such container: $2" >&2; exit 1 ;;
  "logs --timestamps")
    case " $* " in
      *" -f "*) echo $$ > "$HOME/follower.pid"; i=0; while :; do i=$((i+1)); echo "2026-10-03T18:00:00Z tick $i"; sleep 0.1; done ;;
      *) printf '2026-10-03T18:00:00Z \\033[32mready\\033[0m\\n2026-10-03T18:00:01Z GET /health 200\\n2026-10-03T18:00:02Z error: payment failed\\n' ;;
    esac ;;
  *) echo "fake docker: $*" >&2; exit 1 ;;
esac`,
  );
  fake(
    "systemctl",
    `case "$*" in
  *--all*) echo "nginx.service loaded active running nginx" ;;
  *--state=running*) printf '%s\\n' "nginx.service loaded active running nginx" "ssh.service loaded active running ssh" ;;
  "is-active nginx") echo active ;;
  "is-active "*) echo inactive; exit 3 ;;
esac`,
  );
  fake(
    "ss",
    `case "$*" in
  *-tlnH*) echo "LISTEN 0 511 0.0.0.0:443 0.0.0.0:*" ;;
  *established*) echo "0 0 10.0.0.1:443 1.2.3.4:5555" ;;
esac`,
  );
  fake(
    "nginx",
    `case "$1" in
  -T) printf '%s\\n' 'http {' ' server {' '  listen 443 ssl;' '  server_name shop.example.com;' '  location / { proxy_pass http://127.0.0.1:3000; }' ' }' '}' ;;
  -v) echo "nginx version: nginx/1.24.0" >&2 ;;
  -t) echo "nginx: configuration file /etc/nginx/nginx.conf test is successful" >&2 ;;
esac`,
  );
  fake("sudo", 'echo "sudo: a password is required" >&2; exit 1');
  fake("pgrep", "exit 1");
  fake(
    "journalctl",
    `printf '%s\\n' "-- Journal begins at Sun 2026-06-21 05:12:24 UTC. --" "2026-10-03T18:00:00+0000 host nginx[1]: started"`,
  );
  return bin;
}
