import { resolveMx } from "node:dns/promises";
import type { MailSecurity } from "@oraknid/contracts";

// Making a failed mail account explain itself (ADR-032 → Fixed after a
// failed Namecheap POP account): the servers found from the address's MX
// records, and a refusal in words that say what to check.

export interface Server {
  host: string;
  port: number;
  security: MailSecurity;
}

export interface Detected {
  /** Who hosts the mail, as I'd name it. */
  name: string;
  imap: Server | null;
  pop: Server | null;
  smtp: Server;
  /** What to use as the password, when it isn't the mailbox's own. */
  hint?: string;
}

const tls = (host: string, port: number): Server => ({ host, port, security: "tls" });
const starttls = (host: string, port: number): Server => ({ host, port, security: "starttls" });

/** Mail hosts known by their MX records, with the servers they document. */
const KNOWN: { mx: RegExp; servers: Detected }[] = [
  {
    mx: /(^|\.)(google\.com|googlemail\.com)$/,
    servers: {
      name: "Google (Gmail, Workspace)",
      imap: tls("imap.gmail.com", 993),
      pop: tls("pop.gmail.com", 995),
      smtp: tls("smtp.gmail.com", 465),
      hint: "An app password: Google account → Security → App passwords.",
    },
  },
  {
    mx: /(^|\.)(outlook\.com|hotmail\.com|protection\.outlook\.com)$/,
    servers: {
      name: "Microsoft (Outlook, Microsoft 365)",
      imap: tls("outlook.office365.com", 993),
      pop: tls("outlook.office365.com", 995),
      smtp: starttls("smtp.office365.com", 587),
      hint: "An app password: Microsoft account → Security → Advanced security options.",
    },
  },
  {
    mx: /(^|\.)privateemail\.com$/,
    servers: {
      name: "Namecheap Private Email",
      imap: tls("mail.privateemail.com", 993),
      pop: tls("mail.privateemail.com", 995),
      smtp: tls("mail.privateemail.com", 465),
      hint: "The mailbox's own password; the login is the full address.",
    },
  },
  {
    mx: /(^|\.)zoho\.(com|eu|in|com\.au)$/,
    servers: {
      name: "Zoho Mail",
      imap: tls("imap.zoho.com", 993),
      pop: tls("pop.zoho.com", 995),
      smtp: tls("smtp.zoho.com", 465),
      hint: "With two-factor sign-in on, an application-specific password.",
    },
  },
  {
    mx: /(^|\.)messagingengine\.com$/,
    servers: {
      name: "Fastmail",
      imap: tls("imap.fastmail.com", 993),
      pop: tls("pop.fastmail.com", 995),
      smtp: tls("smtp.fastmail.com", 465),
      hint: "An app password: Settings → Privacy & Security → App passwords.",
    },
  },
  {
    mx: /(^|\.)(icloud\.com|me\.com)$/,
    servers: {
      name: "iCloud Mail",
      imap: tls("imap.mail.me.com", 993),
      pop: null,
      smtp: starttls("smtp.mail.me.com", 587),
      hint: "An app-specific password from your Apple Account.",
    },
  },
  {
    mx: /(^|\.)yahoodns\.net$/,
    servers: {
      name: "Yahoo Mail",
      imap: tls("imap.mail.yahoo.com", 993),
      pop: tls("pop.mail.yahoo.com", 995),
      smtp: tls("smtp.mail.yahoo.com", 465),
      hint: "An app password: Account security → Generate app password.",
    },
  },
  {
    mx: /(^|\.)mail\.ovh\.net$/,
    servers: {
      name: "OVHcloud",
      imap: tls("ssl0.ovh.net", 993),
      pop: tls("ssl0.ovh.net", 995),
      smtp: tls("ssl0.ovh.net", 465),
    },
  },
  {
    mx: /(^|\.)(ionos\.[a-z.]+|1and1\.[a-z.]+|kundenserver\.de)$/,
    servers: {
      name: "IONOS",
      imap: tls("imap.ionos.com", 993),
      pop: tls("pop.ionos.com", 995),
      smtp: tls("smtp.ionos.com", 465),
    },
  },
  {
    mx: /(^|\.)gmx\.(net|com|de)$/,
    servers: {
      name: "GMX",
      imap: tls("imap.gmx.com", 993),
      pop: tls("pop.gmx.com", 995),
      smtp: starttls("mail.gmx.com", 587),
      hint: "Turn on POP3/IMAP access in GMX's settings first.",
    },
  },
];

