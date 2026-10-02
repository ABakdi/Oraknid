import {
  type ChannelTestResult,
  DEFAULT_NOTIFICATION_SETTINGS,
  type EmailSettings,
  type NotificationChannel,
  NotificationSettings,
  type PushSubscriptionInput,
} from "@oraknid/contracts";
import {
  type Channel,
  type ChannelResult,
  createDesktopChannel,
  createEmailChannel,
  createWebPushChannel,
  generateVapidKeys,
  type Notification,
} from "@oraknid/os";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/open.ts";
import { pushSubscriptions } from "../db/schema.ts";
import type { Secrets } from "../os/secrets.ts";
import { readSetting, writeSetting } from "../settings.ts";

const SETTINGS_KEY = "notifications";
const VAPID_PUBLIC_KEY = "notifications.vapidPublicKey";
const VAPID_SECRET = "vapid.private";
const SMTP_SECRET = "smtp.password";

export interface NotificationsOptions {
  db: Db;
  secrets: Secrets;
  uiUrl: () => string;
  /** Channel overrides for tests. */
  channels?: Partial<Record<NotificationChannel, Channel>>;
  now?: () => number;
}

/**
 * The three channels of the Notifications spec, each switchable. Which
 * events go where (routing, quiet hours, grouping) arrives with the inbox
 * in M1.7; this sends to every enabled channel.
 */
export class Notifications {
  constructor(private readonly o: NotificationsOptions) {}

  settings(): NotificationSettings {
    return readSetting(
      this.o.db,
      SETTINGS_KEY,
      NotificationSettings,
      DEFAULT_NOTIFICATION_SETTINGS,
    );
  }

  update(patch: {
    desktop?: boolean;
    push?: boolean;
    email?: boolean;
    routes?: NotificationSettings["routes"];
    quietHours?: NotificationSettings["quietHours"];
  }): NotificationSettings {
    const s = this.settings();
    const next: NotificationSettings = {
      desktop: { enabled: patch.desktop ?? s.desktop.enabled },
      push: { enabled: patch.push ?? s.push.enabled },
      email: { ...s.email, enabled: patch.email ?? s.email.enabled },
      routes: patch.routes ?? s.routes,
      quietHours: patch.quietHours === undefined ? s.quietHours : patch.quietHours,
    };
    if (next.email.enabled && !next.email.server) {
      throw new Error("Set up the email server before turning email notifications on.");
    }
    writeSetting(this.o.db, SETTINGS_KEY, NotificationSettings, next);
    return next;
  }

  async configureEmail(server: EmailSettings, password?: string): Promise<NotificationSettings> {
    if (password !== undefined) await this.o.secrets.set(SMTP_SECRET, password);
    const s = this.settings();
    const next = { ...s, email: { enabled: true, server } };
    writeSetting(this.o.db, SETTINGS_KEY, NotificationSettings, next);
    return next;
  }

  /** The VAPID public key browsers subscribe with; created on first use. */
  async vapidPublicKey(): Promise<string> {
    const existing = readSetting(this.o.db, VAPID_PUBLIC_KEY, z.string(), "");
    if (existing && (await this.o.secrets.get(VAPID_SECRET))) return existing;
    const keys = generateVapidKeys();
    await this.o.secrets.set(VAPID_SECRET, keys.privateKey);
    writeSetting(this.o.db, VAPID_PUBLIC_KEY, z.string(), keys.publicKey);
    // New keys invalidate every old subscription.
    this.o.db.delete(pushSubscriptions).run();
    return keys.publicKey;
  }

  /** A device's push subscription; it goes when the device is revoked. */
  subscribe(sub: PushSubscriptionInput, deviceId: string | null = null) {
    const now = (this.o.now ?? Date.now)();
    this.o.db
      .insert(pushSubscriptions)
      .values({
        endpoint: sub.endpoint,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        deviceId,
        createdAt: now,
      })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: { p256dh: sub.keys.p256dh, auth: sub.keys.auth, deviceId },
      })
      .run();
  }

  forgetDevice(deviceId: string) {
    this.o.db.delete(pushSubscriptions).where(eq(pushSubscriptions.deviceId, deviceId)).run();
  }

  unsubscribe(endpoint: string) {
    this.o.db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint)).run();
  }

  /** Sends to every enabled channel. Returns what each one did. */
  async send(
    n: Notification,
    only?: NotificationChannel | NotificationChannel[],
  ): Promise<ChannelTestResult[]> {
    const s = this.settings();
    const enabled: Record<NotificationChannel, boolean> = {
      desktop: s.desktop.enabled,
      push: s.push.enabled,
      email: s.email.enabled,
    };
    const names: NotificationChannel[] =
      only === undefined ? ["desktop", "push", "email"] : Array.isArray(only) ? only : [only];
    return Promise.all(
      names.map(async (channel) => {
        if (!enabled[channel]) return { channel, enabled: false, delivered: 0, problems: [] };
        const result = await this.#channel(channel).then(
          (c): Promise<ChannelResult> =>
            c
              ? c.send(n)
              : Promise.resolve({ delivered: 0, problems: [this.#whyUnavailable(channel)] }),
        );
        return { channel, enabled: true, ...result };
      }),
    );
  }

  test(only?: NotificationChannel) {
    return this.send(
      {
        title: "Test notification",
        body: "Notifications from Oraknid reach you here.",
        url: this.o.uiUrl(),
        urgency: "normal",
        tag: "oraknid-test",
      },
      only,
    );
  }

  #whyUnavailable(channel: NotificationChannel): string {
    if (channel === "email")
      return "Email is not set up: add the SMTP server in Settings → Notifications.";
    return `Push needs the secret store: ${this.o.secrets.status().detail}`;
  }

  async #channel(name: NotificationChannel): Promise<Channel | undefined> {
    const override = this.o.channels?.[name];
    if (override) return override;
    if (name === "desktop") return createDesktopChannel();
    if (name === "email") {
      const server = this.settings().email.server;
      if (!server) return undefined;
      return createEmailChannel({ ...server, password: () => this.o.secrets.get(SMTP_SECRET) });
    }
    if (!this.o.secrets.status().available) return undefined;
    const publicKey = await this.vapidPublicKey();
    const privateKey = await this.o.secrets.get(VAPID_SECRET);
    if (!privateKey) return undefined;
    return createWebPushChannel({
      vapid: { publicKey, privateKey },
      subject: "https://oraknid.com",
      subscriptions: () =>
        this.o.db
          .select()
          .from(pushSubscriptions)
          .all()
          .map((r) => ({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } })),
      onExpired: (endpoint) => this.unsubscribe(endpoint),
    });
  }
}
