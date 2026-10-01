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

export const PushSubscriptionInput = z.object({
  endpoint: z.url(),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
});
export type PushSubscriptionInput = z.infer<typeof PushSubscriptionInput>;
