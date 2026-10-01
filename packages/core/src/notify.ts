import type { NotifyEvent, QuietHours, Route } from "@oraknid/contracts";

// Notification routing (docs/01-Specification/Notifications.md → Events and default routing).

export const DEFAULT_ROUTES: Record<NotifyEvent, Route> = {
  approval: { desktop: true, push: true, email: "after-15-min" },
  question: { desktop: true, push: true, email: "after-15-min" },
  "job.completed": { desktop: true, push: true, email: "now" },
  "job.blocked": { desktop: true, push: true, email: "now" },
  escalation: { desktop: true, push: true, email: "now" },
  budget: { desktop: true, push: true, email: "never" },
  "time.alarm": { desktop: true, push: true, email: "now" },
  recovered: { desktop: true, push: true, email: "never" },
  "leg.unavailable": { desktop: false, push: false, email: "never" },
};

export const routeFor = (event: NotifyEvent, mine: Partial<Record<NotifyEvent, Route>>): Route =>
  mine[event] ?? DEFAULT_ROUTES[event];

const minutes = (hhmm: string) => {
  const [h = 0, m = 0] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

/** Whether `at` (local time) falls inside quiet hours, which may wrap past midnight. */
export function inQuietHours(q: QuietHours | null, at: Date): boolean {
  if (!q) return false;
  const now = at.getHours() * 60 + at.getMinutes();
  const from = minutes(q.from);
  const to = minutes(q.to);
  return from <= to ? now >= from && now < to : now >= from || now < to;
}

/** Quiet hours hold everything except approvals for running jobs. */
export const heldByQuietHours = (event: NotifyEvent, jobRunning: boolean, quiet: boolean) =>
  quiet && !(event === "approval" && jobRunning);
