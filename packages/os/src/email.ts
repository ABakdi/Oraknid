import nodemailer, { type Transporter } from "nodemailer";
import type { Channel, Notification } from "./notifier.ts";

export interface EmailOptions {
  host: string;
  port: number;
  /** TLS from the start (465); otherwise STARTTLS is required. */
  secure: boolean;
  user: string;
  from: string;
  to: string;
  /** Resolved from the secret store at send time, never kept around (BR-13). */
  password: () => Promise<string | undefined>;
  /** For tests: a nodemailer transport to use instead of SMTP. */
  transport?: Transporter;
}

/** Email via my SMTP server. Links to the UI; never an approve button (Notifications spec). */
export function createEmailChannel(options: EmailOptions): Channel {
  return {
    name: "email",
    async send(n: Notification) {
      const transport =
        options.transport ??
        nodemailer.createTransport({
          host: options.host,
          port: options.port,
          secure: options.secure,
          requireTLS: !options.secure,
          auth: { user: options.user, pass: (await options.password()) ?? "" },
        });
      const text = n.url ? `${n.body}\n\nOpen in Oraknid: ${n.url}\n` : `${n.body}\n`;
      try {
        await transport.sendMail({
          from: options.from,
          to: options.to,
          subject: `Oraknid: ${n.title}`,
          text,
        });
        return { delivered: 1, problems: [] };
      } catch (error) {
        return { delivered: 0, problems: [`Email failed: ${(error as Error).message}`] };
      }
    },
  };
}
