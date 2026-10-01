import type { Event, NotificationChannel, NotifyEvent } from "@oraknid/contracts";
import { heldByQuietHours, inQuietHours, routeFor } from "@oraknid/core";
import type { Notification } from "@oraknid/os";
import { eq } from "drizzle-orm";
import type { Db } from "../db/open.ts";
import { jobs } from "../db/schema.ts";
import type { EventBus } from "../events/bus.ts";
import type { InboxStore } from "../inbox/store.ts";
import type { Notifications } from "./notifications.ts";

interface Pending {
  event: NotifyEvent;
  n: Notification;
  jobId: string | null;
}

/**
 * Turns the event stream into notifications (docs/01-Specification/Notifications.md):
 * the routing table and my changes to it, quiet hours, grouping, and
 * email only after an inbox item has waited.
 */
export function startNotificationRouter(o: {
  db: Db;
  bus: EventBus;
  inbox: InboxStore;
  notifications: Notifications;
  uiUrl: () => string;
  now?: () => Date;
  emailDelayMs?: number;
  flushMs?: number;
}) {
  const now = o.now ?? (() => new Date());
  const held: Pending[] = [];
  const timers = new Set<NodeJS.Timeout>();

  const running = (jobId: string | null) => {
    if (!jobId) return false;
    const state = o.db.select({ s: jobs.state }).from(jobs).where(eq(jobs.id, jobId)).get()?.s;
    return (
      state === "running" || state === "planning" || state === "verifying" || state === "waiting"
    );
  };

  async function deliver(p: Pending, itemId: string | null) {
    const settings = o.notifications.settings();
    if (heldByQuietHours(p.event, running(p.jobId), inQuietHours(settings.quietHours, now()))) {
      held.push(p);
      return;
    }
    const route = routeFor(p.event, settings.routes);
    const channels: NotificationChannel[] = [];
    if (route.desktop) channels.push("desktop");
    if (route.push) channels.push("push");
    if (route.email === "now") channels.push("email");
    if (channels.length) {
      const results = await o.notifications.send(p.n, channels);
      o.bus.publish({
        type: "notification.sent",
        topic: "overview",
        jobId: p.jobId,
        payload: { event: p.event, title: p.n.title, results },
      });
    }
    if (route.email === "after-15-min" && itemId) {
      const t = setTimeout(
        () => {
          timers.delete(t);
          if (o.inbox.get(itemId)?.state === "open")
            void o.notifications
              .send(p.n, ["email"])
              .catch((err) => console.error("email reminder failed", err));
        },
        o.emailDelayMs ?? 15 * 60_000,
      );
      t.unref();
      timers.add(t);
    }
  }

  const url = (path: string) => `${o.uiUrl()}${path}`;

  function fromEvent(e: Event): { p: Pending; itemId: string | null } | null {
    const payload = (e.payload ?? {}) as Record<string, unknown>;
    switch (e.type) {
      case "inbox.opened": {
        const item = o.inbox.get(String(payload.id));
        if (!item) return null;
        const escalation = item.title.includes("keeps going wrong");
        const event: NotifyEvent =
          item.kind === "approval" ? "approval" : escalation ? "escalation" : "question";
        // Grouped: one notification that says how many wait, replacing the last one.
        const open = o.inbox.list("open").filter((i) => i.kind === item.kind).length;
        const body =
          open > 1
            ? `${open} ${item.kind === "approval" ? "approvals" : "questions"} waiting. Latest: ${item.title}`
            : item.title;
        return {
          p: {
            event,
            jobId: item.jobId,
            n: {
              title:
                item.kind === "approval"
                  ? "Approval needed"
                  : escalation
                    ? "A task keeps going wrong"
                    : "A question for you",
              body,
              url: url(`/inbox/${item.id}`),
              urgency: item.kind === "approval" || escalation ? "critical" : "normal",
              tag: `inbox-${item.kind}`,
            },
          },
          itemId: item.id,
        };
      }
      case "job.state": {
        const to = payload.to;
        if (to !== "completed" && to !== "blocked") return null;
        const job = e.jobId
          ? o.db.select().from(jobs).where(eq(jobs.id, e.jobId)).get()
          : undefined;
        return {
          p: {
            event: to === "completed" ? "job.completed" : "job.blocked",
            jobId: e.jobId,
            n: {
              title:
                to === "completed"
                  ? `Done: ${job?.title ?? "a job"}`
                  : `Blocked: ${job?.title ?? "a job"}`,
              body:
                to === "completed"
                  ? "Verified and complete."
                  : String(payload.reason ?? "It cannot continue."),
              url: url(`/jobs/${e.jobId}`),
              urgency: to === "completed" ? "normal" : "critical",
              tag: `job-${e.jobId}`,
            },
          },
          itemId: null,
        };
      }
      case "budget.warning":
      case "budget.reached":
      case "budget.alarm":
        if (e.topic === "overview") return null;
        return {
          p: {
            event: e.type === "budget.alarm" ? "time.alarm" : "budget",
            jobId: e.jobId,
            n: {
              title: e.type === "budget.alarm" ? "Time to look" : "Budget",
              body: String(payload.message ?? ""),
              url: url(`/jobs/${e.jobId}`),
              urgency: e.type === "budget.reached" ? "critical" : "normal",
              tag: `budget-${e.jobId}`,
            },
          },
          itemId: null,
        };
      case "system.recovered": {
        const s = payload as { jobsResumed?: string[]; effectsNeedingMe?: number };
        return {
          p: {
            event: "recovered",
            jobId: null,
            n: {
              title: "Oraknid recovered",
              body: `After a stop: ${s.jobsResumed?.length ?? 0} job(s) resumed${s.effectsNeedingMe ? `, ${s.effectsNeedingMe} action(s) need your answer` : ""}.`,
              url: url("/"),
              urgency: "normal",
              tag: "recovered",
            },
          },
          itemId: null,
        };
      }
      default:
        return null;
    }
  }

  const off = o.bus.subscribe((e) => {
    const mapped = fromEvent(e);
    if (mapped)
      void deliver(mapped.p, mapped.itemId).catch((err) =>
        console.error("notification failed", err),
      );
  });

  // What quiet hours held goes out when they end.
  const flush = setInterval(() => {
    if (held.length === 0 || inQuietHours(o.notifications.settings().quietHours, now())) return;
    for (const p of held.splice(0))
      void deliver(p, null).catch((err) => console.error("held notification failed", err));
  }, o.flushMs ?? 60_000);
  flush.unref();

  return {
    held: () => [...held],
    stop() {
      off();
      clearInterval(flush);
      for (const t of timers) clearTimeout(t);
    },
  };
}
