import type { PolicyContext } from "@oraknid/core";
import { describe, expect, it } from "vitest";
import { copyAlias, parseSsh, readsOnly, serverVerdict, withoutSudo } from "./remote.ts";

const aliases = ["oraknid-vps"];

describe("a command on a server (ADR-049)", () => {
  it("reads an ssh to one of the job's aliases: its options, the command run there, quoted or not", () => {
    expect(parseSsh("ssh oraknid-vps systemctl is-active fail2ban", aliases)).toEqual({
      alias: "oraknid-vps",
      remote: "systemctl is-active fail2ban",
      whole: true,
    });
    expect(
      parseSsh(
        "ssh -F /x/home/.ssh/config -o BatchMode=yes oraknid-vps 'sudo -n nginx -t'",
        aliases,
      ),
    ).toEqual({ alias: "oraknid-vps", remote: "sudo -n nginx -t", whole: true });
    expect(parseSsh("ssh me@oraknid-vps uptime", aliases)?.alias).toBe("oraknid-vps");
    // Something after it on the line runs here: not the whole line.
    expect(parseSsh("ssh oraknid-vps cat /etc/x | sudo tee /etc/y", aliases)?.whole).toBe(false);
    expect(parseSsh("ssh other-host uptime", aliases)).toBeNull();
    expect(parseSsh("sshd -t", aliases)).toBeNull();
    expect(copyAlias("scp ./jail.local oraknid-vps:/tmp/", aliases)).toBe("oraknid-vps");
    expect(copyAlias("cp a b", aliases)).toBeNull();
  });

  it("tells what only reads from what may change", () => {
    for (const reads of [
      "systemctl status nginx",
      "sudo -n systemctl is-active fail2ban",
      "journalctl -u nginx -n 200 --no-pager | grep 502",
      "sudo nginx -t",
      "docker ps -a && docker logs web --tail 50",
      "tail -n 100 /var/log/nginx/error.log 2>&1",
      "cat /etc/nginx/sites-enabled/x.com > /dev/null",
      "fail2ban-client status sshd",
      "curl -sf http://localhost/health",
    ])
      expect(readsOnly(reads), reads).toBe(true);
    for (const changes of [
      "sudo apt-get install -y fail2ban",
      "systemctl restart nginx",
      "docker restart web",
      "echo x > /etc/motd",
      "sed -i 's/a/b/' /etc/nginx/nginx.conf",
      "find /var/log -name '*.gz' -delete",
      "curl -X POST http://localhost/admin",
      "rm -f /tmp/x",
      "bash -c 'uptime'",
      "",
    ])
      expect(readsOnly(changes), changes).toBe(false);
    expect(withoutSudo("sudo -n -u postgres psql -l && sudo systemctl reload nginx")).toBe(
      "psql -l && systemctl reload nginx",
    );
  });

  it("judges it as what runs there: root there isn't refused, production asks before a change", () => {
    const policy: PolicyContext = {
      worktree: "/tmp/w",
      autonomy: "full",
      waived: new Set(),
    };
    const vps = { id: "s1", name: "VPS", alias: "oraknid-vps", production: false };
    // Here sudo is never allowed; on the server it is the server's business.
    expect(
      serverVerdict("ssh oraknid-vps 'sudo -n systemctl reload nginx'", [vps], policy),
    ).toMatchObject({ verdict: "judge" });
    // Still never allowed whatever the server: a fork bomb, a local sudo after the ssh.
    expect(serverVerdict("ssh oraknid-vps 'shutdown -h now'", [vps], policy)?.verdict).toBe("deny");
    expect(
      serverVerdict("ssh oraknid-vps cat /etc/x | sudo tee /etc/y", [vps], policy)?.verdict,
    ).toBe("deny");
    const prod = { ...vps, production: true };
    expect(
      serverVerdict("ssh oraknid-vps 'sudo -n systemctl reload nginx'", [prod], policy),
    ).toEqual({
      verdict: "ask",
      reason: "it may change VPS, which is production",
      gated: null,
    });
    expect(
      serverVerdict("scp jail.local oraknid-vps:/etc/fail2ban/", [prod], policy)?.verdict,
    ).toBe("ask");
    // Reading production is the usual policy's.
    expect(serverVerdict("ssh oraknid-vps systemctl status nginx", [prod], policy)?.verdict).toBe(
      "judge",
    );
    expect(serverVerdict("ls -la", [prod], policy)).toBeNull();
  });
});
