import type { Client } from "ssh2";
import { exec } from "./ssh.ts";

// Read-only discovery (ADR-026): a fixed list of commands that only read,
// run by the daemon itself. Each answer is capped; a missing tool is skipped.

const CHECKS: { title: string; command: string }[] = [
  { title: "System", command: "uname -a; cat /etc/os-release 2>/dev/null | head -5; uptime" },
  { title: "CPU and memory", command: "nproc; free -h" },
  { title: "Disks", command: "df -hT -x tmpfs -x devtmpfs -x squashfs -x overlay 2>/dev/null" },
  {
    title: "Running services",
    command:
      "systemctl list-units --type=service --state=running --no-pager --no-legend 2>/dev/null | awk '{print $1}' | head -80",
  },
  {
    title: "Listening ports",
    command: "ss -tlnpH 2>/dev/null | head -60 || netstat -tln 2>/dev/null | head -60",
  },
  {
    title: "Containers",
    command:
      "command -v docker >/dev/null && docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null | head -50",
  },
  {
    title: "Process managers",
    command: "command -v pm2 >/dev/null && pm2 jlist 2>/dev/null | head -c 4000",
  },
  {
    title: "Web server sites",
    command:
      'for d in /etc/nginx/sites-enabled /etc/nginx/conf.d /etc/apache2/sites-enabled /etc/caddy; do [ -d "$d" ] && echo "## $d" && ls "$d"; done; grep -rhoE \'server_name[^;]+\' /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null | sort -u | head -40; [ -f /etc/caddy/Caddyfile ] && grep -E \'^[^ #].*\\{\' /etc/caddy/Caddyfile | head -40',
  },
  {
    title: "Databases",
    command:
      'for p in postgres mysqld mariadbd mongod redis-server; do pgrep -x "$p" >/dev/null && echo "$p running"; done',
  },
  {
    title: "Scheduled jobs",
    command: "crontab -l 2>/dev/null | grep -v '^#' | head -30; ls /etc/cron.d 2>/dev/null",
  },
  {
    title: "Main folders",
    command:
      'for d in /srv /var/www /opt "$HOME"; do [ -d "$d" ] && echo "## $d" && ls -1 "$d" 2>/dev/null | head -40; done',
  },
];

/** What the server is, as the read-only commands print it, in markdown. */
export async function discover(client: Client): Promise<string> {
  const parts: string[] = [];
  for (const c of CHECKS) {
    try {
      const r = await exec(client, c.command, { timeoutMs: 30_000, cap: 8_000 });
      const out = r.stdout.trim();
      if (out) parts.push(`## ${c.title}\n\`\`\`\n${out.slice(0, 8_000)}\n\`\`\``);
    } catch (error) {
      parts.push(
        `## ${c.title}\n(not read: ${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
  return parts.join("\n\n");
}
