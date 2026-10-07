import { createHash } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { SMTPServer } from "smtp-server";

// A stand-in mail provider for tests (ADR-032): an IMAP server just big
// enough for imapflow (select, fetch, search, store, copy/move, append,
// expunge, IDLE), a POP3 server on the same INBOX (as Gmail and Outlook
// offer), and an SMTP server, sharing one mailbox. Plain TCP on
// 127.0.0.1, one account. Gmail mode adds X-GM-EXT-1 (thread ids,
// labels) and, like Gmail, files what goes out through SMTP in Sent.

export interface FakeMessage {
  uid: number;
  flags: Set<string>;
  raw: Buffer;
  internalDate: Date;
  labels: Set<string>;
  thrid: string;
  msgid: string;
}

interface Box {
  path: string;
  specialUse: string | null;
  uidValidity: number;
  uidNext: number;
  messages: FakeMessage[];
}

type Token = string | Buffer | Token[];

const CRLF = "\r\n";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export async function fakeMail(
  o: {
    user?: string;
    password?: string;
    /** Accepts XOAUTH2 with this token as well as the password (ADR-063). */
    accessToken?: string;
    gmail?: boolean;
  } = {},
) {
  const user = o.user ?? "me@example.com";
  const state: { password: string; accessToken?: string | null } = {
    password: o.password ?? "app-password",
    accessToken: o.accessToken ?? null,
  };
  const gmail = o.gmail ?? false;
  const boxes = new Map<string, Box>();
  const addBox = (path: string, specialUse: string | null) =>
    boxes.set(path, { path, specialUse, uidValidity: 1000 + boxes.size, uidNext: 1, messages: [] });
  addBox("INBOX", null);
  if (gmail) {
    addBox("[Gmail]/Sent Mail", "\\Sent");
    addBox("[Gmail]/Drafts", "\\Drafts");
    addBox("[Gmail]/Trash", "\\Trash");
    addBox("[Gmail]/Spam", "\\Junk");
    addBox("[Gmail]/All Mail", "\\All");
  } else {
    addBox("Sent", "\\Sent");
    addBox("Drafts", "\\Drafts");
    addBox("Trash", "\\Trash");
    addBox("Junk", "\\Junk");
    addBox("Archive", "\\Archive");
  }
  const sessions = new Set<ImapSession>();
  const commands: string[] = [];
  let nextGmId = 1000n;

  const box = (path: string) => {
    const b = boxes.get(path.toUpperCase() === "INBOX" ? "INBOX" : path);
    if (!b) throw new ImapNo(`[NONEXISTENT] No mailbox ${path}`);
    return b;
  };

  /** Like Gmail: a conversation's id from the first message it refers to. */
  const thridOf = (raw: Buffer) => {
    const h = headerBlock(raw);
    const refs = (field(h, "references") ?? "").match(/<[^>]+>/g) ?? [];
    const root = refs[0] ?? field(h, "in-reply-to")?.trim() ?? field(h, "message-id")?.trim() ?? "";
    return BigInt(`0x${createHash("sha1").update(root).digest("hex").slice(0, 15)}`).toString();
  };

  const add = (path: string, raw: Buffer | string, flags: string[] = [], date = new Date()) => {
    const b = box(path);
    const data = typeof raw === "string" ? Buffer.from(raw.replace(/\r?\n/g, CRLF)) : raw;
    const m: FakeMessage = {
      uid: b.uidNext++,
      flags: new Set(flags),
      raw: data,
      internalDate: date,
      labels: new Set(),
      thrid: thridOf(data),
      msgid: String(nextGmId++),
    };
    b.messages.push(m);
    for (const s of sessions) s.changed(b.path);
    return m.uid;
  };

  const changed = (path: string) => {
    for (const s of sessions) s.changed(path);
  };

  const imap: Server = createServer((socket) => {
    const s = new ImapSession(socket, {
      user,
      state,
      gmail,
      boxes,
      box,
      add,
      changed,
      commands,
      sessions,
    });
    sessions.add(s);
    socket.on("close", () => sessions.delete(s));
    socket.on("error", () => {});
  });
  await new Promise<void>((r) => imap.listen(0, "127.0.0.1", r));

  // POP3 on INBOX, as Gmail and Outlook offer it beside IMAP.
  const popCommands: string[] = [];
  const pop: Server = createServer((socket) => {
    popSession(socket, { user, state, inbox: () => box("INBOX"), changed, commands: popCommands });
    socket.on("error", () => {});
  });
  const popSockets = new Set<Socket>();
  pop.on("connection", (s) => {
    popSockets.add(s);
    s.on("close", () => popSockets.delete(s));
  });
  await new Promise<void>((r) => pop.listen(0, "127.0.0.1", r));

  // SMTP: what is sent is kept; Gmail files it in Sent itself.
  const sent: { from: string; to: string[]; raw: Buffer }[] = [];
  const smtp = new SMTPServer({
    secure: false,
    disabledCommands: ["STARTTLS"],
    authMethods: ["PLAIN", "LOGIN", "XOAUTH2"],
    allowInsecureAuth: true,
    logger: false,
    onAuth(auth, _session, cb) {
      const ok =
        auth.username === user &&
        (auth.method === "XOAUTH2"
          ? !!state.accessToken && auth.accessToken === state.accessToken
          : auth.password === state.password);
      if (ok) return cb(null, { user });
      cb(new Error("Invalid username or password"));
    },
    onData(stream, session, cb) {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => {
        const raw = Buffer.concat(chunks);
        sent.push({
          from: session.envelope.mailFrom ? session.envelope.mailFrom.address : "",
          to: session.envelope.rcptTo.map((r) => r.address),
          raw,
        });
        if (gmail) add("[Gmail]/Sent Mail", raw, ["\\Seen"]);
        cb();
      });
    },
  });
  await new Promise<void>((r) => smtp.listen(0, "127.0.0.1", () => r()));

  return {
    user,
    imapPort: (imap.address() as { port: number }).port,
    popPort: (pop.address() as { port: number }).port,
    /** The POP3 commands received, passwords left out. */
    popCommands,
    smtpPort: (smtp.server.address() as { port: number }).port,
    boxes,
    sent,
    commands,
    /** A message arriving in a folder (INBOX by default). Returns its UID. */
    deliver: (raw: string | Buffer, path = "INBOX", flags: string[] = []) => add(path, raw, flags),
    messages: (path = "INBOX") => box(path).messages,
    /** Like a password changed at the provider. */
    setPassword(p: string) {
      state.password = p;
    },
    /** The access token the provider now accepts (null: none, as when it is revoked). */
    setAccessToken(t: string | null) {
      state.accessToken = t;
    },
    /** Every connection dropped, as when the provider restarts. */
    dropConnections() {
      for (const s of sessions) s.socket.destroy();
      for (const s of popSockets) s.destroy();
    },
    close: async () => {
      for (const s of sessions) s.socket.destroy();
      for (const s of popSockets) s.destroy();
      await Promise.all([
        new Promise<void>((r) => imap.close(() => r())),
        new Promise<void>((r) => pop.close(() => r())),
        new Promise<void>((r) => smtp.close(() => r())),
      ]);
    },
  };
}

