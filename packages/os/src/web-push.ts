import type { Agent } from "node:https";
import webpush from "web-push";
import type { Channel, Notification } from "./notifier.ts";

export interface PushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export const generateVapidKeys = (): VapidKeys => webpush.generateVAPIDKeys();

export interface WebPushOptions {
  vapid: VapidKeys;
  /** A mailto: or https: contact, required by push services. */
  subject: string;
  subscriptions: () => PushSubscription[];
  /** Called for subscriptions the push service says are gone (404/410). */
  onExpired: (endpoint: string) => void;
  /** For tests: the HTTPS agent used to reach push services. */
  agent?: Agent;
}

/** Web push to every subscribed device (PWA), signed with VAPID. */
export function createWebPushChannel(options: WebPushOptions): Channel {
  return {
    name: "push",
    async send(n: Notification) {
      const payload = JSON.stringify({
        title: n.title,
        body: n.body,
        url: n.url ?? null,
        tag: n.tag ?? null,
        urgency: n.urgency,
      });
      const subs = options.subscriptions();
      const results = await Promise.allSettled(
        subs.map((sub) =>
          webpush.sendNotification(sub, payload, {
            vapidDetails: { subject: options.subject, ...options.vapid },
            urgency: n.urgency === "critical" ? "high" : n.urgency,
            TTL: 24 * 60 * 60,
            ...(options.agent ? { agent: options.agent } : {}),
            ...(n.tag ? { topic: n.tag.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) } : {}),
          }),
        ),
      );
      let delivered = 0;
      const problems: string[] = [];
      results.forEach((r, i) => {
        const sub = subs[i] as PushSubscription;
        if (r.status === "fulfilled") {
          delivered++;
          return;
        }
        const status = (r.reason as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          options.onExpired(sub.endpoint);
          problems.push(`A device's push subscription has expired and was removed.`);
        } else {
          problems.push(`Push to a device failed: ${(r.reason as Error).message}`);
        }
      });
      return { delivered, problems };
    },
  };
}
