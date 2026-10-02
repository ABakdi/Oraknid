import type { BuiltInServer, McpHandler, Rpc } from "../tools/broker.ts";
import type { BuiltInTool } from "../tools/registry.ts";
import type { Actor, MailService } from "./service.ts";

// The email tool (ADR-032): my mail for agents, through the broker
// (ADR-021). Reads pass; label, move, flag and drafts are declared writes,
// judged by the job's policy; `send` only asks: an agent's draft goes out
// when I approve it, unless I turned on auto-send for the account. What it
// returns is mail, untrusted: the broker wraps it as data (BR-15).

export const EMAIL_TOOL: BuiltInTool = {
  name: "email",
  description:
    "My mail accounts: search, read threads, sort, and draft replies. Sending waits for my approval.",
  reads: ["search", "read_thread", "list_folders"],
  held: ["send"],
};

type Schema = { type: "object"; properties: Record<string, unknown>; required?: string[] };
const str = (description: string) => ({ type: "string", description });
const strs = (description: string) => ({ type: "array", items: { type: "string" }, description });

const TOOLS: { name: string; description: string; inputSchema: Schema }[] = [
  {
    name: "search",
    description:
      "Search the owner's mail. Returns conversations (thread ids, subjects, senders, dates, snippets), newest first.",
    inputSchema: {
      type: "object",
      properties: {
        query: str("Words to find in subjects, senders, recipients and bodies."),
        account: str("The account's address; all accounts when left out."),
        folder: str("A folder name or path (e.g. INBOX); all folders when left out."),
        limit: { type: "number", description: "At most this many conversations per account (20)." },
      },
      required: ["query"],
    },
  },
  {
    name: "read_thread",
    description:
      "Read a whole conversation: every message with its sender, recipients, date and text.",
    inputSchema: {
      type: "object",
      properties: { thread_id: str("From search."), account: str("The account's address.") },
      required: ["thread_id"],
    },
  },
  {
    name: "list_folders",
    description: "The folders of an account, with their unread counts.",
    inputSchema: { type: "object", properties: { account: str("The account's address.") } },
  },
  {
    name: "label",
    description:
      "Add or remove labels on a conversation (Gmail labels; keywords on other servers).",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: str("The conversation."),
        account: str("The account's address."),
        add: strs("Labels to add."),
        remove: strs("Labels to remove."),
      },
      required: ["thread_id"],
    },
  },
  {
    name: "move",
    description: "Move a conversation to another folder (on the server).",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: str("The conversation."),
        account: str("The account's address."),
        folder: str("The destination folder's name or path."),
      },
      required: ["thread_id", "folder"],
    },
  },
  {
    name: "flag",
    description: "Mark a conversation read or unread, starred or not.",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: str("The conversation."),
        account: str("The account's address."),
        read: { type: "boolean" },
        starred: { type: "boolean" },
      },
      required: ["thread_id"],
    },
  },
  {
    name: "draft",
    description:
      "Write a new email as a draft for the owner. It is not sent: call send with its id to ask the owner to approve it.",
    inputSchema: {
      type: "object",
      properties: {
        account: str("The account to write from (its address)."),
        to: strs("Recipients."),
        cc: strs("Copies."),
        subject: str("Subject."),
        body: str("The text of the email."),
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "draft_reply",
    description:
      "Write a reply to the latest message of a conversation as a draft for the owner (addressed and quoted). Not sent until the owner approves it.",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: str("The conversation."),
        account: str("The account's address."),
        body: str("The reply's text, without the quote."),
        reply_all: { type: "boolean", description: "Copy everyone in the message (false)." },
      },
      required: ["thread_id", "body"],
    },
  },
  {
    name: "send",
    description:
      "Ask to send one of your drafts. The owner approves it first (unless they turned on auto-send for the account); you are told whether it waits or went out.",
    inputSchema: {
      type: "object",
      properties: { draft_id: str("From draft or draft_reply.") },
      required: ["draft_id"],
    },
  },
];

const text = (id: Rpc["id"], t: string, isError = false): Rpc => ({
  jsonrpc: "2.0",
  id,
  result: { content: [{ type: "text", text: t }], isError },
});

const when = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 16);

/** The email tool as the broker runs it, for one session of a job. */
export function emailServer(mail: MailService): BuiltInServer {
  return (session) => {
    const actor: Actor = { kind: "agent", jobId: session.jobId };
    const handle: McpHandler = async (m) => {
      if (m.method === "initialize")
        return {
          jsonrpc: "2.0",
          id: m.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "oraknid-email", version: "1.0.0" },
          },
        };
      if (m.id === undefined) return null; // notifications
      if (m.method === "ping") return { jsonrpc: "2.0", id: m.id, result: {} };
      if (m.method === "tools/list") return { jsonrpc: "2.0", id: m.id, result: { tools: TOOLS } };
      if (m.method !== "tools/call")
        return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "method not found" } };
      const name = String(m.params?.name ?? "");
      const args = (m.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        return text(m.id, await call(mail, actor, name, args));
      } catch (error) {
        return text(m.id, error instanceof Error ? error.message : String(error), true);
      }
    };
    return handle;
  };
}