/** Who hosts an address's mail, from its domain's MX records; null when unknown. */
export async function detectServers(
  email: string,
  mx: (domain: string) => Promise<{ exchange: string }[]> = resolveMx,
): Promise<Detected | null> {
  const domain = email.trim().toLowerCase().split("@")[1];
  if (!domain) return null;
  let records: { exchange: string }[];
  try {
    records = await mx(domain);
  } catch {
    return null;
  }
  for (const r of records) {
    const host = r.exchange.toLowerCase().replace(/\.$/, "");
    const known = KNOWN.find((k) => k.mx.test(host));
    if (known) return known.servers;
  }
  return null;
}

/** The security a well-known port speaks: TLS from the start, or STARTTLS. */
export function securityOf(port: number): MailSecurity | null {
  if (port === 993 || port === 995 || port === 465) return "tls";
  if (port === 143 || port === 110 || port === 587) return "starttls";
  return null;
}

const TLS_PORT: Record<string, number> = { IMAP: 993, POP3: 995, SMTP: 465 };
const STARTTLS_PORT: Record<string, number> = { IMAP: 143, POP3: 110, SMTP: 587 };

/**
 * What went wrong reaching a mail server, in words that say what to check.
 * `side` is "IMAP", "POP3" or "SMTP".
 */
export function explain(side: string, server: Server, error: unknown): string {
  const e = error as Error & {
    code?: string;
    responseCode?: number;
    authenticationFailed?: boolean;
    response?: string;
    responseText?: string;
  };
  const raw = String(e?.responseText || e?.response || e?.message || error).trim();
  const at = `${side} (${server.host}:${server.port})`;
  const code = String(e?.code ?? "");
  if (/wrong version number|WRONG_VERSION_NUMBER|ssl3_get_record|packet length too long/i.test(raw))
    return `${at} doesn't start with TLS on this port. Choose STARTTLS for port ${server.port}, or TLS on port ${TLS_PORT[side] ?? "its TLS port"}.`;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || /getaddrinfo/i.test(raw))
    return `${at}: there's no server by that name. Check the server's name.`;
  if (code === "ECONNREFUSED" || /ECONNREFUSED/.test(raw))
    return `${at} refused the connection: nothing answers on port ${server.port}. Check the port.`;
  if (
    code === "ETIMEDOUT" ||
    code === "ETIMEOUT" ||
    code === "ESOCKET" ||
    /timed? ?out|timeout/i.test(raw)
  )
    return server.security === "starttls" && TLS_PORT[side] === server.port
      ? `${at} gave no answer: port ${server.port} expects TLS from the start. Choose TLS.`
      : `${at} gave no answer in time: the port may be wrong or blocked by a firewall (port ${server.security === "tls" ? TLS_PORT[side] : STARTTLS_PORT[side]} is usual for ${server.security === "tls" ? "TLS" : "STARTTLS"}).`;
  if (/certificate|self[- ]signed|CERT_|altnames|UNABLE_TO_VERIFY/i.test(raw + code))
    return `${at}: its certificate isn't valid for this name (${raw}). Use the server name your provider gives.`;
  if (
    e?.authenticationFailed ||
    code === "EAUTH" ||
    e?.responseCode === 535 ||
    /auth|login|credentials|password|LOGIN failed|invalid user/i.test(raw)
  )
    return `${at} refused the login (${raw}). The login is usually the full address; the password is the mailbox's own, or an app password when the provider asks for one.`;
  return `${at}: ${raw}`;
}
