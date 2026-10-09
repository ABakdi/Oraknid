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
  /** The review an inbox item tells me about (ADR-064): its notification opens the review. */
  reviewOf?: (itemId: string) => { id: string; kind: "design" | "app" } | null;
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
  /** The sleep lock's failure was told; told again only after it was held once more. */
  let sleepWarned = false;

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
        // The job by its name (Jobs-and-Projects → A job's name and description).
        const jobTitle = item.jobId
          ? o.db.select({ title: jobs.title }).from(jobs).where(eq(jobs.id, item.jobId)).get()
              ?.title
          : undefined;
        // A review waiting (ADR-064): its own words, and it opens the review page.
        const review = o.reviewOf?.(item.id) ?? null;
        if (review)
          return {
            p: {
              event: "question",
              jobId: item.jobId,
              n: {
                title:
                  review.kind === "design"
                    ? "A design is ready for your review"
                    : "The app is ready for your review",
                body: jobTitle ? `${item.title} — ${jobTitle}` : item.title,
                url: url(`/review/${review.id}`),
                urgency: "normal",
                tag: `review-${review.id}`,
              },
            },
            itemId: item.id,
          };
        const body =
          open > 1
            ? `${open} ${item.kind === "approval" ? "approvals" : "questions"} waiting. Latest: ${item.title}`
            : jobTitle
              ? `${item.title} — ${jobTitle}`
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
                  ? job?.description
                    ? `Verified and complete. ${job.description}`
                    : "Verified and complete."
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
      case "lock.wrong-pin": {
        const w = payload as { count?: number; notify?: boolean; remote?: boolean };
        if (!w.notify && (w.count ?? 0) < 10) return null;
        return {
          p: {
            event: "security",
            jobId: null,
            n: {
              title: (w.count ?? 0) >= 10 ? "A device was unpaired" : "Wrong PINs",
              body:
                (w.count ?? 0) >= 10
                  ? "Ten wrong PINs: that device can't reach Oraknid any more."
                  : `${w.count} wrong PINs on one device${w.remote ? ", away from home" : ""}. If it wasn't you, unpair it.`,
              url: url("/settings/devices"),
              urgency: "critical",
              tag: "security",
            },
          },
          itemId: null,
        };
      }
      case "backup.failed": {
        // A database backup that failed (ADR-044): its error is already in plain words.
        const b = payload as { planId?: string; name?: string; error?: string };
        return {
          p: {
            event: "backup.failed",
            jobId: null,
            n: {
              title: `Backup failed: ${b.name ?? "a plan"}`,
              body: b.error ?? "It stopped without saying why.",
              url: url("/settings/backups"),
              urgency: "critical",
              tag: `backup-${b.planId ?? ""}`,
            },
          },
          itemId: null,
        };
      }
      case "update.available": {
        // A new release, once per version (ADR-048).
        const u = payload as { tag?: string; name?: string };
        return {
          p: {
            event: "update.available",
            jobId: null,
            n: {
              title: `Update available: ${u.tag ?? "a new version"}`,
              body: `${u.name && u.name !== u.tag ? `${u.name}. ` : ""}Update from Settings → About & updates.`,
              url: url("/settings/about"),
              urgency: "normal",
              tag: "update",
            },
          },
          itemId: null,
        };
      }
      case "machine.incident": {
        // The computer in danger (ADR-050): once per incident, what happens and what Oraknid did.
        const m = payload as { kind?: string; level?: string; message?: string; did?: string };
        // Busy with my own work is shown, not sent.
        if (m.kind === "busy") return null;
        return {
          p: {
            event: "machine.danger",
            jobId: null,
            n: {
              title:
                m.level === "danger" ? "Your computer is in danger" : "Your computer needs a look",
              body: [m.message, m.did].filter(Boolean).join(" "),
              url: url("/"),
              urgency: m.level === "danger" ? "critical" : "normal",
              tag: `machine-${m.kind ?? ""}`,
            },
          },
          itemId: null,
        };
      }
      case "ci.failed": {
        // A run on a linked repo's release or work branch failed (ADR-058), told once.
        const c = payload as {
          projectId?: string;
          projectName?: string;
          fullName?: string;
          branch?: string;
          name?: string;
          failing?: string | null;
          runId?: number;
        };
        return {
          p: {
            event: "ci.failed",
            jobId: null,
            n: {
              title: `CI failed: ${c.projectName ?? c.fullName ?? "a project"} · ${c.branch ?? ""}`,
              body: `${c.name ?? "A workflow"} failed on ${c.fullName ?? "the repo"}${c.failing ? `: ${c.failing}` : ""}.`,
              url: url(c.projectId ? `/projects/${c.projectId}/ci` : "/repos"),
              urgency: "normal",
              tag: `ci-${c.fullName ?? ""}-${c.branch ?? ""}`,
            },
          },
          itemId: null,
        };
      }
      case "job.auto-resumed": {
        // Paused for quota, resumed by itself at the reset (Budgets-and-Quotas → When everything runs out).
        const job = e.jobId
          ? o.db.select().from(jobs).where(eq(jobs.id, e.jobId)).get()
          : undefined;
        return {
          p: {
            event: "job.resumed",
            jobId: e.jobId,
            n: {
              title: `Resumed: ${job?.title ?? "a job"}`,
              body: String(payload.reason ?? "Its agents have quota again; it goes on."),
              url: url(`/jobs/${e.jobId}`),
              urgency: "normal",
              tag: `job-${e.jobId}`,
            },
          },
          itemId: null,
        };
      }
      case "system.inhibitor": {
        // Taking the sleep lock failed: once, until it is held again (Durability → Sleep inhibition).
        const s = payload as { held?: boolean; problem?: string | null };
        if (s.held) {
          sleepWarned = false;
          return null;
        }
        if (!s.problem || sleepWarned) return null;
        sleepWarned = true;
        return {
          p: {
            event: "sleep.problem",
            jobId: null,
            n: {
              title: "Can't keep the computer awake",
              body: `${s.problem} The jobs go on, but the computer may sleep.`,
              url: url("/settings/about"),
              urgency: "normal",
              tag: "sleep-problem",
            },
          },
          itemId: null,
        };
      }
      case "site.down":
      case "site.up": {
        // A site down twice in a row, then back (ADR-060): once each.
        const s = payload as { id?: string; host?: string; error?: string; downForMs?: number };
        const down = e.type === "site.down";
        const mins = Math.max(1, Math.round((s.downForMs ?? 0) / 60_000));
        return {
          p: {
            event: down ? "site.down" : "site.up",
            jobId: null,
            n: {
              title: down ? `Down: ${s.host ?? "a site"}` : `Up again: ${s.host ?? "a site"}`,
              body: down
                ? `${s.error ?? "No answer."} Two checks in a row from this computer failed.`
                : `It answers again, after about ${mins} minute${mins === 1 ? "" : "s"} down.`,
              url: url("/servers/sites"),
              urgency: down ? "critical" : "normal",
              tag: `site-${s.id ?? ""}`,
            },
          },
          itemId: null,
        };
      }
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