export type FakeMail = Awaited<ReturnType<typeof fakeMail>>;

/**
 * One POP3 session (RFC 1939): the maildrop as it was at login, numbered
 * from 1; DELE marks, QUIT deletes. A UIDL is the folder's UIDVALIDITY
 * and the message's UID, so it never changes.
 */
function popSession(
  socket: Socket,
  x: {
    user: string;
    state: { password: string };
    inbox: () => Box;
    changed: (path: string) => void;
    commands: string[];
  },
) {
  let buf = "";
  let given: string | null = null;
  let drop: FakeMessage[] | null = null;
  const deleted = new Set<number>();
  const send = (l: string | Buffer) => {
    if (!socket.destroyed) socket.write(typeof l === "string" ? l + CRLF : l);
  };
  const lines = (ls: string[]) => send(`+OK\r\n${ls.map((l) => l + CRLF).join("")}.`);
  const at = (arg: string | undefined) => {
    const n = Number(arg);
    const m = drop?.[n - 1];
    if (!m || deleted.has(n)) throw new Error("no such message");
    return { n, m };
  };
  const handle = (line: string) => {
    const [cmd = "", ...args] = line.split(" ");
    const name = cmd.toUpperCase();
    x.commands.push(name === "PASS" ? "PASS ***" : [name, ...args].join(" "));
    if (name === "QUIT") {
      if (drop) {
        const b = x.inbox();
        const gone = new Set([...deleted].map((n) => drop?.[n - 1]));
        b.messages = b.messages.filter((m) => !gone.has(m));
        if (gone.size) x.changed(b.path);
      }
      send("+OK bye");
      socket.end();
      return;
    }
    if (name === "CAPA") return lines(["USER", "UIDL", "TOP"]);
    if (name === "NOOP") return send("+OK");
    if (!drop) {
      if (name === "USER") {
        given = args.join(" ");
        return send("+OK send PASS");
      }
      if (name === "PASS") {
        if (given !== x.user || args.join(" ") !== x.state.password)
          return send("-ERR [AUTH] Username and password not accepted.");
        drop = [...x.inbox().messages];
        return send(`+OK ${drop.length} messages`);
      }
      return send("-ERR log in first");
    }
    const live = () =>
      drop?.map((m, i) => ({ n: i + 1, m })).filter((e) => !deleted.has(e.n)) ?? [];
    try {
      if (name === "STAT") {
        const l = live();
        return send(`+OK ${l.length} ${l.reduce((s, e) => s + e.m.raw.length, 0)}`);
      }
      if (name === "LIST") {
        if (args[0]) {
          const { n, m } = at(args[0]);
          return send(`+OK ${n} ${m.raw.length}`);
        }
        return lines(live().map((e) => `${e.n} ${e.m.raw.length}`));
      }
      if (name === "UIDL") {
        const uidl = (m: FakeMessage) => `${x.inbox().uidValidity}-${m.uid}`;
        if (args[0]) {
          const { n, m } = at(args[0]);
          return send(`+OK ${n} ${uidl(m)}`);
        }
        return lines(live().map((e) => `${e.n} ${uidl(e.m)}`));
      }
      if (name === "RETR") {
        const { m } = at(args[0]);
        const text = m.raw.toString("latin1");
        const stuffed = text
          .split(CRLF)
          .map((l) => (l.startsWith(".") ? `.${l}` : l))
          .join(CRLF);
        send(`+OK ${m.raw.length} octets`);
        send(Buffer.from(stuffed.endsWith(CRLF) ? stuffed : stuffed + CRLF, "latin1"));
        return send(".");
      }
      if (name === "DELE") {
        const { n } = at(args[0]);
        deleted.add(n);
        return send(`+OK message ${n} deleted`);
      }
      if (name === "RSET") {
        deleted.clear();
        return send("+OK");
      }
      send("-ERR unknown command");
    } catch (error) {
      send(`-ERR ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  socket.on("data", (d: Buffer) => {
    buf += d.toString("latin1");
    let i = buf.indexOf(CRLF);
    while (i >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      handle(line);
      i = buf.indexOf(CRLF);
    }
  });
  send("+OK fake POP3 ready");
}

class ImapNo extends Error {}
class ImapBad extends Error {}

interface Shared {
  user: string;
  state: { password: string; accessToken?: string | null };
  gmail: boolean;
  boxes: Map<string, Box>;
  box: (path: string) => Box;
  add: (path: string, raw: Buffer, flags?: string[], date?: Date) => number;
  changed: (path: string) => void;
  commands: string[];
  sessions: Set<ImapSession>;
}

class ImapSession {
  #buf = Buffer.alloc(0);
  #authed = false;
  #selected: Box | null = null;
  #readOnly = false;
  /** The UIDs this session was told about, in sequence order. */
  #known: number[] = [];
  #idleTag: string | null = null;
  /** A command waiting for its literal's bytes. */
  #pending: { text: string; literals: Buffer[]; need: number } | null = null;
  #chain: Promise<void> = Promise.resolve();

  constructor(
    readonly socket: Socket,
    private readonly x: Shared,
  ) {
    socket.on("data", (d: Buffer) => {
      this.#buf = Buffer.concat([this.#buf, d]);
      this.#drain();
    });
    this.#send(`* OK fake IMAP ready`);
  }

  #send(line: string | Buffer) {
    if (!this.socket.destroyed) this.socket.write(typeof line === "string" ? line + CRLF : line);
  }

  #caps() {
    const caps = ["IMAP4rev1", "IDLE", "MOVE", "UIDPLUS", "SPECIAL-USE", "LITERAL+"];
    if (this.x.state.accessToken) caps.push("AUTH=XOAUTH2", "SASL-IR");
    if (this.x.gmail) caps.push("X-GM-EXT-1");
    return caps.join(" ");
  }

  /** Splits the stream into commands, honouring literals ({n} and {n+}). */
  #drain() {
    for (;;) {
      if (this.#pending && this.#pending.need > 0) {
        if (this.#buf.length < this.#pending.need) return;
        this.#pending.literals.push(this.#buf.subarray(0, this.#pending.need));
        this.#buf = this.#buf.subarray(this.#pending.need);
        this.#pending.need = 0;
      }
      const end = this.#buf.indexOf(CRLF);
      if (end < 0) return;
      const line = this.#buf.subarray(0, end).toString("utf8");
      this.#buf = this.#buf.subarray(end + 2);
      const pending = this.#pending ?? { text: "", literals: [], need: 0 };
      const lit = line.match(/\{(\d+)(\+)?\}$/);
      if (lit) {
        pending.text += `${line.slice(0, lit.index)}\u0000${pending.literals.length}\u0000`;
        pending.need = Number(lit[1]);
        this.#pending = pending;
        if (!lit[2]) this.#send("+ go ahead");
        continue;
      }
      pending.text += line;
      this.#pending = null;
      const { text, literals } = pending;
      this.#chain = this.#chain.then(() => this.#handle(text, literals)).catch(() => {});
    }
  }

  async #handle(text: string, literals: Buffer[]) {
    if (this.#idleTag) {
      if (text.trim().toUpperCase() === "DONE") {
        const tag = this.#idleTag;
        this.#idleTag = null;
        this.#send(`${tag} OK IDLE terminated`);
      }
      return;
    }
    const sp = text.indexOf(" ");
    const tag = sp < 0 ? text : text.slice(0, sp);
    let rest = sp < 0 ? "" : text.slice(sp + 1);
    let name = rest.split(" ")[0]?.toUpperCase() ?? "";
    rest = rest.slice(name.length).trimStart();
    let uid = false;
    if (name === "UID") {
      uid = true;
      name = rest.split(" ")[0]?.toUpperCase() ?? "";
      rest = rest.slice(name.length).trimStart();
    }
    this.x.commands.push(`${uid ? "UID " : ""}${name}`);
    const args = tokenize(rest, literals);
    try {
      const note = await this.#run(tag, name, uid, args);
      if (note === null) return;
      this.#flush();
      this.#send(`${tag} OK ${note || `${name} completed`}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.#send(`${tag} ${error instanceof ImapNo ? "NO" : "BAD"} ${msg}`);
    }
  }

  /** Tells this session what changed in its mailbox: expunges, then the new count. */
  #flush() {
    const b = this.#selected;
    if (!b) return;
    const now = b.messages.map((m) => m.uid);
    const alive = new Set(now);
    for (let i = this.#known.length - 1; i >= 0; i--) {
      if (!alive.has(this.#known[i] as number)) {
        this.#send(`* ${i + 1} EXPUNGE`);
        this.#known.splice(i, 1);
      }
    }
    if (now.length !== this.#known.length) {
      this.#known = now;
      this.#send(`* ${now.length} EXISTS`);
    }
  }

  changed(path: string) {
    if (this.#selected?.path === path && this.#idleTag) this.#flush();
  }

  /** null: the command answers on its own (IDLE). Otherwise the OK's text. */
  async #run(tag: string, name: string, uid: boolean, args: Token[]): Promise<string | null> {
    const str = (t: Token | undefined) =>
      Buffer.isBuffer(t) ? t.toString("utf8") : String(t ?? "");
    if (name === "CAPABILITY") {
      this.#send(`* CAPABILITY ${this.#caps()}`);
      return "";
    }
    if (name === "NOOP") return "";
    if (name === "LOGOUT") {
      this.#send("* BYE bye");
      this.#send(`${tag} OK LOGOUT completed`);
      this.socket.end();
      return null;
    }
    if (name === "LOGIN") {
      if (str(args[0]) !== this.x.user || str(args[1]) !== this.x.state.password)
        throw new ImapNo("[AUTHENTICATIONFAILED] Invalid credentials (Failure)");
      this.#authed = true;
      return `[CAPABILITY ${this.#caps()}] Logged in`;
    }
    // XOAUTH2 with the initial response (SASL-IR): "user=<u>^Aauth=Bearer <token>^A^A".
    if (name === "AUTHENTICATE") {
      const token = Buffer.from(str(args[1]), "base64").toString("utf8");
      const [u, b] = token.split("\u0001");
      if (
        str(args[0]).toUpperCase() !== "XOAUTH2" ||
        u?.replace(/^user=/, "") !== this.x.user ||
        !this.x.state.accessToken ||
        b?.replace(/^auth=Bearer /, "") !== this.x.state.accessToken
      )
        throw new ImapNo("[AUTHENTICATIONFAILED] Invalid credentials (Failure)");
      this.#authed = true;
      return `[CAPABILITY ${this.#caps()}] Authenticated`;
    }
    if (!this.#authed) throw new ImapBad("Log in first");

    if (name === "ENABLE" || name === "ID" || name === "NAMESPACE") return "";
    if (name === "LIST" || name === "LSUB" || name === "XLIST") {
      const pattern = str(args[1]);
      for (const b of this.x.boxes.values()) {
        if (pattern !== "*" && pattern !== "%" && pattern !== b.path) continue;
        const flags = ["\\HasNoChildren", ...(b.specialUse ? [b.specialUse] : [])];
        this.#send(`* ${name} (${flags.join(" ")}) "/" ${quote(b.path)}`);
      }
      return "";
    }
    if (name === "STATUS") {
      const b = this.x.box(str(args[0]));
      const items = (args[1] as Token[]).map((t) => str(t).toUpperCase());
      const values: Record<string, number> = {
        MESSAGES: b.messages.length,
        UIDNEXT: b.uidNext,
        UIDVALIDITY: b.uidValidity,
        UNSEEN: b.messages.filter((m) => !m.flags.has("\\Seen")).length,
        RECENT: 0,
      };
      this.#send(
        `* STATUS ${quote(b.path)} (${items
          .filter((i) => i in values)
          .map((i) => `${i} ${values[i]}`)
          .join(" ")})`,
      );
      return "";
    }
    if (name === "CREATE") {
      const path = str(args[0]);
      if (this.x.boxes.has(path)) throw new ImapNo("[ALREADYEXISTS] Mailbox exists");
      this.x.boxes.set(path, {
        path,
        specialUse: null,
        uidValidity: 2000 + this.x.boxes.size,
        uidNext: 1,
        messages: [],
      });
      return "";
    }
    if (name === "SELECT" || name === "EXAMINE") {
      const b = this.x.box(str(args[0]));
      this.#selected = b;
      this.#readOnly = name === "EXAMINE";
      this.#known = b.messages.map((m) => m.uid);
      this.#send("* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)");
      this.#send("* OK [PERMANENTFLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft \\*)] ok");
      this.#send(`* ${b.messages.length} EXISTS`);
      this.#send("* 0 RECENT");
      this.#send(`* OK [UIDVALIDITY ${b.uidValidity}] ok`);
      this.#send(`* OK [UIDNEXT ${b.uidNext}] ok`);
      return `[${this.#readOnly ? "READ-ONLY" : "READ-WRITE"}] ${name} completed`;
    }
    if (name === "APPEND") {
      const b = this.x.box(str(args[0]));
      let i = 1;
      let flags: string[] = [];
      if (Array.isArray(args[i])) flags = (args[i++] as Token[]).map(str);
      let date = new Date();
      if (typeof args[i] === "string" && !Buffer.isBuffer(args[i]) && args.length > i + 1)
        date = new Date(str(args[i++]).replace(/^(\d+)-(\w+)-(\d+)/, "$2 $1 $3"));
      const raw = args[i];
      if (!Buffer.isBuffer(raw)) throw new ImapBad("No message");
      const newUid = this.x.add(
        b.path,
        raw,
        flags,
        Number.isNaN(date.getTime()) ? new Date() : date,
      );
      return `[APPENDUID ${b.uidValidity} ${newUid}] APPEND completed`;
    }
    if (name === "IDLE") {
      this.#idleTag = tag;
      this.#send("+ idling");
      this.#flush();
      return null;
    }

    const b = this.#selected;
    if (!b) throw new ImapBad("Select a mailbox first");
    if (name === "CLOSE" || name === "UNSELECT") {
      if (name === "CLOSE" && !this.#readOnly)
        b.messages = b.messages.filter((m) => !m.flags.has("\\Deleted"));
      this.#selected = null;
      this.#known = [];
      this.x.changed(b.path);
      return "";
    }
    const pick = (set: string) => this.#resolve(b, set, uid);
    if (name === "FETCH") {
      const items = Array.isArray(args[1]) ? (args[1] as Token[]) : [args[1] as Token];
      for (const m of pick(str(args[0]))) this.#fetchOne(b, m, items.map(str), uid);
      return "";
    }
    if (name === "STORE") {
      const op = str(args[1]).toUpperCase();
      const values = (Array.isArray(args[2]) ? (args[2] as Token[]) : [args[2] as Token]).map(str);
      const labels = op.includes("X-GM-LABELS");
      for (const m of pick(str(args[0]))) {
        const target = labels ? m.labels : m.flags;
        if (op.startsWith("+")) for (const v of values) target.add(v);
        else if (op.startsWith("-")) for (const v of values) target.delete(v);
        else {
          target.clear();
          for (const v of values) target.add(v);
        }
        if (!op.endsWith(".SILENT"))
          this.#fetchOne(b, m, labels ? ["X-GM-LABELS"] : ["FLAGS"], uid);
      }
      return "";
    }
    if (name === "SEARCH") {
      const found = b.messages.filter((m) => matches(m, b, args, this.#known));
      this.#send(
        `* SEARCH${found.map((m) => ` ${uid ? m.uid : this.#known.indexOf(m.uid) + 1}`).join("")}`,
      );
      return "";
    }
    if (name === "COPY" || name === "MOVE") {
      const dest = this.x.box(str(args[1]));
      const moving = pick(str(args[0]));
      const newUids: number[] = [];
      for (const m of moving)
        newUids.push(this.x.add(dest.path, m.raw, [...m.flags], m.internalDate));
      for (const [i, m] of moving.entries()) {
        const copy = dest.messages.find((d) => d.uid === newUids[i]);
        if (copy) copy.thrid = m.thrid;
      }
      const code = `[COPYUID ${dest.uidValidity} ${moving.map((m) => m.uid).join(",")} ${newUids.join(",")}]`;
      if (name === "COPY") return `${code} COPY completed`;
      this.#send(`* OK ${code} moved`);
      const gone = new Set(moving);
      b.messages = b.messages.filter((m) => !gone.has(m));
      this.#flush();
      this.x.changed(b.path);
      return "MOVE completed";
    }
    if (name === "EXPUNGE") {
      const only = uid ? new Set(pick(str(args[0]))) : null;
      b.messages = b.messages.filter((m) => !(m.flags.has("\\Deleted") && (!only || only.has(m))));
      this.#flush();
      this.x.changed(b.path);
      return "";
    }
    throw new ImapBad(`Unknown command ${name}`);
  }

  #resolve(b: Box, set: string, uid: boolean): FakeMessage[] {
    const out: FakeMessage[] = [];
    const max = uid ? (b.messages.at(-1)?.uid ?? 0) : this.#known.length;
    for (const part of set.split(",")) {
      const [a, z = a] = part.split(":");
      const lo = a === "*" ? max : Number(a);
      const hi = z === "*" ? max : Number(z);
      const [from, to] = lo <= hi ? [lo, hi] : [hi, lo];
      for (const m of b.messages) {
        const n = uid ? m.uid : this.#known.indexOf(m.uid) + 1;
        if (n >= from && n <= to && !out.includes(m)) out.push(m);
      }
    }
    return out;
  }

  #fetchOne(_b: Box, m: FakeMessage, items: string[], uid: boolean) {
    const seq = this.#known.indexOf(m.uid) + 1;
    if (seq < 1) return;
    const parts: (string | Buffer)[] = [];
    const want = new Set(items.map((i) => i.toUpperCase()));
    if (uid || want.has("UID")) parts.push(`UID ${m.uid}`);
    for (const raw of items) {
      const item = raw.toUpperCase();
      if (item === "UID") continue;
      if (item === "FLAGS") parts.push(`FLAGS (${[...m.flags].join(" ")})`);
      else if (item === "INTERNALDATE") parts.push(`INTERNALDATE "${imapDate(m.internalDate)}"`);
      else if (item === "RFC822.SIZE") parts.push(`RFC822.SIZE ${m.raw.length}`);
      else if (item === "X-GM-THRID" && this.x.gmail) parts.push(`X-GM-THRID ${m.thrid}`);
      else if (item === "X-GM-MSGID" && this.x.gmail) parts.push(`X-GM-MSGID ${m.msgid}`);
      else if (item === "X-GM-LABELS" && this.x.gmail)
        parts.push(`X-GM-LABELS (${[...m.labels].map(quote).join(" ")})`);
      else if (item.startsWith("BODY[") || item.startsWith("BODY.PEEK[")) {
        const section = raw.slice(raw.indexOf("[") + 1, raw.lastIndexOf("]"));
        const data = sectionOf(m.raw, section);
        if (!item.startsWith("BODY.PEEK") && !this.#readOnly && !m.flags.has("\\Seen")) {
          m.flags.add("\\Seen");
          parts.push(`FLAGS (${[...m.flags].join(" ")})`);
        }
        parts.push(Buffer.concat([Buffer.from(`BODY[${section}] {${data.length}}${CRLF}`), data]));
      }
    }
    const chunks: Buffer[] = [Buffer.from(`* ${seq} FETCH (`)];
    parts.forEach((p, i) => {
      if (i) chunks.push(Buffer.from(" "));
      chunks.push(Buffer.isBuffer(p) ? p : Buffer.from(p));
    });
    chunks.push(Buffer.from(`)${CRLF}`));
    this.#send(Buffer.concat(chunks));
  }
}

/** Atoms, quoted strings, literals and (lists); `BODY[...]` stays one atom. */
function tokenize(text: string, literals: Buffer[]): Token[] {
  const stack: Token[][] = [[]];
  let i = 0;
  const top = () => stack[stack.length - 1] as Token[];
  while (i < text.length) {
    const c = text[i] as string;
    if (c === " ") {
      i++;
    } else if (c === "(") {
      const list: Token[] = [];
      top().push(list);
      stack.push(list);
      i++;
    } else if (c === ")") {
      stack.pop();
      i++;
    } else if (c === '"') {
      let s = "";
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\") i++;
        s += text[i];
        i++;
      }
      i++;
      top().push(s);
    } else if (c === "\u0000") {
      const end = text.indexOf("\u0000", i + 1);
      top().push(literals[Number(text.slice(i + 1, end))] as Buffer);
      i = end + 1;
    } else {
      let s = "";
      let depth = 0;
      while (i < text.length) {
        const ch = text[i] as string;
        if (ch === "[") depth++;
        if (ch === "]") depth--;
        if (depth === 0 && (ch === " " || ch === "(" || ch === ")")) break;
        s += ch;
        i++;
      }
      top().push(s);
    }
  }
  return stack[0] as Token[];
}

function quote(s: string) {
  return `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function imapDate(d: Date) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

function headerBlock(raw: Buffer): string {
  const s = raw.toString("utf8");
  const end = s.indexOf("\r\n\r\n");
  return end < 0 ? s : s.slice(0, end + 2);
}

function field(header: string, name: string): string | undefined {
  const re = new RegExp(`^${name}:([^\\r\\n]*(?:\\r\\n[ \\t][^\\r\\n]*)*)`, "im");
  return header
    .match(re)?.[1]
    ?.replace(/\r\n[ \t]/g, " ")
    .trim();
}

function sectionOf(raw: Buffer, section: string): Buffer {
  const s = raw.toString("utf8");
  const end = s.indexOf("\r\n\r\n");
  const header = end < 0 ? s : s.slice(0, end + 2);
  const sec = section.toUpperCase();
  if (sec === "") return raw;
  if (sec === "HEADER") return Buffer.from(`${header}\r\n`);
  if (sec === "TEXT") return Buffer.from(end < 0 ? "" : s.slice(end + 4));
  const fields = section.match(/HEADER\.FIELDS\s*\(([^)]*)\)/i);
  if (fields) {
    const wanted = new Set((fields[1] ?? "").split(/\s+/).map((f) => f.toLowerCase()));
    const lines = header.split("\r\n");
    const out: string[] = [];
    let keep = false;
    for (const l of lines) {
      if (/^[ \t]/.test(l)) {
        if (keep) out.push(l);
        continue;
      }
      keep = wanted.has(l.split(":")[0]?.toLowerCase() ?? "");
      if (keep) out.push(l);
    }
    return Buffer.from(`${out.join("\r\n")}\r\n\r\n`);
  }
  return Buffer.alloc(0);
}

/** A SEARCH program, every key ANDed; OR, NOT and (groups) as in RFC 3501. */
function matches(m: FakeMessage, b: Box, keys: Token[], known: number[]): boolean {
  const str = (t: Token | undefined) => (Buffer.isBuffer(t) ? t.toString("utf8") : String(t ?? ""));
  const text = () => m.raw.toString("utf8").toLowerCase();
  const header = () => headerBlock(m.raw);
  let i = 0;
  const one = (): boolean => {
    const t = keys[i++];
    if (Array.isArray(t)) return matches(m, b, t, known);
    const k = str(t).toUpperCase();
    const has = (f: string) => m.flags.has(f);
    switch (k) {
      case "ALL":
        return true;
      case "SEEN":
        return has("\\Seen");
      case "UNSEEN":
        return !has("\\Seen");
      case "FLAGGED":
        return has("\\Flagged");
      case "UNFLAGGED":
        return !has("\\Flagged");
      case "DELETED":
        return has("\\Deleted");
      case "UNDELETED":
        return !has("\\Deleted");
      case "ANSWERED":
        return has("\\Answered");
      case "TEXT":
      case "BODY":
        return text().includes(str(keys[i++]).toLowerCase());
      case "SUBJECT":
      case "FROM":
      case "TO":
      case "CC":
        return (field(header(), k.toLowerCase()) ?? "")
          .toLowerCase()
          .includes(str(keys[i++]).toLowerCase());
      case "HEADER": {
        const name = str(keys[i++]);
        return (field(header(), name) ?? "").toLowerCase().includes(str(keys[i++]).toLowerCase());
      }
      case "SINCE":
      case "BEFORE":
      case "ON":
        i++;
        return true;
      case "X-GM-RAW":
        return text().includes(str(keys[i++]).toLowerCase());
      case "UID": {
        const set = str(keys[i++]);
        const max = b.messages.at(-1)?.uid ?? 0;
        return set.split(",").some((part) => {
          const [a, z = a] = part.split(":");
          const lo = a === "*" ? max : Number(a);
          const hi = z === "*" ? max : Number(z);
          return m.uid >= Math.min(lo, hi) && m.uid <= Math.max(lo, hi);
        });
      }
      case "NOT":
        return !one();
      case "OR": {
        const a = one();
        const c = one();
        return a || c;
      }
      default: {
        // A sequence set.
        if (/^[\d*:,]+$/.test(k)) {
          const seq = known.indexOf(m.uid) + 1;
          return k.split(",").some((part) => {
            const [a, z = a] = part.split(":");
            const lo = a === "*" ? known.length : Number(a);
            const hi = z === "*" ? known.length : Number(z);
            return seq >= Math.min(lo, hi) && seq <= Math.max(lo, hi);
          });
        }
        return true;
      }
    }
  };
  let ok = true;
  while (i < keys.length) if (!one()) ok = false;
  return ok;
}
