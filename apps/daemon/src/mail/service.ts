import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  MailAccountView,
  MailCompose,
  MailDraftView,
  MailFolderView,
  MailMessageView,
  MailProtocol,
  MailSecurity,
  MailThreadPage,
  MailThreadSummary,
  NewMailAccount,
} from "@oraknid/contracts";
import { choiceQuestion } from "@oraknid/contracts";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { ImapFlow, type ImapFlowOptions } from "imapflow";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type { Db } from "../db/open.ts";
import {
  jobs,
  mailAccounts,
  mailDrafts,
  mailFolders,
  mailImageSenders,
  mailMessages,
  mailPopUidls,
} from "../db/schema.ts";
import type { EventBus } from "../events/bus.ts";
import { newId } from "../ids.ts";
import type { InboxStore } from "../inbox/store.ts";
import type { Secrets } from "../os/secrets.ts";
import { detectServers, explain } from "./diagnose.ts";
import { fetchImages, remoteImages } from "./images.ts";
import {
  escapeHtml,
  HEADER_FIELDS,
  htmlToText,
  parseBody,
  parseHeaders,
  snippetOf,
} from "./parse.ts";
import { Pop3 } from "./pop3.ts";

// My mail (ADR-032): accounts over IMAP or POP3, and SMTP, synced into
// SQLite by the daemon itself. IMAP: INBOX is watched with IDLE, a pass
// every few minutes catches the other folders, and what I do (read, star,
// move, archive, delete) is done on the server first, so other clients
// see it. POP3: new mail is downloaded into a local Inbox every two
// minutes, and its folders and flags are Oraknid's own.

export type AccountRow = typeof mailAccounts.$inferSelect;
type MessageRow = typeof mailMessages.$inferSelect;
type FolderRow = typeof mailFolders.$inferSelect;
type DraftRow = typeof mailDrafts.$inferSelect;

/** Who asked: me in the UI, or an agent through the email tool (then its job, for the audit). */
export type Actor =
  | { kind: "owner"; device?: string | null }
  | { kind: "agent"; jobId: string | null };

const PASSWORD = (id: string) => `mail.${id}.password`;

/** Gmail and Outlook as they are (with an app password); any other server as I describe it. */
const PRESETS: Record<"gmail" | "outlook", Preset> = {
  gmail: {
    imap: { host: "imap.gmail.com", port: 993, security: "tls" },
    pop: { host: "pop.gmail.com", port: 995, security: "tls" },
    smtp: { host: "smtp.gmail.com", port: 465, security: "tls" },
    // Gmail files what goes through its SMTP in Sent Mail itself.
    appendSent: false,
  },
  outlook: {
    imap: { host: "outlook.office365.com", port: 993, security: "tls" },
    pop: { host: "outlook.office365.com", port: 995, security: "tls" },
    smtp: { host: "smtp.office365.com", port: 587, security: "starttls" },
    appendSent: false,
  },
};

/** A POP account's folders, all kept here: the server only has the inbox. */
const LOCAL_FOLDERS = [
  { path: "INBOX", name: "INBOX", specialUse: "\\Inbox" },
  { path: "Drafts", name: "Drafts", specialUse: "\\Drafts" },
  { path: "Sent", name: "Sent", specialUse: "\\Sent" },
  { path: "Archive", name: "Archive", specialUse: "\\Archive" },
  { path: "Trash", name: "Trash", specialUse: "\\Trash" },
];

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
/** How long checking an account waits for each server before saying so. */
const CHECK_MS = 20_000;
const SEEN = "\\Seen";
const FLAGGED = "\\Flagged";
const APPROVE = "Send";
const REFUSE = "Don't send";

export interface MailOptions {
  db: Db;
  bus: EventBus;
  secrets: Secrets;
  inbox: InboxStore;
  /** Where drafts' attachments wait (mail/drafts/<id>/), and POP accounts' messages (mail/local/<account>/). */
  dataDir: string;
  now?: () => number;
  /** The domain's MX records, for finding an address's servers (tests give their own). */
  resolveMx?: (domain: string) => Promise<{ exchange: string }[]>;
  /** Between passes over every folder (default five minutes). */
  syncEveryMs?: number;
  /** Between checks of a POP account (default two minutes). */
  popEveryMs?: number;
  /** How soon the INBOX connection goes back to IDLE after a command. */
  idleDelayMs?: number;
  /** The most messages fetched per folder the first time. */
  initialLimit?: number;
  /** Called once there is an account: the email tool is registered then. */
  hasAccounts?: () => void;
  /** Gmail's and Outlook's servers, for tests against a stand-in. */
  presets?: Partial<Record<"gmail" | "outlook", Preset>>;
}

type Server = { host: string; port: number; security: MailSecurity };
type Preset = { imap: Server; pop: Server; smtp: Server; appendSent: boolean };

interface Link {
  stopped: boolean;
  worker: ImapFlow | null;
  watcher: ImapFlow | null;
  timer: NodeJS.Timeout | undefined;
  retry: NodeJS.Timeout | undefined;
  failures: number;
  /** One pass at a time per account. */
  queue: Promise<unknown>;
  /** INBOX changed while a pass ran: another one follows. */
  again: boolean;
}

/** A login the server refused: only I can fix it, so nothing retries until I do. */
class NeedsReconnect extends Error {}

export class MailService {
  readonly #links = new Map<string, Link>();
  #unsubscribe: (() => void) | undefined;

  constructor(private readonly o: MailOptions) {}

