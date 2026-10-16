import { type ChildProcess, spawn } from "node:child_process";
import type { Channel, Notification } from "../notifier.ts";

interface Waiter {
  child: ChildProcess;
  tag: string | undefined;
  timer: NodeJS.Timeout;
}

/**
 * The notify-send processes still waiting for a click (ADR-070): a few at
 * most, each for a while at most. Seen 2026-10-16: 17 of them alive for
 * 15 to 20 minutes, each holding its own D-Bus connection.
 */
export class NotifyWaiters {
  readonly #waiting: Waiter[] = [];

  constructor(
    private readonly o: {
      /** Waiting at once; the oldest is let go for a new one. */
      max?: number;
      /** How long one waits for its click. */
      lifetimeMs?: number;
    } = {},
  ) {}

  /** Those waiting now. */
  count() {
    return this.#waiting.length;
  }

  /** One more waiting: the one of the same tag (it replaces it on screen) and the oldest past the cap go. */
  add(child: ChildProcess, tag: string | undefined) {
    if (tag) for (const w of this.#waiting.filter((w) => w.tag === tag)) this.#end(w);
    while (this.#waiting.length >= Math.max(1, this.o.max ?? 4)) {
      const oldest = this.#waiting[0];
      if (!oldest) break;
      this.#end(oldest);
    }
    const timer = setTimeout(() => this.#end(entry), this.o.lifetimeMs ?? 10 * 60_000);
    timer.unref();
    const entry = { child, tag, timer };
    this.#waiting.push(entry);
    child.once("exit", () => this.#forget(entry));
  }

  /** Every one ended (the daemon stopping). */
  stopAll() {
    for (const w of [...this.#waiting]) this.#end(w);
  }

  #forget(w: Waiter) {
    clearTimeout(w.timer);
    const i = this.#waiting.indexOf(w);
    if (i >= 0) this.#waiting.splice(i, 1);
  }

  #end(w: Waiter) {
    this.#forget(w);
    if (w.child.exitCode !== null || w.child.signalCode !== null) return;
    w.child.kill("SIGTERM");
    setTimeout(() => {
      if (w.child.exitCode === null && w.child.signalCode === null) w.child.kill("SIGKILL");
    }, 2000).unref();
  }
}

/** The daemon's own: shared by every desktop channel it makes. */
export const desktopWaiters = new NotifyWaiters();

export interface DesktopOptions {
  notifySend?: string;
  /** Opens a URL when the notification's "Open" action is clicked. */
  open?: (url: string) => void;
  /** Where the processes waiting for a click are kept (tests); the daemon's otherwise. */
  waiters?: NotifyWaiters;
}

/**
 * Native notifications through notify-send (freedesktop). With a URL, the
 * notification carries an "Open" action; notify-send waits for the click
 * in the background and prints the action's key, a few at most and for
 * ten minutes at most (ADR-070).
 */
export function createDesktopChannel(options: DesktopOptions = {}): Channel {
  const command = options.notifySend ?? "notify-send";
  const waiters = options.waiters ?? desktopWaiters;
  const open =
    options.open ??
    ((url: string) => spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref());

  return {
    name: "desktop",
    send(n: Notification) {
      const args = ["--app-name=Oraknid", `--urgency=${n.urgency}`];
      if (n.tag) args.push(`--hint=string:x-canonical-private-synchronous:${n.tag}`);
      if (n.url) args.push("--action=open=Open", "--wait");
      args.push(n.title, n.body);

      return new Promise((resolve) => {
        const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
        let stderr = "";
        child.stderr.on("data", (d) => {
          stderr += d;
        });
        child.stdout.on("data", (d) => {
          if (n.url && String(d).trim() === "open") open(n.url);
        });
        child.once("error", (e) =>
          resolve({ delivered: 0, problems: [`Desktop notification failed: ${e.message}`] }),
        );
        // Without --wait, notify-send exits once the notification is shown.
        if (!n.url) {
          child.once("exit", (code) =>
            resolve(
              code === 0
                ? { delivered: 1, problems: [] }
                : { delivered: 0, problems: [`notify-send failed: ${stderr.trim() || code}`] },
            ),
          );
          return;
        }
        // With --wait it keeps running until clicked or dismissed: kept with the others
        // waiting, and counted as shown unless it fails straight away.
        if (child.pid !== undefined) waiters.add(child, n.tag);
        const timer = setTimeout(() => resolve({ delivered: 1, problems: [] }), 300);
        child.once("exit", (code, signal) => {
          if (code === 0 || signal) return;
          clearTimeout(timer);
          resolve({ delivered: 0, problems: [`notify-send failed: ${stderr.trim() || code}`] });
        });
      });
    },
  };
}
