import { z } from "zod";

// Notification settings (docs/01-Specification/Notifications.md). Secrets
// (the SMTP password, the VAPID private key) live in the secret store.

export const EmailSettings = z.object({
  host: z.string().min(1),
  port: z.number().int().positive(),
  secure: z.boolean(),
  user: z.string().min(1),
  from: z.email(),
  to: z.email(),
});
export type EmailSettings = z.infer<typeof EmailSettings>;

export const NotifyEvent = z.enum([
  "approval",
  "question",
  "job.completed",
  "job.blocked",
  "escalation",
  "budget",
  "time.alarm",
  "recovered",
  "leg.unavailable",
  /** Wrong PINs, a device unpaired by them (ADR-029). */
  "security",
  /** A database backup failed (ADR-044). */
  "backup.failed",
  /** A new release of Oraknid, once per version (ADR-048). */
  "update.available",
  /** The machine in danger: memory, swap, disk, a runaway session (ADR-050), once per incident. */
  "machine.danger",
]);
export type NotifyEvent = z.infer<typeof NotifyEvent>;

/** Email can go at once, never, or only after an item has waited 15 minutes unanswered. */
export const Route = z.object({
  desktop: z.boolean(),
  push: z.boolean(),
  email: z.enum(["now", "after-15-min", "never"]),
});
export type Route = z.infer<typeof Route>;

export const QuietHours = z.object({
  /** "22:00" */
  from: z.string().regex(/^\d{2}:\d{2}$/),
  to: z.string().regex(/^\d{2}:\d{2}$/),
});
export type QuietHours = z.infer<typeof QuietHours>;

export const NotificationSettings = z.object({
  desktop: z.object({ enabled: z.boolean() }),
  push: z.object({ enabled: z.boolean() }),
  email: z.object({ enabled: z.boolean(), server: EmailSettings.nullable() }),
  /** My changes to the default routing table (Notifications → Events and default routing). */
  routes: z.partialRecord(NotifyEvent, Route).default({}),
  quietHours: QuietHours.nullable().default(null),
});
export type NotificationSettings = z.infer<typeof NotificationSettings>;

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  desktop: { enabled: true },
  push: { enabled: true },
  // Off until configured.
  email: { enabled: false, server: null },
  routes: {},
  quietHours: null,
};

export const NotificationChannel = z.enum(["desktop", "push", "email"]);
export type NotificationChannel = z.infer<typeof NotificationChannel>;

export const ChannelTestResult = z.object({
  channel: NotificationChannel,
  enabled: z.boolean(),
  delivered: z.number().int().nonnegative(),
  problems: z.array(z.string()),
});
export type ChannelTestResult = z.infer<typeof ChannelTestResult>;

/** The browsers' push services: the daemon posts nowhere else (Audit 2). */
const PUSH_HOSTS = [".googleapis.com", ".mozilla.com", ".push.apple.com", ".notify.windows.com"];

export const PushSubscriptionInput = z.object({
  endpoint: z.url().refine(
    (u) => {
      const url = new URL(u);
      return url.protocol === "https:" && PUSH_HOSTS.some((h) => url.hostname.endsWith(h));
    },
    { message: "That isn't a browser push service's address." },
  ),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
});
export type PushSubscriptionInput = z.infer<typeof PushSubscriptionInput>;
