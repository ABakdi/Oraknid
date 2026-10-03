import { type Socket, connect as tcp } from "node:net";
import { type TLSSocket, connect as tlsConnect } from "node:tls";
import type { MailSecurity } from "@oraknid/contracts";

// A small POP3 client (RFC 1939, STLS from RFC 2595) for accounts that
// fetch their mail by POP (ADR-032): log in, list by UIDL, download,
// delete, quit. The maintained npm clients either lack STLS or hand
// messages over as text, which breaks 8-bit mail; this one keeps bytes.

export interface Pop3Options {
  host: string;
  port: number;
  security: MailSecurity;
  user: string;
  pass: string;
  /** No answer for this long ends the connection (default 60 s). */
  timeoutMs?: number;
  /** A message larger than this is refused (default 100 MB). */
  maxBytes?: number;
}

/** What the server answered with -ERR; `authenticationFailed` when it refused the login. */
export class Pop3Error extends Error {
  authenticationFailed = false;
}

const CRLF = Buffer.from("\r\n");

export class Pop3 {
  #socket: Socket | TLSSocket;
  #buf: Buffer = Buffer.alloc(0);
  #wake: (() => void) | null = null;
  #error: Error | null = null;
  #closed = false;

  private constructor(
    socket: Socket | TLSSocket,
    private readonly o: Pop3Options,
  ) {
    this.#socket = socket;
    this.#attach(socket);
  }

  /** Connects, upgrades with STLS when asked, and logs in. */
  static async open(o: Pop3Options): Promise<Pop3> {
    const socket =
      o.security === "tls"
        ? tlsConnect({ host: o.host, port: o.port, servername: o.host })
        : tcp({ host: o.host, port: o.port });
    const pop = new Pop3(socket, o);
    try {
      await pop.#status(); // the greeting
      if (o.security === "starttls") await pop.#startTls();
      try {
        await pop.#command(`USER ${o.user}`);
        await pop.#command(`PASS ${o.pass}`);
      } catch (error) {
        if (error instanceof Pop3Error) error.authenticationFailed = true;
        throw error;
      }
      return pop;
    } catch (error) {
      pop.close();
      throw error;
    }
  }

  #attach(s: Socket | TLSSocket) {
    s.setTimeout(this.o.timeoutMs ?? 60_000, () =>
      s.destroy(new Error(`${this.o.host} stopped answering.`)),
    );
    s.on("data", (d: Buffer) => {
      this.#buf = this.#buf.length ? Buffer.concat([this.#buf, d]) : d;
      this.#wake?.();
    });
    s.on("error", (e) => {
      this.#error = e;
      this.#wake?.();
    });
    s.on("close", () => {
      this.#closed = true;
      this.#wake?.();
    });
  }

  async #startTls() {
    await this.#command("STLS");
    const plain = this.#socket;
    plain.removeAllListeners("data");
    plain.setTimeout(0);
    const secure = tlsConnect({ socket: plain, servername: this.o.host });
    await new Promise<void>((resolve, reject) => {
      secure.once("secureConnect", resolve);
      secure.once("error", reject);
    });
    this.#socket = secure;
    this.#buf = Buffer.alloc(0);
    this.#attach(secure);
  }

  async #line(): Promise<Buffer> {
    for (;;) {
      const i = this.#buf.indexOf(CRLF);
      if (i >= 0) {
        const line = this.#buf.subarray(0, i);
        this.#buf = this.#buf.subarray(i + 2);
        return line;
      }
      if (this.#error) throw this.#error;
      if (this.#closed) throw new Error(`${this.o.host} closed the connection.`);
      await new Promise<void>((r) => {
        this.#wake = r;
      });
      this.#wake = null;
    }
  }

  /** "+OK …" gives its text; "-ERR …" throws it. */
  async #status(): Promise<string> {
    const line = (await this.#line()).toString("utf8");
    if (line.startsWith("+OK")) return line.slice(3).trim();
    throw new Pop3Error(line.replace(/^-ERR\s*/, "").trim() || "The server refused.");
  }

  async #command(line: string): Promise<string> {
    this.#socket.write(`${line}\r\n`);
    return this.#status();
  }

  /** The lines after a +OK, up to the lone ".", unstuffed. */
  async #multiline(): Promise<Buffer> {
    const parts: Buffer[] = [];
    let size = 0;
    const max = this.o.maxBytes ?? 100 * 1024 * 1024;
    for (;;) {
      const line = await this.#line();
      if (line.length === 1 && line[0] === 0x2e) return Buffer.concat(parts, size);
      const body = line[0] === 0x2e ? line.subarray(1) : line;
      size += body.length + 2;
      if (size > max) {
        this.close();
        throw new Error("That message is too large to download.");
      }
      parts.push(body, CRLF);
    }
  }

  /** Every message on the server: its number now, and its lasting id. */
  async uidl(): Promise<{ n: number; uidl: string }[]> {
    await this.#command("UIDL");
    const out: { n: number; uidl: string }[] = [];
    for (const l of (await this.#multiline()).toString("latin1").split("\r\n")) {
      const [n, id] = l.trim().split(/\s+/);
      if (n && id) out.push({ n: Number(n), uidl: id });
    }
    return out;
  }

  /** The message's bytes, as they are. */
  async retr(n: number): Promise<Buffer> {
    await this.#command(`RETR ${n}`);
    return this.#multiline();
  }

  /** Marked for deletion; gone once QUIT is answered. */
  async dele(n: number) {
    await this.#command(`DELE ${n}`);
  }

  /** Ends the session: deletions take effect now. */
  async quit() {
    try {
      await this.#command("QUIT");
    } finally {
      this.close();
    }
  }

  close() {
    this.#socket.destroy();
  }
}
