import { createHash } from "node:crypto";
import ssh2, { type Client, type ClientChannel } from "ssh2";

// ssh2 is CommonJS: its named exports come through its default one.
const { Client: SshClient, utils } = ssh2;

// SSH from the daemon (ADR-026): the ssh2 library, no ssh binary. A
// server's host key is pinned at the first connection; a different one
// is refused until I accept it.

export interface Target {
  host: string;
  port: number;
  user: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  /** The pinned fingerprint; null on the first connection. */
  hostKey: string | null;
}

/** A server presenting another host key than the pinned one: a plain error the API shows as is. */
export type HostKeyChanged = Error & { offered: string };

export function hostKeyChanged(offered: string): HostKeyChanged {
  return Object.assign(
    new Error(
      `The server's host key changed (now ${offered}). Nothing connects until you accept it on the Servers page.`,
    ),
    { offered },
  );
}

export const isHostKeyChanged = (e: unknown): e is HostKeyChanged =>
  e instanceof Error && typeof (e as { offered?: unknown }).offered === "string";

export const fingerprint = (key: Buffer) =>
  `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;

/** Connects, checking the host key; returns the client and the key it presented. */
export function connect(
  t: Target,
  timeoutMs = 20_000,
): Promise<{ client: Client; fingerprint: string; keyLine: string }> {
  return new Promise((resolve, reject) => {
    const client = new SshClient();
    let seen = "";
    let keyLine = "";
    let changed = false;
    client
      .on("ready", () => resolve({ client, fingerprint: seen, keyLine }))
      .on("error", (e) => reject(changed ? hostKeyChanged(seen) : e))
      .connect({
        host: t.host,
        port: t.port,
        username: t.user,
        ...(t.password ? { password: t.password } : {}),
        ...(t.privateKey ? { privateKey: t.privateKey } : {}),
        ...(t.passphrase ? { passphrase: t.passphrase } : {}),
        readyTimeout: timeoutMs,
        keepaliveInterval: 30_000,
        hostVerifier: (key: Buffer) => {
          seen = fingerprint(key);
          // The wire format starts with the key's type, as a length-prefixed string.
          const type = key.subarray(4, 4 + key.readUInt32BE(0)).toString();
          keyLine = `${type} ${key.toString("base64")}`;
          if (t.hostKey === null || t.hostKey === seen) return true;
          changed = true;
          return false;
        },
      });
  });
}

/**
 * Why a server couldn't be reached over SSH, in plain words: for the
 * backups' checks and Test connection (Servers → Testing the connection).
 */
export function sshWords(
  error: unknown,
  srv: { name: string; host: string; port: number; user: string } | null,
): string {
  const m = error instanceof Error ? error.message : String(error);
  const code = (error as NodeJS.ErrnoException | undefined)?.code ?? "";
  if (!srv) return m;
  const at = `${srv.host}:${srv.port}`;
  // The key itself, before anything goes on the wire.
  if (/no passphrase given/i.test(m))
    return "This private key has a passphrase: type it under the key.";
  if (/bad passphrase|integrity check failed|Failed to decrypt/i.test(m))
    return "The passphrase doesn't open this private key.";
  if (
    /does not contain a \(valid\) private key|Unsupported key format|Cannot parse privateKey/i.test(
      m,
    )
  )
    return "That isn't a private key Oraknid can read: give the private one (not the .pub), in OpenSSH or PEM format.";
  if (code === "ECONNREFUSED" || /ECONNREFUSED/.test(m))
    return `${srv.name} (${at}) refused the connection: is SSH running there, on that port?`;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || /getaddrinfo/.test(m))
    return `There's no host "${srv.host}": check ${srv.name}'s address.`;
  if (/Timed out|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|took too long/i.test(`${code} ${m}`))
    return `${srv.name} (${at}) gave no answer: it may be off, or a firewall is in the way.`;
  if (/authentication methods failed/i.test(m))
    return `${srv.name} refused the SSH login of ${srv.user}: check the server's key or password.`;
  if (/host key/i.test(m)) return `${m} (Servers → ${srv.name}).`;
  return `${srv.name} couldn't be reached over SSH: ${m}`;
}

/** One command; its exit code and output (each capped). */
export function exec(
  client: Client,
  command: string,
  o: { stdin?: string; timeoutMs?: number; cap?: number } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const cap = o.cap ?? 256 * 1024;
  return new Promise((resolve, reject) => {
    client.exec(command, (err, ch: ClientChannel) => {
      if (err) return reject(err);
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        ch.close();
        reject(new Error(`"${command.slice(0, 60)}" took too long.`));
      }, o.timeoutMs ?? 60_000);
      ch.on("data", (d: Buffer) => {
        if (stdout.length < cap) stdout += d.toString();
      });
      ch.stderr.on("data", (d: Buffer) => {
        if (stderr.length < cap) stderr += d.toString();
      });
      ch.on("close", (code: number | null) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
      if (o.stdin !== undefined) ch.end(o.stdin);
      else ch.end();
    });
  });
}

/**
 * One command whose output streams (backups, ADR-044): its channel to
 * read from and write to, and its end with the exit code and the last of
 * its stderr.
 */
export function execStream(
  client: Client,
  command: string,
): Promise<{ channel: ClientChannel; done: Promise<{ code: number | null; stderr: string }> }> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, channel: ClientChannel) => {
      if (err) return reject(err);
      let stderr = "";
      channel.stderr.on("data", (d: Buffer) => {
        stderr = (stderr + d.toString()).slice(-16 * 1024);
      });
      const done = new Promise<{ code: number | null; stderr: string }>((r) => {
        let code: number | null = null;
        channel.on("exit", (c: number | null) => {
          code = c;
        });
        channel.on("close", (c?: number | null) => r({ code: code ?? c ?? null, stderr }));
      });
      resolve({ channel, done });
    });
  });
}

/**
 * A key pair Oraknid makes for one server (ADR-026), in OpenSSH format.
 * ssh2 writes about one ed25519 key in two hundred malformed (a key whose
 * first byte is zero comes out 31 bytes long; seen 2026-10-04, 27 in 5,000),
 * and such a key can't be read back to connect: each is read back here, and
 * one that doesn't parse is made again.
 */
export function newKeyPair(comment?: string): { privateKey: string; publicKey: string } {
  for (let tries = 0; ; tries++) {
    const k = comment
      ? utils.generateKeyPairSync("ed25519", { comment })
      : utils.generateKeyPairSync("ed25519");
    const priv = utils.parseKey(k.private);
    const pub = utils.parseKey(k.public);
    if (!(priv instanceof Error) && !(pub instanceof Error))
      return { privateKey: k.private, publicKey: k.public.trim() };
    if (tries >= 20) throw new Error("Couldn't make a readable SSH key.");
  }
}

/** A shell-safe single-quoted string. */
export const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