  #now() {
    return this.o.now?.() ?? Date.now();
  }

  #preset(p: "gmail" | "outlook"): Preset {
    return this.o.presets?.[p] ?? PRESETS[p];
  }

  get db() {
    return this.o.db;
  }

  #publish(type: string, payload: Record<string, unknown>, actor?: Actor) {
    this.o.bus.publish({
      type,
      topic: "mail",
      jobId: actor?.kind === "agent" ? actor.jobId : null,
      payload,
      actor: actor?.kind ?? "oraknid",
    });
  }

  /** Every agent action on mail goes to the audit log (ADR-032). */
  #audit(actor: Actor, action: string, payload: Record<string, unknown>) {
    if (actor.kind === "agent") this.#publish(`mail.agent.${action}`, payload, actor);
  }

  /** Connects every account, answers approvals, and settles sends a crash interrupted. */
  start() {
    // OAuth app secrets saved before sign-in by OAuth was taken out (ADR-032 → Changed after building).
    for (const p of ["google", "microsoft"])
      void this.o.secrets.delete(`mail.oauth.${p}.secret`).catch(() => {});
    // At most once (BR-6): a send caught mid-way may have gone out; I check Sent before retrying.
    this.o.db
      .update(mailDrafts)
      .set({
        state: "failed",
        error: "Oraknid stopped while sending this: check Sent before you send it again.",
      })
      .where(eq(mailDrafts.state, "sending"))
      .run();
    this.#unsubscribe?.();
    const off = this.o.bus.subscribe((e) => {
      if (e.type !== "inbox.answered") return;
      const { id, answer } = e.payload as { id: string; answer: string };
      const draft = this.o.db
        .select()
        .from(mailDrafts)
        .where(eq(mailDrafts.approvalItemId, id))
        .get();
      if (draft?.state !== "waiting") return;
      if (answer === APPROVE)
        void this.#send(draft.id, { kind: "owner" }).catch((err) =>
          console.error("mail send failed", err),
        );
      else this.#refused(draft.id);
    });
    this.#unsubscribe = off;
    const all = this.o.db.select().from(mailAccounts).all();
    if (all.length) this.o.hasAccounts?.();
    for (const a of all) if (a.state !== "reconnect") this.#open(a.id);
  }

  async stop() {
    this.#unsubscribe?.();
    for (const id of [...this.#links.keys()]) await this.#close(id);
  }

  // ── Accounts ──────────────────────────────────────────────────────────

  account(id: string): AccountRow {
    const r = this.o.db.select().from(mailAccounts).where(eq(mailAccounts.id, id)).get();
    if (!r) throw new Error(`No mail account ${id}.`);
    return r;
  }

  view(a: AccountRow): MailAccountView {
    const inbox = this.o.db
      .select({ id: mailFolders.id })
      .from(mailFolders)
      .where(and(eq(mailFolders.accountId, a.id), eq(mailFolders.path, "INBOX")))
      .get();
    return {
      id: a.id,
      name: a.name,
      email: a.email,
      provider: a.provider,
      protocol: a.protocol,
      incomingHost: a.incomingHost,
      smtpHost: a.smtpHost,
      autoSend: a.autoSend,
      appendSent: a.appendSent,
      deleteFromServer: a.deleteFromServer,
      state: a.state,
      error: a.error,
      lastSyncAt: a.lastSyncAt,
      unread: inbox ? this.#counts(inbox.id).unread : 0,
      createdAt: a.createdAt,
    };
  }

  accounts(): MailAccountView[] {
    return this.o.db
      .select()
      .from(mailAccounts)
      .orderBy(asc(mailAccounts.createdAt))
      .all()
      .map((a) => this.view(a));
  }

  /** An account's row from what I typed or its provider's preset, not saved yet. */
  #newRow(input: NewMailAccount): { row: AccountRow; protocol: MailProtocol } {
    const protocol = input.protocol ?? "imap";
    const preset = input.provider === "imap" ? null : this.#preset(input.provider);
    const incoming = protocol === "pop" ? (preset?.pop ?? input.pop) : (preset?.imap ?? input.imap);
    const smtp = preset?.smtp ?? input.smtp;
    if (!incoming || !smtp)
      throw new Error(
        `Give the ${protocol === "pop" ? "POP3" : "IMAP"} and SMTP servers of this account.`,
      );
    for (const s of [incoming, smtp])
      if (s.security === "plain" && !LOOPBACK.has(s.host))
        throw new Error(
          `${s.host} without TLS would send the password in clear: use TLS or STARTTLS.`,
        );
    const email = input.email.trim().toLowerCase();
    const id = newId(this.#now());
    const row: AccountRow = {
      id,
      name: input.name.trim() || email,
      email,
      provider: input.provider,
      protocol,
      login: input.login?.trim() || email,
      incomingHost: incoming.host,
      incomingPort: incoming.port,
      incomingSecurity: incoming.security as MailSecurity,
      smtpHost: smtp.host,
      smtpPort: smtp.port,
      smtpSecurity: smtp.security as MailSecurity,
      autoSend: false,
      // POP has no Sent on the server: what I send is filed in Oraknid's own.
      appendSent: protocol === "pop" ? true : (preset?.appendSent ?? true),
      deleteFromServer: protocol === "pop" && (input.deleteFromServer ?? false),
      state: "new",
      error: null,
      lastSyncAt: null,
      createdAt: this.#now(),
    };
    return { row, protocol };
  }

  /** Checks the incoming server and SMTP each on its own, for the form's Test: nothing is saved. */
  async testAccount(input: NewMailAccount): Promise<{
    incoming: { ok: boolean; message: string };
    smtp: { ok: boolean; message: string };
  }> {
    const { row } = this.#newRow(input);
    const run = async (check: () => Promise<void>, ok: string) => {
      try {
        await check();
        return { ok: true, message: ok };
      } catch (error) {
        console.error(`mail: testing ${row.email}: ${(error as Error).message}`);
        return { ok: false, message: (error as Error).message };
      }
    };
    const [incoming, smtp] = await Promise.all([
      run(
        () => this.#checkIncoming(row, input.password),
        `${row.protocol === "pop" ? "POP3" : "IMAP"} (${row.incomingHost}) accepted the login.`,
      ),
      run(() => this.#checkSmtp(row, input.password), `SMTP (${row.smtpHost}) accepted the login.`),
    ]);
    return { incoming, smtp };
  }

  /** Who hosts an address's mail and its servers, from the domain's MX records. */
  detect(email: string) {
    return detectServers(email, this.o.resolveMx);
  }

  /** Signs in once to check the password, then keeps it in the keychain and starts syncing. */
  async addAccount(input: NewMailAccount): Promise<MailAccountView> {
    const { row, protocol } = this.#newRow(input);
    if (this.o.db.select().from(mailAccounts).where(eq(mailAccounts.email, row.email)).get())
      throw new Error(`${row.email} is already connected.`);
    const id = row.id;
    try {
      await this.#checkIncoming(row, input.password);
      await this.#checkSmtp(row, input.password);
    } catch (error) {
      // A failed add leaves a trace I can read later, never the password.
      console.error(`mail: adding ${row.email} failed: ${(error as Error).message}`);
      throw error;
    }
    await this.o.secrets.set(PASSWORD(id), input.password);
    this.o.bus.atomically(() => {
      this.o.db.insert(mailAccounts).values(row).run();
      if (protocol === "pop")
        for (const f of LOCAL_FOLDERS)
          this.o.db
            .insert(mailFolders)
            .values({ id: newId(this.#now()), accountId: id, ...f, uidValidity: "local" })
            .run();
      this.#publish("mail.account.added", { id, email: row.email }, { kind: "owner" });
    });
    this.o.hasAccounts?.();
    this.#open(id);
    return this.view(this.account(id));
  }

  /** The incoming server (IMAP or POP3) accepts the login, or it says why in plain words. */
  async #checkIncoming(row: AccountRow, pass: string) {
    const server = {
      host: row.incomingHost,
      port: row.incomingPort,
      security: row.incomingSecurity,
    };
    if (row.protocol === "pop") {
      try {
        await (await Pop3.open({ ...this.#popOptions(row, pass), timeoutMs: CHECK_MS })).quit();
      } catch (error) {
        throw new Error(explain("POP3", server, error));
      }
      return;
    }
    const client = new ImapFlow({
      ...this.#imapOptions(row, pass, false),
      connectionTimeout: CHECK_MS,
      greetingTimeout: CHECK_MS,
    } as ConstructorParameters<typeof ImapFlow>[0]);
    client.on("error", () => {});
    try {
      await client.connect();
      await client.logout();
    } catch (error) {
      throw new Error(explain("IMAP", server, error));
    }
  }

  /** SMTP accepts the login, or it says why in plain words. */
  async #checkSmtp(row: AccountRow, pass: string) {
    const server = { host: row.smtpHost, port: row.smtpPort, security: row.smtpSecurity };
    const transport = this.#transport(row, pass, CHECK_MS);
    try {
      await transport.verify();
    } catch (error) {
      throw new Error(explain("SMTP", server, error));
    } finally {
      transport.close();
    }
  }

  update(
    id: string,
    patch: { name?: string; autoSend?: boolean; appendSent?: boolean; deleteFromServer?: boolean },
  ) {
    const a = this.account(id);
    if (patch.deleteFromServer !== undefined && a.protocol !== "pop")
      throw new Error(
        "Only a POP account keeps its own copy: an IMAP account deletes on the server.",
      );
    if (!Object.keys(patch).length) return;
    this.o.db.update(mailAccounts).set(patch).where(eq(mailAccounts.id, id)).run();
    this.#publish("mail.account.updated", { id, ...patch }, { kind: "owner" });
  }

  /** Out of Oraknid: its password, its cached (or, for POP, downloaded) mail, its drafts. The server keeps its mail. */
  async removeAccount(id: string) {
    const a = this.account(id);
    await this.#close(id);
    await this.o.secrets.delete(PASSWORD(id));
    for (const d of this.o.db.select().from(mailDrafts).where(eq(mailDrafts.accountId, id)).all())
      this.#dropDraft(d);
    this.o.bus.atomically(() => {
      this.o.db.delete(mailMessages).where(eq(mailMessages.accountId, id)).run();
      this.o.db.delete(mailFolders).where(eq(mailFolders.accountId, id)).run();
      this.o.db.delete(mailImageSenders).where(eq(mailImageSenders.accountId, id)).run();
      this.o.db.delete(mailPopUidls).where(eq(mailPopUidls.accountId, id)).run();
      this.o.db.delete(mailAccounts).where(eq(mailAccounts.id, id)).run();
      this.#publish("mail.account.removed", { id, email: a.email }, { kind: "owner" });
    });
    rmSync(this.#localDir(id), { recursive: true, force: true });
  }

  /**
   * Connects again: with a new password after it changed, or with the one
   * kept, after the server was unreachable for a while.
   */
  async reconnect(id: string, password?: string) {
    const a = this.account(id);
    if (password) {
      await this.#checkIncoming(a, password);
      await this.#checkSmtp(a, password);
      await this.o.secrets.set(PASSWORD(id), password);
    } else if (a.state === "reconnect") throw new Error("Give the new password.");
    this.#state(id, "new", null);
    await this.#close(id);
    this.#open(id);
  }

  #state(id: string, state: AccountRow["state"], error: string | null) {
    const before = this.account(id);
    if (before.state === state && before.error === error) return;
    this.o.db.update(mailAccounts).set({ state, error }).where(eq(mailAccounts.id, id)).run();
    this.#publish("mail.account.state", { id, state, error });
  }

  /** The password kept in the keychain for this account. */
  async #password(a: AccountRow): Promise<string> {
    const pass = await this.o.secrets.get(PASSWORD(a.id));
    if (!pass) throw new NeedsReconnect("Its password is missing from the keychain.");
    return pass;
  }

  #imapOptions(a: AccountRow, pass: string, watch: boolean): ImapFlowOptions {
    return {
      host: a.incomingHost,
      port: a.incomingPort,
      secure: a.incomingSecurity === "tls",
      // Not in imapflow's types: STARTTLS required, or never tried on a loopback test server.
      ...({
        doSTARTTLS:
          a.incomingSecurity === "starttls"
            ? true
            : a.incomingSecurity === "plain"
              ? false
              : undefined,
      } as object),
      auth: { user: a.login, pass },
      logger: false,
      disableAutoIdle: !watch,
      ...(watch ? { autoIdleDelay: this.o.idleDelayMs ?? 1000 } : {}),
    };
  }

  #popOptions(a: AccountRow, pass: string) {
    return {
      host: a.incomingHost,
      port: a.incomingPort,
      security: a.incomingSecurity,
      user: a.login,
      pass,
    };
  }

  #transport(a: AccountRow, pass: string, timeoutMs?: number) {
    return nodemailer.createTransport({
      ...(timeoutMs ? { connectionTimeout: timeoutMs, greetingTimeout: timeoutMs } : {}),
      host: a.smtpHost,
      port: a.smtpPort,
      secure: a.smtpSecurity === "tls",
      requireTLS: a.smtpSecurity === "starttls",
      ignoreTLS: a.smtpSecurity === "plain",
      auth: { user: a.login, pass },
    });
  }

  // ── Connections and sync ─────────────────────────────────────────────

  #open(id: string) {
    if (this.#links.has(id)) return;
    const link: Link = {
      stopped: false,
      worker: null,
      watcher: null,
      timer: undefined,
      retry: undefined,
      failures: 0,
      queue: Promise.resolve(),
      again: false,
    };
    this.#links.set(id, link);
    void this.#run(id, link);
  }

  async #close(id: string) {
    const link = this.#links.get(id);
    if (!link) return;
    link.stopped = true;
    this.#links.delete(id);
    clearInterval(link.timer);
    clearTimeout(link.retry);
    for (const c of [link.watcher, link.worker]) {
      if (!c) continue;
      c.removeAllListeners("close");
      await c.logout().catch(() => c.close());
    }
  }

  /**
   * IMAP: connects, syncs everything once, then watches INBOX and passes
   * over all folders now and then. POP: downloads what is new, then
   * checks again every two minutes (POP has no IDLE).
   */
  async #run(id: string, link: Link) {
    try {
      this.#state(id, "syncing", null);
      if (this.#local(id)) {
        await this.#queued(link, () => this.#syncPop(id, false));
        if (link.stopped) return;
        link.failures = 0;
        this.#state(id, "ready", null);
        clearInterval(link.timer);
        link.timer = setInterval(
          () =>
            void this.#queued(link, () => this.#syncPop(id, true)).catch((e) =>
              this.#failed(id, link, e),
            ),
          this.o.popEveryMs ?? 2 * 60_000,
        );
        link.timer.unref();
        return;
      }
      await this.#queued(link, () => this.#syncAll(id, link, false));
      if (link.stopped) return;
      await this.#watch(id, link);
      link.failures = 0;
      this.#state(id, "ready", null);
      clearInterval(link.timer);
      link.timer = setInterval(
        () => void this.#queued(link, () => this.#syncAll(id, link, true)).catch(() => {}),
        this.o.syncEveryMs ?? 5 * 60_000,
      );
      link.timer.unref();
    } catch (error) {
      this.#failed(id, link, error);
    }
  }

  /** Auth failures wait for me ("Reconnect"); anything else retries with a growing delay. */
  #failed(id: string, link: Link, error: unknown) {
    if (link.stopped) return;
    const auth =
      error instanceof NeedsReconnect ||
      (error as { authenticationFailed?: boolean })?.authenticationFailed === true ||
      (error as { code?: string })?.code === "EAUTH";
    const message = problem(error);
    void this.#close(id);
    if (auth) {
      this.#state(id, "reconnect", message);
      return;
    }
    this.#state(id, "error", message);
    const fresh: Link = { ...link, stopped: false, worker: null, watcher: null, timer: undefined };
    fresh.failures = link.failures + 1;
    this.#links.set(id, fresh);
    fresh.retry = setTimeout(
      () => {
        if (this.#links.get(id) === fresh) void this.#run(id, fresh);
      },
      Math.min(5 * 60_000, 2000 * 2 ** link.failures),
    );
    fresh.retry.unref();
  }

  #queued<T>(link: Link, fn: () => Promise<T>): Promise<T> {
    const next = link.queue.then(fn, fn);
    link.queue = next.catch(() => {});
    return next;
  }

  /** The connection that does the work: fetching, flags, moves, appends. */
  async #worker(id: string, link: Link): Promise<ImapFlow> {
    if (link.worker?.usable) return link.worker;
    const a = this.account(id);
    const client = new ImapFlow(this.#imapOptions(a, await this.#password(a), false));
    client.on("error", (e) => console.error(`mail ${a.email}:`, problem(e)));
    await client.connect();
    client.on("close", () => {
      if (link.worker === client) link.worker = null;
    });
    link.worker = client;
    return client;
  }

  /** INBOX in IDLE on its own connection: new mail arrives within seconds. */
  async #watch(id: string, link: Link) {
    const a = this.account(id);
    const client = new ImapFlow(this.#imapOptions(a, await this.#password(a), true));
    client.on("error", (e) => console.error(`mail ${a.email} (watch):`, problem(e)));
    await client.connect();
    await client.mailboxOpen("INBOX");
    let pending: NodeJS.Timeout | undefined;
    const changed = () => {
      clearTimeout(pending);
      pending = setTimeout(() => {
        void this.#queued(link, () => this.#syncInbox(id, link)).catch((e) =>
          this.#failed(id, link, e),
        );
      }, 100);
    };
    client.on("exists", changed);
    client.on("expunge", changed);
    client.on("flags", changed);
    // Dropped (network, server restart): reconnect as after any failure.
    client.on("close", () => {
      if (!link.stopped && link.watcher === client)
        this.#failed(id, link, new Error("The connection to the mail server closed."));
    });
    link.watcher = client;
  }

  async #syncInbox(id: string, link: Link) {
    const inbox = this.o.db
      .select()
      .from(mailFolders)
      .where(and(eq(mailFolders.accountId, id), eq(mailFolders.path, "INBOX")))
      .get();
    if (!inbox) return;
    const client = await this.#worker(id, link);
    const added = await this.#syncFolder(client, inbox, true);
    this.o.db
      .update(mailAccounts)
      .set({ lastSyncAt: this.#now() })
      .where(eq(mailAccounts.id, id))
      .run();
    if (added.length)
      this.#publish("mail.new", {
        accountId: id,
        count: added.length,
        subjects: added.slice(0, 5),
      });
    else this.#publish("mail.synced", { accountId: id, folderId: inbox.id });
  }

  /** Lists the folders, then brings each one up to date. */
  async #syncAll(id: string, link: Link, announce: boolean) {
    const client = await this.#worker(id, link);
    const listed = await client.list();
    const known = new Map(
      this.o.db
        .select()
        .from(mailFolders)
        .where(eq(mailFolders.accountId, id))
        .all()
        .map((f) => [f.path, f]),
    );
    const seen = new Set<string>();
    for (const l of listed) {
      if (l.flags.has("\\Noselect") || l.flags.has("\\NonExistent")) continue;
      seen.add(l.path);
      const specialUse = l.path === "INBOX" ? "\\Inbox" : (l.specialUse ?? null);
      const f = known.get(l.path);
      if (!f)
        this.o.db
          .insert(mailFolders)
          .values({ id: newId(this.#now()), accountId: id, path: l.path, name: l.name, specialUse })
          .run();
      else if (f.specialUse !== specialUse)
        this.o.db.update(mailFolders).set({ specialUse }).where(eq(mailFolders.id, f.id)).run();
    }
    for (const [path, f] of known)
      if (!seen.has(path)) {
        this.o.db.delete(mailMessages).where(eq(mailMessages.folderId, f.id)).run();
        this.o.db.delete(mailFolders).where(eq(mailFolders.id, f.id)).run();
      }
    let added = 0;
    for (const f of this.#folders(id)) {
      // Gmail's All Mail holds every message again: archiving moves there, nothing reads it.
      if (f.specialUse === "\\All") continue;
      const fresh = await this.#syncFolder(client, f, announce && f.path === "INBOX");
      if (f.path === "INBOX") added += fresh.length;
    }
    this.o.db
      .update(mailAccounts)
      .set({ lastSyncAt: this.#now() })
      .where(eq(mailAccounts.id, id))
      .run();
    if (added && announce) this.#publish("mail.new", { accountId: id, count: added });
    this.#publish("mail.synced", { accountId: id });
  }

  #folders(accountId: string): FolderRow[] {
    return this.o.db
      .select()
      .from(mailFolders)
      .where(eq(mailFolders.accountId, accountId))
      .orderBy(asc(mailFolders.path))
      .all();
  }

  /**
   * New messages since the last UID, then flags and deletions of the ones
   * already held. Returns the subjects of what was new.
   */
  async #syncFolder(client: ImapFlow, f: FolderRow, prefetch: boolean): Promise<string[]> {
    const lock = await client.getMailboxLock(f.path);
    try {
      const box = client.mailbox;
      if (!box) return [];
      const validity = String(box.uidValidity);
      let lastUid = f.lastUid;
      if (f.uidValidity !== validity) {
        // Every UID held is void: start the folder again.
        this.o.db.delete(mailMessages).where(eq(mailMessages.folderId, f.id)).run();
        lastUid = 0;
      }
      const subjects: string[] = [];
      const newIds: string[] = [];
      if (box.exists > 0) {
        // Flags and deletions of what is held.
        if (lastUid > 0) {
          const held = new Map(
            this.o.db
              .select({ id: mailMessages.id, uid: mailMessages.uid, flags: mailMessages.flags })
              .from(mailMessages)
              .where(eq(mailMessages.folderId, f.id))
              .all()
              .map((m) => [m.uid, m]),
          );
          const present = new Set<number>();
          const updates: { id: string; flags: string[] }[] = [];
          for await (const m of client.fetch(
            `1:${lastUid}`,
            { uid: true, flags: true },
            { uid: true },
          )) {
            await breathe();
            present.add(m.uid);
            const h = held.get(m.uid);
            const flags = [...(m.flags ?? [])].sort();
            if (h && JSON.stringify([...h.flags].sort()) !== JSON.stringify(flags))
              updates.push({ id: h.id, flags });
          }
          const gone = [...held.values()].filter((h) => !present.has(h.uid)).map((h) => h.id);
          await inSlices(updates, (slice) =>
            this.o.db.transaction((tx) => {
              for (const u of slice)
                tx.update(mailMessages)
                  .set({ flags: u.flags })
                  .where(eq(mailMessages.id, u.id))
                  .run();
            }),
          );
          for (let i = 0; i < gone.length; i += 500)
            this.o.db
              .delete(mailMessages)
              .where(inArray(mailMessages.id, gone.slice(i, i + 500)))
              .run();
        }
        // New since the last UID; the first time, only the latest messages.
        const limit = this.o.initialLimit ?? 10_000;
        const range = lastUid === 0 && box.exists > limit ? `${box.exists - limit + 1}:*` : null;
        const rows: { row: MessageRow; gm: string | null }[] = [];
        const query = {
          uid: true,
          flags: true,
          internalDate: true,
          size: true,
          threadId: true,
          headers: HEADER_FIELDS,
        } as const;
        const fetched = range
          ? client.fetch(range, query)
          : client.fetch(`${lastUid + 1}:*`, query, { uid: true });
        for await (const m of fetched) {
          await breathe();
          if (m.uid <= lastUid) continue; // "n:*" past the end answers with the last message
          const h = await parseHeaders(m.headers ?? Buffer.alloc(0));
          const date =
            h.date ?? (m.internalDate ? new Date(m.internalDate).getTime() : this.#now());
          rows.push({
            gm: m.threadId ?? null,
            row: {
              id: newId(this.#now()),
              accountId: f.accountId,
              folderId: f.id,
              uid: m.uid,
              messageId: h.messageId,
              inReplyTo: h.inReplyTo,
              references: h.references,
              threadId: "",
              subject: h.subject,
              fromName: h.from?.name ?? "",
              fromAddress: h.from?.address ?? "",
              to: h.to,
              cc: h.cc,
              replyTo: h.replyTo,
              date,
              flags: [...(m.flags ?? [])],
              size: m.size ?? 0,
              hasAttachments: h.hasAttachments,
              snippet: "",
              text: null,
              html: null,
              attachments: null,
              imagesAllowed: false,
            },
          });
          lastUid = Math.max(lastUid, m.uid);
        }
        // In slices, the event loop let go between them: one transaction of a first sync's
        // thousands of rows held it for over a second (`oraknid status` timed out).
        await inSlices(rows, (slice) =>
          this.o.db.transaction((tx) => {
            for (const { row: r, gm } of slice) {
              r.threadId = this.#threadOf(r, gm);
              tx.insert(mailMessages).values(r).onConflictDoNothing().run();
              newIds.push(r.id);
              subjects.push(r.subject);
            }
          }),
        );
        // The newest messages get their bodies now: snippets in the list, quick to open.
        if (prefetch && newIds.length) await this.#bodies(client, newIds.slice(-20), true);
      } else {
        this.o.db.delete(mailMessages).where(eq(mailMessages.folderId, f.id)).run();
      }
      this.o.db
        .update(mailFolders)
        .set({ uidValidity: validity, lastUid, syncedAt: this.#now() })
        .where(eq(mailFolders.id, f.id))
        .run();
      return f.lastUid === 0 && f.uidValidity === null ? [] : subjects;
    } finally {
      lock.release();
    }
  }

  /** Gmail's thread id; else the conversation of the message answered; else its first reference. */
  #threadOf(r: MessageRow, gm: string | null): string {
    if (gm) return `gm:${gm}`;
    const find = (messageId: string) =>
      this.o.db
        .select({ threadId: mailMessages.threadId })
        .from(mailMessages)
        .where(and(eq(mailMessages.accountId, r.accountId), eq(mailMessages.messageId, messageId)))
        .get()?.threadId;
    const parent = r.inReplyTo ? find(r.inReplyTo) : undefined;
    if (parent) return parent;
    return r.references[0] ?? r.inReplyTo ?? r.messageId ?? `own:${r.id}`;
  }

  /** Fetches and caches the bodies of these messages (in the selected folder when `inLock`). */
  async #bodies(client: ImapFlow, ids: string[], inLock = false) {
    const rows = this.o.db.select().from(mailMessages).where(inArray(mailMessages.id, ids)).all();
    const byFolder = new Map<string, MessageRow[]>();
    for (const r of rows) {
      if (r.text !== null) continue;
      byFolder.set(r.folderId, [...(byFolder.get(r.folderId) ?? []), r]);
    }
    for (const [folderId, list] of byFolder) {
      const folder = this.o.db.select().from(mailFolders).where(eq(mailFolders.id, folderId)).get();
      if (!folder) continue;
      const lock = inLock ? null : await client.getMailboxLock(folder.path);
      try {
        const byUid = new Map(list.map((r) => [r.uid, r]));
        for await (const m of client.fetch(
          list.map((r) => r.uid).join(","),
          { uid: true, source: true },
          { uid: true },
        )) {
          const r = byUid.get(m.uid);
          if (!r || !m.source) continue;
          const body = await parseBody(m.source);
          this.o.db
            .update(mailMessages)
            .set({
              text: body.text,
              html: body.html,
              snippet: snippetOf(body.text || htmlToText(body.html ?? "")),
              attachments: body.attachments.map((a) => ({
                filename: a.filename,
                contentType: a.contentType,
                size: a.size,
              })),
              hasAttachments: body.attachments.length > 0,
            })
            .where(eq(mailMessages.id, r.id))
            .run();
        }
      } finally {
        lock?.release();
      }
    }
  }

  // ── POP accounts: downloaded, then kept here ─────────────────────────

  /** A POP account: its folders, flags and messages are Oraknid's own. */
  #local(accountId: string): boolean {
    return this.account(accountId).protocol === "pop";
  }

  #localDir(accountId: string) {
    return join(this.o.dataDir, "mail", "local", accountId);
  }

  /** A downloaded message's bytes, as the server gave them (attachments, forwards). */
  #rawPath(r: { accountId: string; id: string }) {
    return join(this.#localDir(r.accountId), `${r.id}.eml`);
  }

  /** The folder's next local UID (its counter is lastUid). */
  #nextUid(folderId: string): number {
    const f = this.folder(folderId);
    const uid = f.lastUid + 1;
    this.o.db.update(mailFolders).set({ lastUid: uid }).where(eq(mailFolders.id, folderId)).run();
    return uid;
  }

  /** A message kept here: its bytes in the data folder, its headers and body in SQLite. */
  async #storeLocal(
    f: FolderRow,
    raw: Buffer,
    flags: string[],
    uidl: string | null,
  ): Promise<MessageRow> {
    const end = raw.indexOf("\r\n\r\n");
    const h = await parseHeaders(end >= 0 ? raw.subarray(0, end) : raw);
    const body = await parseBody(raw);
    const id = newId(this.#now());
    const row: MessageRow = {
      id,
      accountId: f.accountId,
      folderId: f.id,
      uid: 0,
      messageId: h.messageId,
      inReplyTo: h.inReplyTo,
      references: h.references,
      threadId: "",
      subject: h.subject,
      fromName: h.from?.name ?? "",
      fromAddress: h.from?.address ?? "",
      to: h.to,
      cc: h.cc,
      replyTo: h.replyTo,
      date: h.date ?? this.#now(),
      flags,
      size: raw.length,
      hasAttachments: body.attachments.length > 0,
      snippet: snippetOf(body.text || htmlToText(body.html ?? "")),
      text: body.text,
      html: body.html,
      attachments: body.attachments.map((a) => ({
        filename: a.filename,
        contentType: a.contentType,
        size: a.size,
      })),
      imagesAllowed: false,
    };
    mkdirSync(this.#localDir(f.accountId), { recursive: true, mode: 0o700 });
    writeFileSync(this.#rawPath(row), raw, { mode: 0o600 });
    this.o.db.transaction(() => {
      row.uid = this.#nextUid(f.id);
      row.threadId = this.#threadOf(row, null);
      this.o.db.insert(mailMessages).values(row).run();
      if (uidl)
        this.o.db
          .insert(mailPopUidls)
          .values({ accountId: f.accountId, uidl, messageId: id, createdAt: this.#now() })
          .onConflictDoUpdate({
            target: [mailPopUidls.accountId, mailPopUidls.uidl],
            set: { messageId: id },
          })
          .run();
    });
    return row;
  }

  /**
   * Downloads what the server has that was never downloaded (by UIDL) into
   * the local Inbox, deletes there what I deleted here for good when the
   * account says so, and forgets the UIDLs the server no longer lists. The
   * first time, only the latest messages (as many as an IMAP folder's first
   * sync); the older ones are left on the server.
   */
  async #syncPop(id: string, announce: boolean) {
    const a = this.account(id);
    const inbox = this.#folders(id).find((f) => f.path === "INBOX");
    if (!inbox) throw new Error("This account's Inbox is missing.");
    const pop = await Pop3.open(this.#popOptions(a, await this.#password(a)));
    const subjects: string[] = [];
    try {
      const listed = await pop.uidl();
      const held = new Map(
        this.o.db
          .select()
          .from(mailPopUidls)
          .where(eq(mailPopUidls.accountId, id))
          .all()
          .map((u) => [u.uidl, u]),
      );
      const first = held.size === 0;
      for (const l of listed) if (held.get(l.uidl)?.deleteOnServer) await pop.dele(l.n);
      const fresh = listed.filter((l) => !held.has(l.uidl));
      const limit = this.o.initialLimit ?? 10_000;
      if (first && fresh.length > limit) {
        const skipped = fresh.splice(0, fresh.length - limit);
        this.o.db.transaction(() => {
          for (const l of skipped)
            this.o.db
              .insert(mailPopUidls)
              .values({ accountId: id, uidl: l.uidl, messageId: null, createdAt: this.#now() })
              .onConflictDoNothing()
              .run();
        });
      }
      for (const [i, l] of fresh.entries()) {
        const raw = await pop.retr(l.n);
        subjects.push((await this.#storeLocal(inbox, raw, [], l.uidl)).subject);
        // A long first download fills the list as it goes.
        if (i % 50 === 49) this.#publish("mail.synced", { accountId: id, folderId: inbox.id });
      }
      await pop.quit();
      // What the server no longer lists was deleted there (by me or another client).
      const on = new Set(listed.map((l) => l.uidl));
      const gone = [...held.keys()].filter((u) => !on.has(u));
      for (let i = 0; i < gone.length; i += 500)
        this.o.db
          .delete(mailPopUidls)
          .where(
            and(eq(mailPopUidls.accountId, id), inArray(mailPopUidls.uidl, gone.slice(i, i + 500))),
          )
          .run();
    } finally {
      pop.close();
    }
    this.o.db
      .update(mailAccounts)
      .set({ lastSyncAt: this.#now() })
      .where(eq(mailAccounts.id, id))
      .run();
    if (subjects.length && announce)
      this.#publish("mail.new", {
        accountId: id,
        count: subjects.length,
        subjects: subjects.slice(0, 5),
      });
    else this.#publish("mail.synced", { accountId: id, folderId: inbox.id });
  }

  /** Moves kept here: the rows change folder, with the destination's next UIDs. */
  #moveLocal(rows: MessageRow[], dest: FolderRow) {
    this.o.db.transaction(() => {
      for (const r of rows) {
        if (r.folderId === dest.id) continue;
        this.o.db
          .update(mailMessages)
          .set({ folderId: dest.id, uid: this.#nextUid(dest.id) })
          .where(eq(mailMessages.id, r.id))
          .run();
      }
    });
  }

  /**
   * Gone from Oraknid for good, files and all. With "delete from the
   * server" on, the next check deletes them there too; else they stay
   * there, and are never downloaded again.
   */
  #deleteLocal(a: AccountRow, rows: MessageRow[]) {
    const ids = rows.map((r) => r.id);
    this.o.db.transaction(() => {
      for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        this.o.db
          .update(mailPopUidls)
          .set({ messageId: null, deleteOnServer: a.deleteFromServer })
          .where(inArray(mailPopUidls.messageId, chunk))
          .run();
        this.o.db.delete(mailMessages).where(inArray(mailMessages.id, chunk)).run();
      }
    });
    for (const r of rows) rmSync(this.#rawPath(r), { force: true });
    if (!a.deleteFromServer) return;
    const link = this.#links.get(a.id);
    if (link)
      void this.#queued(link, () => this.#syncPop(a.id, true)).catch((e) =>
        this.#failed(a.id, link, e),
      );
  }

  /** A pass now, rather than at the next timer. */
  async syncNow(id: string) {
    const a = this.account(id);
    if (a.state === "reconnect") throw new Error("Sign in again first.");
    const link = this.#links.get(id);
    if (!link) return this.#open(id);
    if (a.protocol === "pop") {
      await this.#queued(link, () => this.#syncPop(id, true)).catch((e) => {
        this.#failed(id, link, e);
        throw new Error(problem(e));
      });
      return;
    }
    await this.#queued(link, () => this.#syncAll(id, link, true));
  }

  /** The account's working connection, for one action; a failure is handled like any other. */
  async #act<T>(accountId: string, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const a = this.account(accountId);
    if (a.state === "reconnect")
      throw new Error(`${a.email} needs signing in again: use Reconnect in Mail.`);
    if (a.protocol === "pop") throw new Error("A POP account's mail is all kept here.");
    let link = this.#links.get(accountId);
    if (!link) {
      this.#open(accountId);
      link = this.#links.get(accountId) as Link;
    }
    const l = link;
    return this.#queued(l, async () => {
      try {
        return await fn(await this.#worker(accountId, l));
      } catch (error) {
        const auth =
          error instanceof NeedsReconnect ||
          (error as { authenticationFailed?: boolean })?.authenticationFailed === true;
        if (auth) this.#failed(accountId, l, error);
        throw new Error(problem(error));
      }
    });
  }

  // ── Reading ───────────────────────────────────────────────────────────

  #counts(folderId: string): { total: number; unread: number } {
    const r = this.o.db
      .select({
        total: sql<number>`count(*)`,
        unread: sql<number>`sum(case when exists (select 1 from json_each(${mailMessages.flags}) where value = ${SEEN}) then 0 else 1 end)`,
      })
      .from(mailMessages)
      .where(eq(mailMessages.folderId, folderId))
      .get();
    return { total: r?.total ?? 0, unread: r?.unread ?? 0 };
  }

  folders(accountId: string): MailFolderView[] {
    this.account(accountId);
    const order = ["\\Inbox", "\\Drafts", "\\Sent", "\\Archive", "\\Junk", "\\Trash"];
    return this.#folders(accountId)
      .filter((f) => f.specialUse !== "\\All")
      .map((f) => ({
        id: f.id,
        accountId,
        path: f.path,
        name: f.path === "INBOX" ? "Inbox" : f.name,
        specialUse: f.specialUse,
        ...this.#counts(f.id),
      }))
      .sort((a, b) => {
        const x = a.specialUse ? order.indexOf(a.specialUse) : -1;
        const y = b.specialUse ? order.indexOf(b.specialUse) : -1;
        return (x < 0 ? 99 : x) - (y < 0 ? 99 : y) || a.path.localeCompare(b.path);
      });
  }

  folder(id: string): FolderRow {
    const f = this.o.db.select().from(mailFolders).where(eq(mailFolders.id, id)).get();
    if (!f) throw new Error(`No mail folder ${id}.`);
    return f;
  }

  #special(accountId: string, use: string): FolderRow | undefined {
    return this.#folders(accountId).find((f) => f.specialUse === use);
  }

  /**
   * A page of a folder's conversations, latest first; with a query, the
   * ones matching it here and in what the server finds in that folder.
   */
  async threads(o: {
    accountId: string;
    folderId?: string | null;
    query?: string;
    offset?: number;
    limit?: number;
  }): Promise<MailThreadPage> {
    this.account(o.accountId);
    const offset = o.offset ?? 0;
    const limit = Math.min(o.limit ?? 100, 500);
    const where = [eq(mailMessages.accountId, o.accountId)];
    if (o.folderId) where.push(eq(mailMessages.folderId, o.folderId));
    const q = o.query?.trim();
    if (q) {
      const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
      let serverUids: number[] = [];
      if (o.folderId && !this.#local(o.accountId)) {
        const f = this.folder(o.folderId);
        serverUids = await this.#act(o.accountId, async (client) => {
          const lock = await client.getMailboxLock(f.path);
          try {
            return ((await client.search({ text: q }, { uid: true })) || []) as number[];
          } catch {
            return [];
          } finally {
            lock.release();
          }
        }).catch(() => []);
      }
      const text = sql`(${sql.join(
        [
          mailMessages.subject,
          mailMessages.fromName,
          mailMessages.fromAddress,
          mailMessages.to,
          mailMessages.text,
        ].map((c) => sql`${c} like ${like} escape '\\'`),
        sql` or `,
      )})`;
      where.push(
        serverUids.length
          ? sql`(${text} or ${mailMessages.uid} in (${sql.join(
              serverUids.map((u) => sql`${u}`),
              sql`, `,
            )}))`
          : text,
      );
    }
    const cond = and(...where);
    const total =
      this.o.db
        .select({ n: sql<number>`count(distinct ${mailMessages.threadId})` })
        .from(mailMessages)
        .where(cond)
        .get()?.n ?? 0;
    const page = this.o.db
      .select({ threadId: mailMessages.threadId, last: sql<number>`max(${mailMessages.date})` })
      .from(mailMessages)
      .where(cond)
      .groupBy(mailMessages.threadId)
      .orderBy(desc(sql`max(${mailMessages.date})`))
      .limit(limit)
      .offset(offset)
      .all();
    const ids = page.map((p) => p.threadId);
    const rows = ids.length
      ? this.o.db
          .select({
            id: mailMessages.id,
            threadId: mailMessages.threadId,
            subject: mailMessages.subject,
            fromName: mailMessages.fromName,
            fromAddress: mailMessages.fromAddress,
            snippet: mailMessages.snippet,
            date: mailMessages.date,
            flags: mailMessages.flags,
            hasAttachments: mailMessages.hasAttachments,
            messageId: mailMessages.messageId,
          })
          .from(mailMessages)
          .where(and(cond, inArray(mailMessages.threadId, ids)))
          .orderBy(desc(mailMessages.date))
          .all()
      : [];
    const drafts = ids.length
      ? this.o.db
          .select({ threadId: mailDrafts.threadId })
          .from(mailDrafts)
          .where(
            and(
              inArray(mailDrafts.threadId, ids),
              inArray(mailDrafts.state, ["draft", "waiting", "failed"]),
            ),
          )
          .all()
      : [];
    const threads: MailThreadSummary[] = page.map((p) => {
      const list = rows.filter((r) => r.threadId === p.threadId);
      const latest = list[0];
      const unique = new Map<string, (typeof list)[number]>();
      for (const r of list) unique.set(r.messageId ?? r.id, r);
      return {
        threadId: p.threadId,
        accountId: o.accountId,
        // The conversation's own subject, not a reply's "Re:".
        subject:
          list.find((r) => !/^(re|fwd?|aw|tr|sv):/i.test(r.subject.trim()))?.subject ??
          latest?.subject ??
          "",
        from: [...new Set(list.map((r) => r.fromName || r.fromAddress))],
        snippet: latest?.snippet ?? "",
        date: p.last,
        count: unique.size,
        unread: list.some((r) => !r.flags.includes(SEEN)),
        starred: list.some((r) => r.flags.includes(FLAGGED)),
        hasAttachments: list.some((r) => r.hasAttachments),
        messageIds: list.map((r) => r.id),
        drafts: drafts.filter((d) => d.threadId === p.threadId).length,
      };
    });
    return { total, offset, threads };
  }

  #messageView(r: MessageRow, allowed: Set<string>): MailMessageView {
    return {
      id: r.id,
      accountId: r.accountId,
      folderId: r.folderId,
      threadId: r.threadId,
      messageId: r.messageId,
      subject: r.subject,
      from: r.fromAddress || r.fromName ? { name: r.fromName, address: r.fromAddress } : null,
      to: r.to,
      cc: r.cc,
      replyTo: r.replyTo,
      date: r.date,
      flags: r.flags,
      text: r.text,
      html: r.html,
      attachments: r.attachments ?? [],
      imagesAllowed: r.imagesAllowed || allowed.has(r.fromAddress),
    };
  }

  /** One conversation, each message once (Gmail lists it in every label), bodies fetched as needed. */
  async thread(accountId: string, threadId: string) {
    let rows = this.#threadRows(accountId, threadId);
    const missing = rows.filter((r) => r.text === null).map((r) => r.id);
    if (missing.length && !this.#local(accountId))
      await this.#act(accountId, (client) => this.#bodies(client, missing)).catch((e) =>
        console.error("mail bodies failed", e),
      );
    rows = this.#threadRows(accountId, threadId);
    const allowed = new Set(
      this.o.db
        .select({ address: mailImageSenders.address })
        .from(mailImageSenders)
        .where(eq(mailImageSenders.accountId, accountId))
        .all()
        .map((s) => s.address),
    );
    const drafts = this.o.db
      .select()
      .from(mailDrafts)
      .where(and(eq(mailDrafts.accountId, accountId), eq(mailDrafts.threadId, threadId)))
      .orderBy(asc(mailDrafts.createdAt))
      .all()
      .filter((d) => d.state !== "sent")
      .map((d) => this.draftView(d));
    return { messages: rows.map((r) => this.#messageView(r, allowed)), drafts };
  }

  #threadRows(accountId: string, threadId: string): MessageRow[] {
    const all = this.o.db
      .select()
      .from(mailMessages)
      .where(and(eq(mailMessages.accountId, accountId), eq(mailMessages.threadId, threadId)))
      .orderBy(asc(mailMessages.date))
      .all();
    // The copy in Trash only when there is no other.
    const trash = this.#special(accountId, "\\Trash")?.id;
    const out = new Map<string, MessageRow>();
    for (const r of all) {
      const key = r.messageId ?? r.id;
      const had = out.get(key);
      if (
        !had ||
        (had.folderId === trash && r.folderId !== trash) ||
        (had.text === null && r.text !== null)
      )
        out.set(key, r);
    }
    return [...out.values()];
  }

  message(id: string): MessageRow {
    const r = this.o.db.select().from(mailMessages).where(eq(mailMessages.id, id)).get();
    if (!r) throw new Error(`No mail message ${id}.`);
    return r;
  }

  /** An attachment's bytes, fetched from the server (POP: from the copy kept here). */
  async attachment(id: string, index: number) {
    const r = this.message(id);
    const f = this.folder(r.folderId);
    const source = this.#local(r.accountId)
      ? readFileSync(this.#rawPath(r))
      : await this.#act(r.accountId, async (client) => {
          const lock = await client.getMailboxLock(f.path);
          try {
            const m = await client.fetchOne(String(r.uid), { source: true }, { uid: true });
            return m ? m.source : undefined;
          } finally {
            lock.release();
          }
        });
    if (!source) throw new Error("That message is gone from the server.");
    const a = (await parseBody(source)).attachments[index];
    if (!a) throw new Error("No such attachment.");
    return {
      filename: a.filename,
      contentType: a.contentType,
      base64: a.content.toString("base64"),
    };
  }

  /** The message's remote images, inline, once I allowed them (ADR-032). */
  async images(id: string): Promise<Record<string, string>> {
    const r = this.message(id);
    const allowed =
      r.imagesAllowed ||
      !!this.o.db
        .select()
        .from(mailImageSenders)
        .where(
          and(
            eq(mailImageSenders.accountId, r.accountId),
            eq(mailImageSenders.address, r.fromAddress),
          ),
        )
        .get();
    if (!allowed || !r.html) return {};
    return fetchImages(remoteImages(r.html));
  }

  /** Remote images for this message, or for everything from its sender. */
  allowImages(id: string, sender: boolean) {
    const r = this.message(id);
    if (sender && r.fromAddress)
      this.o.db
        .insert(mailImageSenders)
        .values({ accountId: r.accountId, address: r.fromAddress, createdAt: this.#now() })
        .onConflictDoNothing()
        .run();
    else
      this.o.db
        .update(mailMessages)
        .set({ imagesAllowed: true })
        .where(eq(mailMessages.id, id))
        .run();
    this.#publish("mail.changed", { accountId: r.accountId, ids: [id] }, { kind: "owner" });
  }

  // ── Acting on the server ─────────────────────────────────────────────

  #rows(ids: string[]): MessageRow[] {
    if (!ids.length) return [];
    const rows = this.o.db.select().from(mailMessages).where(inArray(mailMessages.id, ids)).all();
    if (!rows.length) throw new Error("Those messages are gone.");
    const accounts = new Set(rows.map((r) => r.accountId));
    if (accounts.size > 1) throw new Error("One account at a time.");
    return rows;
  }

  /** The messages of these conversations in a folder (or anywhere in the account). */
  threadMessageIds(accountId: string, threadIds: string[], folderId?: string | null): string[] {
    if (!threadIds.length) return [];
    return this.o.db
      .select({ id: mailMessages.id })
      .from(mailMessages)
      .where(
        and(
          eq(mailMessages.accountId, accountId),
          inArray(mailMessages.threadId, threadIds),
          ...(folderId ? [eq(mailMessages.folderId, folderId)] : []),
        ),
      )
      .all()
      .map((r) => r.id);
  }

  #byFolder(rows: MessageRow[]) {
    const out = new Map<string, MessageRow[]>();
    for (const r of rows) out.set(r.folderId, [...(out.get(r.folderId) ?? []), r]);
    return out;
  }

  /** Read or unread, starred or not; labels as keywords (Gmail: its labels). */
  async flag(
    ids: string[],
    change: { seen?: boolean; flagged?: boolean; addLabels?: string[]; removeLabels?: string[] },
    actor: Actor,
  ) {
    const rows = this.#rows(ids);
    if (!rows.length) return;
    const accountId = (rows[0] as MessageRow).accountId;
    const a = this.account(accountId);
    const gmail = a.provider === "gmail" && a.protocol === "imap";
    const add: string[] = [];
    const remove: string[] = [];
    if (change.seen === true) add.push(SEEN);
    if (change.seen === false) remove.push(SEEN);
    if (change.flagged === true) add.push(FLAGGED);
    if (change.flagged === false) remove.push(FLAGGED);
    // POP: the flags are Oraknid's own.
    if (a.protocol === "imap")
      await this.#act(accountId, async (client) => {
        for (const [folderId, list] of this.#byFolder(rows)) {
          const f = this.folder(folderId);
          const lock = await client.getMailboxLock(f.path);
          try {
            const uids = list.map((r) => r.uid).join(",");
            if (add.length) await client.messageFlagsAdd(uids, add, { uid: true });
            if (remove.length) await client.messageFlagsRemove(uids, remove, { uid: true });
            if (change.addLabels?.length)
              await client.messageFlagsAdd(uids, change.addLabels, { uid: true, useLabels: gmail });
            if (change.removeLabels?.length)
              await client.messageFlagsRemove(uids, change.removeLabels, {
                uid: true,
                useLabels: gmail,
              });
          } finally {
            lock.release();
          }
        }
      });
    this.o.db.transaction((tx) => {
      for (const r of rows) {
        const flags = new Set(r.flags);
        for (const f of add) flags.add(f);
        for (const f of remove) flags.delete(f);
        if (!gmail) {
          for (const l of change.addLabels ?? []) flags.add(l);
          for (const l of change.removeLabels ?? []) flags.delete(l);
        }
        tx.update(mailMessages)
          .set({ flags: [...flags] })
          .where(eq(mailMessages.id, r.id))
          .run();
      }
    });
    this.#publish("mail.changed", { accountId, ids }, actor);
    this.#audit(actor, "flagged", { accountId, ids, ...change });
  }

  /** Moves on the server; what is held follows with its new UIDs (bodies kept). */
  async move(ids: string[], folderId: string, actor: Actor) {
    const rows = this.#rows(ids);
    if (!rows.length) return;
    const dest = this.folder(folderId);
    const accountId = (rows[0] as MessageRow).accountId;
    if (dest.accountId !== accountId) throw new Error("That folder is in another account.");
    await this.#moveRows(rows, dest);
    this.#publish("mail.changed", { accountId, ids }, actor);
    this.#audit(actor, "moved", { accountId, ids, to: dest.path });
  }

  async #moveRows(rows: MessageRow[], dest: FolderRow, keep = true) {
    const accountId = (rows[0] as MessageRow).accountId;
    if (this.#local(accountId)) return this.#moveLocal(rows, dest);
    await this.#act(accountId, async (client) => {
      for (const [folderId, list] of this.#byFolder(rows)) {
        if (folderId === dest.id) continue;
        const f = this.folder(folderId);
        const lock = await client.getMailboxLock(f.path);
        try {
          const res = await client.messageMove(list.map((r) => r.uid).join(","), dest.path, {
            uid: true,
          });
          const map = res ? res.uidMap : undefined;
          this.o.db.transaction((tx) => {
            for (const r of list) {
              const uid = map?.get(r.uid);
              if (keep && uid !== undefined)
                tx.update(mailMessages)
                  .set({ folderId: dest.id, uid })
                  .where(eq(mailMessages.id, r.id))
                  .run();
              else tx.delete(mailMessages).where(eq(mailMessages.id, r.id)).run();
            }
          });
        } finally {
          lock.release();
        }
      }
    });
  }

  /** Out of the inbox: Gmail's All Mail, or the Archive folder (made if there is none). */
  async archive(ids: string[], actor: Actor) {
    const rows = this.#rows(ids);
    if (!rows.length) return;
    const accountId = (rows[0] as MessageRow).accountId;
    const all = this.#special(accountId, "\\All");
    let dest = all ?? this.#special(accountId, "\\Archive");
    if (!dest) {
      await this.#act(accountId, (client) => client.mailboxCreate("Archive"));
      const id = newId(this.#now());
      this.o.db
        .insert(mailFolders)
        .values({ id, accountId, path: "Archive", name: "Archive", specialUse: "\\Archive" })
        .onConflictDoNothing()
        .run();
      dest = this.#folders(accountId).find((f) => f.path === "Archive");
    }
    if (!dest) throw new Error("No folder to archive to.");
    // All Mail isn't synced: what goes there leaves the list.
    await this.#moveRows(rows, dest, dest !== all);
    this.#publish("mail.changed", { accountId, ids }, actor);
    this.#audit(actor, "archived", { accountId, ids });
  }

  /** To Trash; from Trash, gone for good (POP: from the server too, if the account says so). */
  async remove(ids: string[], actor: Actor) {
    const rows = this.#rows(ids);
    if (!rows.length) return;
    const accountId = (rows[0] as MessageRow).accountId;
    const trash = this.#special(accountId, "\\Trash");
    const inTrash = rows.filter((r) => r.folderId === trash?.id);
    const elsewhere = rows.filter((r) => r.folderId !== trash?.id);
    if (elsewhere.length && trash) await this.#moveRows(elsewhere, trash);
    const forGood = trash ? inTrash : rows;
    const a = this.account(accountId);
    if (forGood.length && a.protocol === "pop") this.#deleteLocal(a, forGood);
    else if (forGood.length)
      await this.#act(accountId, async (client) => {
        for (const [folderId, list] of this.#byFolder(forGood)) {
          const lock = await client.getMailboxLock(this.folder(folderId).path);
          try {
            await client.messageDelete(list.map((r) => r.uid).join(","), { uid: true });
          } finally {
            lock.release();
          }
        }
        this.o.db
          .delete(mailMessages)
          .where(
            inArray(
              mailMessages.id,
              forGood.map((r) => r.id),
            ),
          )
          .run();
      });
    this.#publish("mail.changed", { accountId, ids }, actor);
    this.#audit(actor, "deleted", { accountId, ids, forGood: forGood.length });
  }

  // ── Drafts and sending ───────────────────────────────────────────────

  draftView(d: DraftRow): MailDraftView {
    return {
      id: d.id,
      accountId: d.accountId,
      to: d.to,
      cc: d.cc,
      bcc: d.bcc,
      subject: d.subject,
      html: d.html,
      text: d.text,
      replyToId: d.replyToId,
      forwardOfId: d.forwardOfId,
      threadId: d.threadId,
      attachments: d.attachments,
      author: d.author,
      jobId: d.jobId,
      state: d.state,
      error: d.error,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
      sentAt: d.sentAt,
    };
  }

  draft(id: string): DraftRow {
    const d = this.o.db.select().from(mailDrafts).where(eq(mailDrafts.id, id)).get();
    if (!d) throw new Error(`No draft ${id}.`);
    return d;
  }

  /** Drafts not yet sent: mine and the agents', those waiting for me first. */
  drafts(accountId?: string): MailDraftView[] {
    return this.o.db
      .select()
      .from(mailDrafts)
      .where(
        and(
          inArray(mailDrafts.state, ["draft", "waiting", "failed", "sending"]),
          ...(accountId ? [eq(mailDrafts.accountId, accountId)] : []),
        ),
      )
      .orderBy(desc(mailDrafts.updatedAt))
      .all()
      .map((d) => this.draftView(d))
      .sort((a, b) => Number(b.state === "waiting") - Number(a.state === "waiting"));
  }

  #draftDir(id: string) {
    return join(this.o.dataDir, "mail", "drafts", id);
  }

  /** Writes or rewrites a draft. An agent's is marked as such; it can't touch mine. */
  saveDraft(input: MailCompose & { id?: string }, actor: Actor): MailDraftView {
    const a = this.account(input.accountId);
    const replyTo = input.replyToId ? this.message(input.replyToId) : null;
    const forwardOf = input.forwardOfId ? this.message(input.forwardOfId) : null;
    if (replyTo && replyTo.accountId !== a.id)
      throw new Error("That message is in another account.");
    const before = input.id ? this.draft(input.id) : null;
    if (before) {
      if (before.state === "sending" || before.state === "sent")
        throw new Error("That draft was already sent.");
      if (actor.kind === "agent" && before.author !== "agent")
        throw new Error("An agent can't change my own drafts.");
    }
    const id = before?.id ?? newId(this.#now());
    const dir = this.#draftDir(id);
    const kept = input.attachments.length ? [] : (before?.attachments ?? []);
    if (input.attachments.length) {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const attachments = [
      ...kept,
      ...input.attachments.map((f, i) => {
        const bytes = Buffer.from(f.base64, "base64");
        writeFileSync(join(dir, String(i)), bytes, { mode: 0o600 });
        return { filename: f.filename, contentType: f.contentType, size: bytes.length };
      }),
    ];
    const html =
      input.html || (input.text ? `<p>${escapeHtml(input.text).replace(/\n/g, "<br>")}</p>` : "");
    const row = {
      accountId: a.id,
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      html,
      text: input.text || htmlToText(html),
      replyToId: replyTo?.id ?? null,
      forwardOfId: forwardOf?.id ?? null,
      threadId: replyTo?.threadId ?? before?.threadId ?? null,
      attachments,
      author: before?.author ?? (actor.kind === "agent" ? "agent" : "owner"),
      jobId: before?.jobId ?? (actor.kind === "agent" ? actor.jobId : null),
      state: "draft" as const,
      error: null,
      updatedAt: this.#now(),
    };
    if (before) this.o.db.update(mailDrafts).set(row).where(eq(mailDrafts.id, id)).run();
    else
      this.o.db
        .insert(mailDrafts)
        .values({ ...row, id, createdAt: this.#now() })
        .run();
    this.#publish("mail.draft", { id, accountId: a.id, state: "draft", author: row.author }, actor);
    this.#audit(actor, "drafted", {
      accountId: a.id,
      draftId: id,
      to: input.to,
      subject: input.subject,
    });
    return this.draftView(this.draft(id));
  }

  /** A reply to a message, addressed and quoted for me (or an agent) to finish. */
  replyTemplate(messageId: string, all: boolean, body: string): MailCompose {
    const r = this.message(messageId);
    const me = this.account(r.accountId).email;
    const to = (r.replyTo.length ? r.replyTo : [{ name: r.fromName, address: r.fromAddress }])
      .map((x) => x.address)
      .filter(Boolean);
    const cc = all
      ? [...r.to, ...r.cc].map((x) => x.address).filter((x) => x && x !== me && !to.includes(x))
      : [];
    const quoted = (r.text ?? r.snippet)
      .split("\n")
      .map((l) => `> ${l}`)
      .join("\n");
    const when = new Date(r.date).toUTCString();
    const text = `${body}\n\nOn ${when}, ${r.fromName || r.fromAddress} wrote:\n${quoted}`;
    return {
      accountId: r.accountId,
      to,
      cc,
      bcc: [],
      subject: /^re:/i.test(r.subject) ? r.subject : `Re: ${r.subject}`,
      html: "",
      text,
      replyToId: r.id,
      forwardOfId: null,
      attachments: [],
    };
  }

  /** I write and send at once (a draft first, so nothing is lost if sending fails). */
  async sendNow(input: MailCompose & { id?: string }, device: string | null = null) {
    const d = this.saveDraft(input, { kind: "owner", device });
    return this.#send(d.id, { kind: "owner", device });
  }

  /** I approve a draft (mine or an agent's): it goes out now. */
  async approve(id: string, device: string | null = null) {
    const d = this.draft(id);
    if (d.approvalItemId) {
      const item = this.o.inbox.get(d.approvalItemId);
      if (item?.state === "open") {
        // Answering the inbox item sends it, through the same path as answering there.
        this.o.inbox.answer(d.approvalItemId, APPROVE, device);
        return this.draftView(this.draft(id));
      }
    }
    return this.#send(id, { kind: "owner", device });
  }

  #refused(id: string) {
    this.o.db
      .update(mailDrafts)
      .set({ state: "draft", error: "Not sent: I said no.", updatedAt: this.#now() })
      .where(eq(mailDrafts.id, id))
      .run();
    const d = this.draft(id);
    this.#publish(
      "mail.draft",
      { id, accountId: d.accountId, state: "draft", refused: true },
      { kind: "owner" },
    );
  }

  /**
   * An agent asks to send its draft: it goes out at once only if I turned on
   * auto-send for the account; otherwise it waits for my approval, in Mail
   * and in the inbox when a job wrote it.
   */
  async requestSend(id: string, actor: Actor & { kind: "agent" }) {
    const d = this.draft(id);
    if (d.author !== "agent") throw new Error("An agent can only send its own drafts.");
    if (d.state === "sent") throw new Error("That draft was already sent.");
    if (d.state === "sending" || d.state === "waiting")
      return { state: d.state, message: "It is already waiting or on its way." };
    const a = this.account(d.accountId);
    if (a.autoSend) {
      this.#audit(actor, "send-requested", { accountId: a.id, draftId: id, autoSend: true });
      const sent = await this.#send(id, actor);
      return {
        state: sent.state,
        message: sent.error ?? "Sent (auto-send is on for this account).",
      };
    }
    let itemId: string | null = null;
    if (d.jobId && this.o.db.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, d.jobId)).get())
      itemId = this.o.inbox.open({
        kind: "approval",
        jobId: d.jobId,
        raisedBy: "eye",
        title: `Send the email "${d.subject || "(no subject)"}" to ${[...d.to, ...d.cc].join(", ")}?`,
        detail: `An agent wrote this from ${a.email}. Read it in Mail before you answer.\n\nTo: ${d.to.join(", ")}${d.cc.length ? `\nCc: ${d.cc.join(", ")}` : ""}\nSubject: ${d.subject}\n\n${d.text}`,
        options: [APPROVE, REFUSE],
        defaultOption: null,
        questions: [
          choiceQuestion("Send it?", [
            { label: APPROVE, detail: "It is sent now, once, from this account." },
            {
              label: REFUSE,
              detail: "It isn't sent; the draft stays in Mail, and the agent is told you refused.",
            },
          ]),
        ],
      });
    this.o.db
      .update(mailDrafts)
      .set({ state: "waiting", approvalItemId: itemId, error: null, updatedAt: this.#now() })
      .where(eq(mailDrafts.id, id))
      .run();
    this.#publish("mail.draft", { id, accountId: a.id, state: "waiting" }, actor);
    this.#audit(actor, "send-requested", { accountId: a.id, draftId: id, autoSend: false });
    return {
      state: "waiting" as const,
      message: "The draft waits for the owner's approval; it is sent when they approve it.",
    };
  }

  /** Builds the message, sends it over SMTP, files it in Sent if the provider doesn't. */
  async #send(id: string, actor: Actor): Promise<MailDraftView> {
    const d = this.draft(id);
    if (!["draft", "waiting", "failed"].includes(d.state))
      throw new Error(d.state === "sent" ? "That draft was already sent." : "It is being sent.");
    if (!d.to.length && !d.cc.length && !d.bcc.length)
      throw new Error("Give at least one recipient.");
    const a = this.account(d.accountId);
    // Sending is a side effect (BR-6): marked before it starts, settled after.
    this.o.db
      .update(mailDrafts)
      .set({ state: "sending", error: null, updatedAt: this.#now() })
      .where(eq(mailDrafts.id, id))
      .run();
    this.#publish("mail.draft", { id, accountId: a.id, state: "sending" }, actor);
    try {
      const replyTo = d.replyToId
        ? this.o.db.select().from(mailMessages).where(eq(mailMessages.id, d.replyToId)).get()
        : undefined;
      const files = d.attachments.map((f, i) => ({
        filename: f.filename,
        contentType: f.contentType,
        content: readFileSync(join(this.#draftDir(id), String(i))),
      }));
      if (d.forwardOfId) {
        const fwd = this.o.db
          .select()
          .from(mailMessages)
          .where(eq(mailMessages.id, d.forwardOfId))
          .get();
        if (fwd)
          for (const [i, att] of (fwd.attachments ?? []).entries()) {
            const got = await this.attachment(fwd.id, i);
            files.push({
              filename: att.filename,
              contentType: att.contentType,
              content: Buffer.from(got.base64, "base64"),
            });
          }
      }
      const domain = a.email.split("@")[1] ?? "oraknid.local";
      const messageId = `<${newId(this.#now()).toLowerCase()}@${domain}>`;
      const refs = replyTo
        ? [...replyTo.references, ...(replyTo.messageId ? [replyTo.messageId] : [])]
        : [];
      const raw = await new MailComposer({
        from: { name: a.name === a.email ? "" : a.name, address: a.email },
        to: d.to,
        cc: d.cc,
        bcc: d.bcc,
        subject: d.subject,
        html: d.html,
        text: d.text,
        messageId,
        date: new Date(this.#now()),
        ...(replyTo?.messageId ? { inReplyTo: replyTo.messageId } : {}),
        ...(refs.length ? { references: refs } : {}),
        attachments: files,
      })
        .compile()
        .build();
      const transport = this.#transport(a, await this.#password(a));
      try {
        await transport.sendMail({
          envelope: { from: a.email, to: [...d.to, ...d.cc, ...d.bcc] },
          raw,
        });
      } finally {
        transport.close();
      }
      this.o.db
        .update(mailDrafts)
        .set({ state: "sent", sentAt: this.#now(), updatedAt: this.#now() })
        .where(eq(mailDrafts.id, id))
        .run();
      rmSync(this.#draftDir(id), { recursive: true, force: true });
      this.#publish(
        "mail.sent",
        { id, accountId: a.id, to: d.to, subject: d.subject, author: d.author },
        actor,
      );
      this.#audit(actor, "sent", { accountId: a.id, draftId: id, to: d.to, subject: d.subject });
      // What happens after it went out never makes it "not sent".
      await this.#afterSend(a, raw, replyTo).catch((e) => console.error("mail after send", e));
    } catch (error) {
      const message = problem(error);
      this.o.db
        .update(mailDrafts)
        .set({ state: "failed", error: message, updatedAt: this.#now() })
        .where(eq(mailDrafts.id, id))
        .run();
      this.#publish("mail.draft", { id, accountId: a.id, state: "failed", error: message }, actor);
      if (error instanceof NeedsReconnect || (error as { code?: string })?.code === "EAUTH")
        this.#state(a.id, "reconnect", message);
    }
    return this.draftView(this.draft(id));
  }

  /** Sent filed in Sent (when the provider doesn't), the original marked answered, Sent synced. */
  async #afterSend(a: AccountRow, raw: Buffer, replyTo: MessageRow | undefined) {
    const sent = this.#special(a.id, "\\Sent");
    if (a.protocol === "pop") {
      // All kept here: the copy in Oraknid's Sent, \Answered on the original.
      if (a.appendSent && sent) await this.#storeLocal(sent, raw, [SEEN], null);
      if (replyTo)
        this.o.db
          .update(mailMessages)
          .set({ flags: [...new Set([...replyTo.flags, "\\Answered"])] })
          .where(eq(mailMessages.id, replyTo.id))
          .run();
      this.#publish("mail.synced", { accountId: a.id });
      return;
    }
    await this.#act(a.id, async (client) => {
      if (a.appendSent && sent) await client.append(sent.path, raw, [SEEN]);
      if (replyTo) {
        const f = this.folder(replyTo.folderId);
        const lock = await client.getMailboxLock(f.path);
        try {
          await client.messageFlagsAdd(String(replyTo.uid), ["\\Answered"], { uid: true });
        } finally {
          lock.release();
        }
        this.o.db
          .update(mailMessages)
          .set({ flags: [...new Set([...replyTo.flags, "\\Answered"])] })
          .where(eq(mailMessages.id, replyTo.id))
          .run();
      }
      if (sent) await this.#syncFolder(client, this.folder(sent.id), false);
    });
    this.#publish("mail.synced", { accountId: a.id });
  }

  discard(id: string) {
    const d = this.draft(id);
    if (d.state === "sending") throw new Error("It is being sent.");
    this.#dropDraft(d);
    this.#publish(
      "mail.draft",
      { id, accountId: d.accountId, state: "discarded" },
      { kind: "owner" },
    );
  }

  #dropDraft(d: DraftRow) {
    if (d.approvalItemId && this.o.inbox.get(d.approvalItemId)?.state === "open")
      this.o.inbox.withdraw(d.approvalItemId);
    rmSync(this.#draftDir(d.id), { recursive: true, force: true });
    this.o.db.delete(mailDrafts).where(eq(mailDrafts.id, d.id)).run();
  }

  // ── For agents (the email tool) ──────────────────────────────────────

  /** Messages matching a query, newest first, in one account or all of them. */
  async search(
    o: { query: string; accountId?: string; folder?: string; limit?: number },
    actor: Actor,
  ) {
    const accounts = o.accountId
      ? [this.account(o.accountId)]
      : this.o.db.select().from(mailAccounts).all();
    const out: { account: string; threads: MailThreadSummary[] }[] = [];
    for (const a of accounts) {
      const folder = o.folder
        ? this.#folders(a.id).find(
            (f) =>
              f.path.toLowerCase() === o.folder?.toLowerCase() ||
              f.name.toLowerCase() === o.folder?.toLowerCase(),
          )
        : undefined;
      if (o.folder && !folder) continue;
      const page = await this.threads({
        accountId: a.id,
        folderId: folder?.id ?? null,
        query: o.query,
        limit: o.limit ?? 20,
      });
      out.push({ account: a.email, threads: page.threads });
    }
    this.#audit(actor, "searched", {
      query: o.query,
      accountId: o.accountId ?? null,
      folder: o.folder ?? null,
    });
    return out;
  }

  /** Which account a message, a thread or an address names. */
  accountFor(o: { account?: string; threadId?: string; messageId?: string }): AccountRow {
    if (o.messageId) return this.account(this.message(o.messageId).accountId);
    if (o.account) {
      const a = this.o.db
        .select()
        .from(mailAccounts)
        .all()
        .find((x) => x.id === o.account || x.email === o.account?.toLowerCase());
      if (!a) throw new Error(`No mail account ${o.account}.`);
      return a;
    }
    if (o.threadId) {
      const r = this.o.db
        .select({ accountId: mailMessages.accountId })
        .from(mailMessages)
        .where(eq(mailMessages.threadId, o.threadId))
        .get();
      if (r) return this.account(r.accountId);
    }
    const all = this.o.db.select().from(mailAccounts).all();
    if (all.length === 1) return all[0] as AccountRow;
    throw new Error("Say which account (its address): there are several.");
  }

  audit(actor: Actor, action: string, payload: Record<string, unknown>) {
    this.#audit(actor, action, payload);
  }
}

let lastBreath = performance.now();
/**
 * In a long loop, lets the event loop go once 20 ms have passed since it last
 * did. A FETCH of thousands of messages arrives buffered: its items come as
 * microtasks, so a `for await` over them never let a timer or a request in.
 */
export async function breathe() {
  if (performance.now() - lastBreath < 20) return;
  await new Promise<void>((r) => setImmediate(r));
  lastBreath = performance.now();
}

/** Rows handled a slice at a time, the event loop let go between slices (`/health` stays quick). */
export async function inSlices<T>(rows: T[], fn: (slice: T[]) => void, size = 200) {
  for (let i = 0; i < rows.length; i += size) {
    if (i > 0) await new Promise<void>((r) => setImmediate(r));
    fn(rows.slice(i, i + size));
  }
}

function problem(error: unknown): string {
  if (error instanceof Error) {
    const e = error as Error & { responseText?: string; response?: string };
    return (
      e.responseText ||
      (typeof e.response === "string" ? e.response : "") ||
      e.message
    ).trim();
  }
  return String(error);
}
