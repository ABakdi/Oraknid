import { spawn } from "node:child_process";
import type { Channel, Notification } from "../notifier.ts";

export interface DesktopOptions {
  notifySend?: string;
  /** Opens a URL when the notification's "Open" action is clicked. */
  open?: (url: string) => void;
}

/**
 * Native notifications through notify-send (freedesktop). With a URL, the
 * notification carries an "Open" action; notify-send waits for the click
 * in the background and prints the action's key.
 */
export function createDesktopChannel(options: DesktopOptions = {}): Channel {
  const command = options.notifySend ?? "notify-send";
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
        // With --wait it keeps running until clicked or dismissed: count it as shown
        // unless it fails straight away.
        const timer = setTimeout(() => resolve({ delivered: 1, problems: [] }), 300);
        child.once("exit", (code) => {
          if (code === 0) return;
          clearTimeout(timer);
          resolve({ delivered: 0, problems: [`notify-send failed: ${stderr.trim() || code}`] });
        });
      });
    },
  };
}