async function call(
  mail: MailService,
  actor: Actor,
  name: string,
  a: Record<string, unknown>,
): Promise<string> {
  const s = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : undefined);
  const list = (k: string) =>
    Array.isArray(a[k])
      ? (a[k] as unknown[]).map(String)
      : typeof a[k] === "string"
        ? [a[k] as string]
        : [];
  const account = () =>
    mail.accountFor({
      ...(s("account") ? { account: s("account") } : {}),
      ...(s("thread_id") ? { threadId: s("thread_id") } : {}),
    });
  const threadIds = (accountId: string) => {
    const id = s("thread_id");
    if (!id) throw new Error("Give thread_id (from search).");
    const ids = mail.threadMessageIds(accountId, [id]);
    if (!ids.length) throw new Error(`No conversation ${id} in this account.`);
    return ids;
  };

  if (name === "search") {
    const query = s("query") ?? "";
    const found = await mail.search(
      {
        query,
        ...(s("account") ? { accountId: mail.accountFor({ account: s("account") }).id } : {}),
        ...(s("folder") ? { folder: s("folder") } : {}),
        ...(typeof a.limit === "number" ? { limit: a.limit } : {}),
      },
      actor,
    );
    const lines = found.flatMap((f) =>
      f.threads.map(
        (t) =>
          `- thread_id: ${t.threadId}\n  account: ${f.account}\n  date: ${when(t.date)}\n  from: ${t.from.join(", ")}\n  subject: ${t.subject}\n  messages: ${t.count}${t.unread ? " (unread)" : ""}\n  snippet: ${t.snippet}`,
      ),
    );
    return lines.length ? lines.join("\n") : `Nothing matches "${query}".`;
  }

  if (name === "read_thread") {
    const acc = account();
    const id = s("thread_id");
    if (!id) throw new Error("Give thread_id (from search).");
    const { messages, drafts } = await mail.thread(acc.id, id);
    if (!messages.length) throw new Error(`No conversation ${id} in ${acc.email}.`);
    mail.audit(actor, "read", { accountId: acc.id, threadId: id });
    const fmt = (xs: { name: string; address: string }[]) =>
      xs.map((x) => (x.name ? `${x.name} <${x.address}>` : x.address)).join(", ");
    const body = messages
      .map(
        (m) =>
          `message_id: ${m.id}\nFrom: ${m.from ? fmt([m.from]) : ""}\nTo: ${fmt(m.to)}${m.cc.length ? `\nCc: ${fmt(m.cc)}` : ""}\nDate: ${when(m.date)}\nSubject: ${m.subject}${m.attachments.length ? `\nAttachments: ${m.attachments.map((x) => x.filename).join(", ")}` : ""}\n\n${(m.text ?? "(the body couldn't be fetched)").trim()}`,
      )
      .join("\n\n---\n\n");
    const pending = drafts.length
      ? `\n\n(Drafts for it: ${drafts.map((d) => `${d.id} by ${d.author}, ${d.state}`).join("; ")})`
      : "";
    return `${body}${pending}`;
  }

  if (name === "list_folders") {
    const acc = account();
    mail.audit(actor, "listed-folders", { accountId: acc.id });
    return mail
      .folders(acc.id)
      .map(
        (f) =>
          `- ${f.path}${f.specialUse ? ` (${f.specialUse})` : ""}: ${f.total} messages, ${f.unread} unread`,
      )
      .join("\n");
  }

  if (name === "label") {
    const acc = account();
    await mail.flag(
      threadIds(acc.id),
      { addLabels: list("add"), removeLabels: list("remove") },
      actor,
    );
    return "Labels changed.";
  }

  if (name === "move") {
    const acc = account();
    const want = (s("folder") ?? "").toLowerCase();
    const dest = mail
      .folders(acc.id)
      .find((f) => f.path.toLowerCase() === want || f.name.toLowerCase() === want);
    if (!dest) throw new Error(`No folder "${s("folder")}" in ${acc.email}: see list_folders.`);
    // From wherever the conversation is, but what I sent stays in Sent.
    const sent = mail.folders(acc.id).find((f) => f.specialUse === "\\Sent");
    const ids = threadIds(acc.id).filter((id) => mail.message(id).folderId !== sent?.id);
    await mail.move(ids, dest.id, actor);
    return `Moved to ${dest.path}.`;
  }

  if (name === "flag") {
    const acc = account();
    const change: { seen?: boolean; flagged?: boolean } = {};
    if (typeof a.read === "boolean") change.seen = a.read;
    if (typeof a.starred === "boolean") change.flagged = a.starred;
    if (!Object.keys(change).length) throw new Error("Say read and/or starred.");
    await mail.flag(threadIds(acc.id), change, actor);
    return "Done.";
  }

  if (name === "draft") {
    const acc = mail.accountFor(s("account") ? { account: s("account") } : {});
    const d = mail.saveDraft(
      {
        accountId: acc.id,
        to: list("to"),
        cc: list("cc"),
        bcc: [],
        subject: s("subject") ?? "",
        html: "",
        text: s("body") ?? "",
        replyToId: null,
        forwardOfId: null,
        attachments: [],
      },
      actor,
    );
    return `Draft ${d.id} written from ${acc.email}. It is not sent: call send with draft_id ${d.id} to ask the owner to approve it.`;
  }

  if (name === "draft_reply") {
    const acc = account();
    const id = s("thread_id");
    if (!id) throw new Error("Give thread_id (from search).");
    const { messages } = await mail.thread(acc.id, id);
    // The latest message someone else wrote, else the latest.
    const target =
      [...messages].reverse().find((m) => m.from?.address !== acc.email) ?? messages.at(-1);
    if (!target) throw new Error(`No conversation ${id} in ${acc.email}.`);
    const d = mail.saveDraft(
      mail.replyTemplate(target.id, a.reply_all === true, s("body") ?? ""),
      actor,
    );
    return `Reply draft ${d.id} written to ${d.to.join(", ")}. It is not sent: call send with draft_id ${d.id} to ask the owner to approve it.`;
  }

  if (name === "send") {
    const id = s("draft_id");
    if (!id) throw new Error("Give draft_id.");
    if (actor.kind !== "agent") throw new Error("Only an agent asks this way.");
    const r = await mail.requestSend(id, actor);
    return r.message;
  }

  throw new Error(`The email tool has no ${name}.`);
}
