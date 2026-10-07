import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isProduction } from "@oraknid/contracts";
import { jobHomeDir } from "../legs/job-home.ts";
import type { JobServerRef } from "./remote.ts";
import type { Servers } from "./service.ts";

/**
 * A job's servers for one Leg's sessions (ADR-026): a way in from the job's
 * own home on the Leg (an SSH alias, its key, the pinned host key), and their
 * state documents for the context. The servers it reaches are added to
 * `into`, as its commands name them; the text for the context is returned.
 */
export async function serversForLeg(
  d: { servers?: Servers; legsDir: string },
  job: {
    id: string;
    serverIds?: string[];
    serverRoles?: Record<string, { role: string; production: boolean | null }>;
    server?: string | null;
    serverJob?: string | null;
  },
  legId: string,
  into: JobServerRef[],
): Promise<string> {
  // In the job's own home on the Leg (Audit 2, S2-08): another job running
  // on it never sees these keys. Emptied at every attempt all the same.
  const ssh = join(jobHomeDir(d.legsDir, legId, job.id), ".ssh");
  mkdirSync(dirname(ssh), { recursive: true, mode: 0o700 });
  rmSync(ssh, { recursive: true, force: true });
  if (!d.servers || !job.serverIds?.length) return "";
  mkdirSync(ssh, { recursive: true, mode: 0o700 });
  const config: string[] = [];
  const known: string[] = [];
  const docs: string[] = [];
  for (const id of job.serverIds) {
    // Its role in the project (ADR-042): what it is for, and production said loud.
    const r = job.serverRoles?.[id];
    const role = r?.role ? ` — ${r.role}` : "";
    const prod = isProduction(r) ? " (production: what runs there is live)" : "";
    const chosen = job.server === id ? " — **the server for this job's work**" : "";
    try {
      const s = await d.servers.forLeg(id);
      const keyFile = join(ssh, s.alias);
      writeFileSync(keyFile, s.privateKey.endsWith("\n") ? s.privateKey : `${s.privateKey}\n`, {
        mode: 0o600,
      });
      config.push(
        `Host ${s.alias}\n  HostName ${s.host}\n  Port ${s.port}\n  User ${s.user}\n  IdentityFile ${keyFile}\n  IdentitiesOnly yes\n  StrictHostKeyChecking yes\n  UserKnownHostsFile ${join(ssh, "oraknid_known_hosts")}`,
      );
      if (s.knownHost) known.push(s.knownHost);
      into.push({ id, name: s.name, alias: s.alias, production: isProduction(r) });
      docs.push(`## ${s.name}${role}${prod}${chosen} — \`ssh ${s.alias}\`\n\n${s.state}`);
    } catch (error) {
      let name = "a server";
      try {
        name = d.servers.row(id).name;
      } catch {}
      docs.push(
        `## ${name}${role}${prod}${chosen} (this job can't reach it: ${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
  writeFileSync(join(ssh, "config"), `${config.join("\n\n")}\n`, { mode: 0o600 });
  writeFileSync(join(ssh, "oraknid_known_hosts"), `${known.join("\n")}\n`, { mode: 0o600 });
  const named = job.server && job.server !== "none" ? job.serverIds.includes(job.server) : false;
  // ssh reads its config from the account's home, never $HOME: the alias is named with -F (ADR-049).
  const cfg = join(ssh, "config");
  const own = job.serverJob ? into.find((x) => x.id === job.serverJob) : undefined;
  return `# Servers this job may use\n\nReach each with its alias (\`ssh <alias>\`, \`scp\`, \`rsync\`). Read its state document first: it says what runs there and what must not break. Change only what the task needs; anything else on the server is not yours.${named ? " Work meant for a server (a deploy) goes to the one marked as this job's, and to no other." : ""}\n\nThe aliases are in \`${cfg}\`, which ssh reads only when it is named: \`ssh -F <that file> <alias> '<command>'\` (\`scp -F\` and \`rsync -e "ssh -F …"\` the same way). Put the command run there in one pair of quotes with nothing after it on the line, \`sudo -n\` inside them when it needs root. Every command on a server goes through Oraknid's approvals; on a production server every change asks the owner first. A change the approved plan names that Oraknid's rules block on their own is asked of the owner at once: wait for it. For any other block the task can't do without, say in your last message which command and why: the owner is asked. The task's checks are Oraknid's, run over its own connection: never make one pass another way (a file of your own standing in for a program); if one is wrong, say why and finish.${
    own
      ? `\n\n**This job's place is the server ${own.name}** (\`${own.alias}\`), not a repo: the workspace is a scratch folder for notes and scripts, and the work is done on the server. When the task is done, list in your last message what you changed on the server, a line each.`
      : ""
  }\n\n${docs.join("\n\n")}`;
}
