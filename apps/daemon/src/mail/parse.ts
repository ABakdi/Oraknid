import { type AddressObject, simpleParser } from "mailparser";

// Reading what IMAP hands over: the headers of a message for the list, and
// its whole source once opened (ADR-032).

export type Address = { name: string; address: string };

export interface Headers {
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  subject: string;
  from: Address | null;
  to: Address[];
  cc: Address[];
  replyTo: Address[];
  date: number | null;
  hasAttachments: boolean;
}

/** The header fields the list needs, asked of the server for each message. */
export const HEADER_FIELDS = [
  "message-id",
  "in-reply-to",
  "references",
  "subject",
  "from",
  "to",
  "cc",
  "reply-to",
  "date",
  "content-type",
];

const ids = (v: string | string[] | undefined): string[] =>
  (Array.isArray(v) ? v.join(" ") : (v ?? "")).match(/<[^<>\s]+>/g) ?? [];

export function addresses(v: AddressObject | AddressObject[] | undefined): Address[] {
  const list = Array.isArray(v) ? v : v ? [v] : [];
  return list.flatMap((o) =>
    o.value.flatMap((a) =>
      a.group
        ? a.group.map((g) => ({ name: g.name ?? "", address: (g.address ?? "").toLowerCase() }))
        : [{ name: a.name ?? "", address: (a.address ?? "").toLowerCase() }],
    ),
  );
}

export async function parseHeaders(raw: Buffer): Promise<Headers> {
  // The header block alone, ended as a message would be.
  const text = raw.toString("utf8").replace(/(\r?\n)*$/, "\r\n\r\n");
  const p = await simpleParser(text, { skipHtmlToText: true, skipTextToHtml: true });
  const contentType = p.headers.get("content-type") as { value?: string } | string | undefined;
  const type = typeof contentType === "string" ? contentType : (contentType?.value ?? "");
  return {
    messageId: p.messageId ?? null,
    inReplyTo: ids(p.inReplyTo)[0] ?? null,
    references: ids(p.references),
    subject: p.subject ?? "",
    from: addresses(p.from)[0] ?? null,
    to: addresses(p.to),
    cc: addresses(p.cc),
    replyTo: addresses(p.replyTo),
    date: p.date ? p.date.getTime() : null,
    hasAttachments: /multipart\/mixed/i.test(type),
  };
}

export interface Body {
  text: string;
  html: string | null;
  attachments: { filename: string; contentType: string; size: number; content: Buffer }[];
}

/** Inline images (cid:) small enough travel inside the HTML as data. */
const INLINE_MAX = 1024 * 1024;

export async function parseBody(source: Buffer): Promise<Body> {
  const p = await simpleParser(source, { skipTextToHtml: true });
  let html = typeof p.html === "string" ? p.html : null;
  const attachments: Body["attachments"] = [];
  for (const [i, a] of p.attachments.entries()) {
    if (a.contentId && a.related && html && a.size <= INLINE_MAX) {
      const cid = a.contentId.replace(/^<|>$/g, "");
      html = html.replaceAll(
        `cid:${cid}`,
        `data:${a.contentType};base64,${a.content.toString("base64")}`,
      );
      continue;
    }
    attachments.push({
      filename: a.filename ?? `attachment-${i + 1}`,
      contentType: a.contentType,
      size: a.size,
      content: a.content,
    });
  }
  return { text: p.text ?? "", html, attachments };
}

export function snippetOf(text: string): string {
  return text
    .split("\n")
    .filter((l) => !l.startsWith(">"))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/** HTML to plain text, for the text part of what I write. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(br|\/p|\/div|\/li|\/h\d)[^>]*>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
