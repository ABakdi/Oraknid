import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ssh2 from "ssh2";
import { newKeyPair } from "../servers/ssh.ts";

const { Server, utils } = ssh2;

/**
 * A stand-in SSH server for tests (ADR-026): commands run with `sh` in a
 * throwaway home; it takes a password, or a key listed in that home's
 * authorized_keys, as a real sshd would.
 */
export async function fakeSsh(
  o: {
    password?: string;
    hostKey?: string;
    /** Stand-in tools put before the PATH (docker, systemctl…), and their environment. */
    path?: string;
    env?: Record<string, string>;
  } = {},
) {
  const home = mkdtempSync(join(tmpdir(), "oraknid-fake-ssh-home-"));
  const hostKey = o.hostKey ?? newKeyPair().privateKey;
  const commands: string[] = [];
  const clients = new Set<{ end(): void }>();
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    clients.add(client);
    // A client refusing the host key ends the exchange: nothing to report.
    client.on("error", () => {});
    client.on("close", () => clients.delete(client));
    client.on("authentication", (ctx) => {
      if (ctx.method === "password" && o.password && ctx.password === o.password)
        return ctx.accept();
      if (ctx.method === "publickey") {
        const file = join(home, ".ssh", "authorized_keys");
        const lines = existsSync(file)
          ? readFileSync(file, "utf8").split("\n").filter(Boolean)
          : [];
        const ok = lines.some((l) => {
          const k = utils.parseKey(l);
          return !(k instanceof Error) && k.getPublicSSH().equals(ctx.key.data);
        });
        if (ok) return ctx.accept();
      }
      ctx.reject(["password", "publickey"]);
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("exec", (acceptExec, _reject, info) => {
          const ch = acceptExec();
          commands.push(info.command);
          const child = spawn("sh", ["-c", info.command], {
            cwd: home,
            env: {
              PATH: `${o.path ? `${o.path}:` : ""}${process.env.PATH ?? "/usr/bin:/bin"}`,
              HOME: home,
              ...o.env,
            },
          });
          ch.on("data", (d: Buffer) => child.stdin.write(d));
          ch.on("end", () => child.stdin.end());
          child.stdout.on("data", (d) => ch.write(d));
          child.stderr.on("data", (d) => ch.stderr.write(d));
          child.on("close", (code) => {
            ch.exit(code ?? 1);
            ch.end();
          });
        });
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    home,
    hostKey,
    commands,
    port: (server.address() as { port: number }).port,
    // Like a server going down: its connections end too.
    close: () =>
      new Promise<void>((r) => {
        for (const c of clients) c.end();
        server.close(() => r());
      }),
  };
}
