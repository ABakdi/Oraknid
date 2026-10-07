import type { Event } from "@oraknid/contracts";

/**
 * Events in words (Web-UI → Overview → Activity stream): what kind each is,
 * what it is called, who it is about, and its line. A Leg's output (what it
 * says, thinks and runs) is condensed to one line that opens to the rest.
 */

export type EventKind =
  | "job"
  | "task"
  | "output"
  | "leg"
  | "inbox"
  | "approvals"
  | "eye"
  | "helper"
  | "project"
  | "server"
  | "device"
  | "system";

/** The kinds, in the order the filter lists them, with their names. */
export const EVENT_KINDS: { kind: EventKind; name: string }[] = [
  { kind: "job", name: "Jobs" },
  { kind: "task", name: "Tasks" },
  { kind: "output", name: "Leg output" },
  { kind: "leg", name: "Legs" },
  { kind: "inbox", name: "Inbox" },
  { kind: "approvals", name: "Approvals and rules" },
  { kind: "eye", name: "The Eye" },
  { kind: "helper", name: "The helper" },
  { kind: "project", name: "Projects and repos" },
  { kind: "server", name: "Servers and terminal" },
  { kind: "device", name: "Devices and the lock" },
  { kind: "system", name: "Oraknid itself" },
];

/** A Leg's own output: what it said, thought, or a tool it called. */
export const isLegOutput = (e: Event) =>
  e.type.startsWith("session.") &&
  e.type !== "session.started" &&
  e.type !== "session.ended" &&
  e.type !== "session.usage";

export function eventKind(e: Event): EventKind {
  if (isLegOutput(e) || e.type.startsWith("tool.") || e.type.endsWith(".delta")) return "output";
  const head = e.type.split(".")[0] ?? "";
  switch (head) {
    case "job":
    case "budget":
    case "effect":
      return "job";
    case "task":
    case "turn":
      return "task";
    case "session":
    case "leg":
      return "leg";
    case "inbox":
      return "inbox";
    case "policy":
    case "permission":
      return "approvals";
    case "eye":
    case "silk":
      return "eye";
    case "helper":
      return "helper";
    case "project":
    case "github":
    case "folder":
    case "web":
      return "project";
    case "server":
    case "terminal":
      return "server";
    case "device":
    case "lock":
      return "device";
    default:
      return "system";
  }
}

/** What each event is called; one not listed is spelled out from its type. */
const TITLES: Record<string, string> = {
  "job.created": "Job created",
  "job.state": "Job",
  "job.named": "Job named",
  "job.queued": "Job queued",
  "job.error": "Job error",
  "job.note": "Note",
  "job.merged": "Merged",
  "job.merge-failed": "Merge failed",
  "job.deleted": "Job deleted",
  "job.ending": "Job ending",
  "job.priority": "Priority changed",
  "job.autonomy": "Autonomy changed",
  "job.draft-updated": "Draft changed",
  "job.suspicious-input": "Suspicious input",
  "job.safe-point-overdue": "Safe point overdue",
  "job.unsandboxed": "Runs unsandboxed",
  "job.leg-cancelled": "Leg's work cancelled",
  "task.state": "Task",
  "task.drift": "Drift",
  "task.waiting": "Task waiting",
  "task.waiting-for-leg": "Waiting for a Leg",
  "task.verified": "Checked",
  "task.verifying": "Checking",
  "task.evaluated": "Reviewed",
  "task.checks-tried": "Checks run",
  "task.actions-uncertain": "Uncertain actions",
  "task.provider-failed": "Provider failed",
  "task.leg-limited": "Leg at its limit",
  "turn.started": "Turn started",
  "turn.ended": "Turn ended",
  "session.started": "Session started",
  "session.ended": "Session ended",
  "session.text": "Said",
  "session.thinking": "Thought",
  "session.tool.called": "Ran",
  "session.tool.result": "Result",
  "tool.called": "Tool",
  "tool.result": "Tool result",
  "leg.health": "Leg health",
  "inbox.opened": "Asks you",
  "inbox.answered": "Answered",
  "inbox.withdrawn": "Withdrawn",
  "policy.decision": "Approval",
  "policy.waived": "Gate waived",
  "policy.updated": "Rules changed",
  "policy.judged": "Judged",
  "permission.denied": "Denied",
  "eye.planned": "The Eye planned",
  "eye.answered": "The Eye answered",
  "helper.message": "Helper",
  "helper.action": "The helper did",
  "budget.reached": "Budget reached",
  "budget.changed": "Budget changed",
  "budget.raised": "Budget raised",
  "terminal.opened": "Terminal opened",
  "terminal.closed": "Terminal closed",
  "device.paired": "Device paired",
  "device.revoked": "Device revoked",
  "device.rights": "Device rights",
  "device.awayUse": "Used away from home",
  "lock.wrong-pin": "Wrong PIN",
  "lock.locked": "Locked",
  "system.started": "Oraknid started",
  "system.stopping": "Oraknid stopping",
  "system.recovered": "Recovered",
  "update.available": "Update available",
  "update.started": "Updating",
  "update.finished": "Updated",
  "machine.incident": "The computer",
  "project.created": "Project created",
  "project.deleted": "Project deleted",
  "settings.updated": "Setting changed",
};

