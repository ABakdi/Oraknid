import type { VerifyResult } from "../eye/verify.ts";
import { signatureOf } from "../eye/verify.ts";
import { type JobServerRef, parseSsh, readsOnly } from "./remote.ts";

// A check on one of a job's servers (ADR-049): `ssh <alias> <command>`,
// run by Oraknid itself over its own connection, with the host key it
// pinned, never from the sandbox. A check only reads; on production a
// check that could change something is refused, never run.

const TAIL = 8000;

export async function runServerCheck(
  command: string,
  o: {
    servers: JobServerRef[];
    run: (
      serverId: string,
      remote: string,
    ) => Promise<{ code: number | null; stdout: string; stderr: string }>;
    /** This computer's policy on the command, as for any check: a refusal, or null. */
    refuse?: (command: string) => string | null;
  },
): Promise<VerifyResult | null> {
  const ssh = parseSsh(
    command,
    o.servers.map((s) => s.alias),
  );
  if (!ssh) return null;
  const server = o.servers.find((s) => s.alias === ssh.alias) as JobServerRef;
  const started = Date.now();
  const done = (ok: boolean, exitCode: number | null, output: string): VerifyResult => {
    const out = output.slice(-TAIL);
    return {
      command,
      ok,
      exitCode,
      output: out,
      signature: ok ? null : signatureOf(command, out),
      ms: Date.now() - started,
    };
  };
  if (!ssh.remote) return done(false, null, `Give the command to run on ${server.name}.`);
  const refused =
    server.production && !readsOnly(ssh.remote)
      ? `${server.name} is production and a check only reads there`
      : (o.refuse?.(command) ?? null);
  if (refused) return done(false, null, `Oraknid did not run this check: ${refused}.`);
  try {
    const r = await o.run(server.id, ssh.remote);
    return done(r.code === 0, r.code, `${r.stdout}${r.stderr}`);
  } catch (error) {
    return done(
      false,
      null,
      `Couldn't run it on ${server.name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
