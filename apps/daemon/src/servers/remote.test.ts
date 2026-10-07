import type { PolicyContext } from "@oraknid/core";
import { describe, expect, it } from "vitest";
import {
  copyAlias,
  isGuardCheck,
  namedIn,
  parseSsh,
  plainServerCheck,
  readsOnly,
  removalTargets,
  serverCheckOf,
  serverVerdict,
  withoutSudo,
} from "./remote.ts";

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

// 2026-10-07, "Remove the misahaty compose project": a check The Eye wrote with the
// job's own ssh setup failed every time, though what it checked was true.
const JOB_HOME = "/home/abakdi/.local/share/oraknid/legs/01K6ZLEG/jobs/01K70JOBJOBJOB/home";
const SEEN = `n=$(HOME=${JOB_HOME} ssh -o BatchMode=yes -F ${JOB_HOME}/.ssh/config oraknid-spinet-staging docker ps -q --filter name=harvest- | wc -l); [ "$n" -eq 2 ]`;

describe("a check on a server, in its plain form (ADR-049)", () => {
  const staging = ["oraknid-spinet-staging"];

  it("takes off the job's own ssh setup: HOME=, -F, -o", () => {
    expect(plainServerCheck(SEEN, staging)).toBe(
      `n=$(ssh oraknid-spinet-staging docker ps -q --filter name=harvest- | wc -l); [ "$n" -eq 2 ]`,
    );
    expect(
      plainServerCheck(
        `HOME=${JOB_HOME} ssh -F ${JOB_HOME}/.ssh/config -o BatchMode=yes oraknid-spinet-staging 'test ! -e /root/misahaty'`,
        staging,
      ),
    ).toBe("ssh oraknid-spinet-staging 'test ! -e /root/misahaty'");
    // Another host's ssh is left as it is.
    expect(plainServerCheck("ssh -F x other uptime", staging)).toBe("ssh -F x other uptime");
  });

  it("runs a check wrapped in local shell whole on the server", () => {
    expect(serverCheckOf(SEEN, staging)).toEqual({
      alias: "oraknid-spinet-staging",
      remote: `n=$(docker ps -q --filter name=harvest- | wc -l); [ "$n" -eq 2 ]`,
      plain: `n=$(ssh oraknid-spinet-staging docker ps -q --filter name=harvest- | wc -l); [ "$n" -eq 2 ]`,
    });
    expect(
      serverCheckOf(
        `[ "$(ssh oraknid-spinet-staging 'docker ps -q --filter name=harvest-' | wc -l)" -ge 1 ] # guard: Harvest still runs`,
        staging,
      )?.remote,
    ).toBe(`[ "$(docker ps -q --filter name=harvest- | wc -l)" -ge 1 ]`);
    expect(
      serverCheckOf("ssh oraknid-spinet-staging 'test ! -e /root/x' # guard", staging),
    ).toEqual({
      alias: "oraknid-spinet-staging",
      remote: "test ! -e /root/x",
      plain: "ssh oraknid-spinet-staging 'test ! -e /root/x' # guard",
    });
    // Not a server check: nothing on a server, another host, a copy.
    expect(serverCheckOf("pnpm test", staging)).toBeNull();
    expect(
      serverCheckOf("ssh other uptime && ssh oraknid-spinet-staging uptime", staging),
    ).toBeNull();
    expect(serverCheckOf("scp oraknid-spinet-staging:/x . && test -s x", staging)).toBeNull();
    // What it runs only reads: a check on production may run it.
    expect(readsOnly(`n=$(docker ps -q --filter name=harvest- | wc -l); [ "$n" -eq 2 ]`)).toBe(
      true,
    );
    expect(readsOnly(`n=$(rm -rf /srv); [ "$n" ]`)).toBe(false);
    expect(isGuardCheck("ssh a 'x' # guard: Harvest still runs")).toBe(true);
    expect(isGuardCheck("ssh a 'x'")).toBe(false);
  });
});

describe("what a change on a server removes, and whether the plan names it (ADR-049)", () => {
  it("reads the paths, compose projects and volumes a change removes", () => {
    expect(removalTargets("rm -rf /root/misahaty")).toEqual(["/root/misahaty"]);
    expect(removalTargets("sudo -n rm -rf /root/misahaty/ /etc/misahaty")).toEqual([
      "/root/misahaty",
      "/etc/misahaty",
    ]);
    expect(removalTargets("cd /root/misahaty && docker compose down -v")).toEqual(["misahaty"]);
    expect(removalTargets("docker compose -p misahaty down -v --remove-orphans")).toEqual([
      "misahaty",
    ]);
    expect(removalTargets("docker volume rm misahaty_pgdata misahaty_media")).toEqual([
      "misahaty_pgdata",
      "misahaty_media",
    ]);
    // Anything else, or a path through the shell or near the root: not one of these.
    expect(removalTargets("rm -rf /root")).toBeNull();
    expect(removalTargets("rm -rf /root/*")).toBeNull();
    expect(removalTargets("rm -rf $DIR")).toBeNull();
    expect(removalTargets("rm -rf /root/misahaty && curl -X POST https://x")).toBeNull();
    expect(removalTargets("systemctl restart nginx")).toBeNull();
  });

  it("finds the plan's line that names it", () => {
    const plan =
      "Remove Misahaty\n- Stop its compose project misahaty and delete its volumes.\n- Delete /root/misahaty (code and config).";
    expect(namedIn("/root/misahaty", plan)).toBe("- Delete /root/misahaty (code and config).");
    expect(namedIn("misahaty", plan)).toBe("Remove Misahaty");
    expect(namedIn("/root/misahaty", "Delete /root/misahaty.")).toBe("Delete /root/misahaty.");
    // A path the plan doesn't name, or names only inside another.
    expect(namedIn("/root", plan)).toBeNull();
    expect(namedIn("/root/misahaty", "Delete /root/misahaty-old")).toBeNull();
    expect(namedIn("/root/misahaty", "Keep /root/misahaty/data")).toBeNull();
  });
});