export function eventTitle(e: Event): string {
  const known = TITLES[e.type];
  if (known) return known;
  const words = e.type.replace(/[.-]/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}

/** The Leg an event is about: the one that wrote it, or the one it names. */
export function legOf(e: Event): string | null {
  if (e.actor.startsWith("leg:")) return e.actor.slice(4);
  const p = (e.payload ?? {}) as Record<string, unknown>;
  return typeof p.legId === "string" ? p.legId : null;
}

export function isProblem(e: Event): boolean {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  return (
    e.type === "job.error" ||
    e.type === "task.drift" ||
    e.type === "budget.reached" ||
    e.type === "job.suspicious-input" ||
    e.type === "job.safe-point-overdue" ||
    (e.type === "job.state" && p.to === "blocked") ||
    (e.type === "session.ended" && (p.reason === "crashed" || p.reason === "rate-limited")) ||
    (e.type === "leg.health" && (p.to === "unavailable" || p.to === "rate-limited"))
  );
}

/** One line per event, in words where the payload allows. */
export function describe(e: Event): string {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  // Full rights used away from home (ADR-030), by a call or through the helper.
  if (e.type === "device.awayUse")
    return `${String(p.path ?? "")}${p.via === "helper" ? " (through the helper)" : ""}`;
  if (typeof p.text === "string") return p.text;
  if (typeof p.message === "string") return p.message;
  if (typeof p.title === "string") return p.title;
  if (typeof p.evidence === "string") return `${p.code}: ${p.evidence} → ${p.step}`;
  if (typeof p.reason === "string" && p.to) return `→ ${p.to}: ${p.reason}`;
  if (p.to) return `→ ${String(p.to)}`;
  if (typeof p.detail === "string") return p.detail;
  if (typeof p.tool === "string")
    return `${p.tool} ${typeof p.input === "object" && p.input && "command" in p.input ? String((p.input as { command: string }).command) : ""}`.trim();
  if (typeof p.name === "string" && typeof p.summary === "string") return p.summary;
  if (typeof p.path === "string") return p.path;
  if (typeof p.target === "string") return p.target;
  if (typeof p.reason === "string") return p.reason;
  return "";
}

/** A long output condensed to its first line, cut at `max`; null when it is short already. */
export function condense(text: string, max = 140): string | null {
  const first = text.trimStart().split("\n")[0] ?? "";
  const line = first.length > max ? `${first.slice(0, max)}…` : first;
  return line === text.trim() ? null : line + (line.endsWith("…") ? "" : " …");
}
