import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

// ADR-070: Oraknid never starts the desktop keychain itself. A Secret
// Service call made before the session's keyring is up D-Bus-activates
// one of its own, locked (no login has unlocked it), whose unlock prompt
// can't show and whose call never returns; the session's keyring then
// finds "another daemon" (seen 2026-10-16, gnome-keyring started by
// Oraknid 30 s before the Wayland session). So before any call: is
// `org.freedesktop.secrets` owned already (asked of the bus itself, which
// starts nothing), and is its default collection unlocked (a property read
// that may not start anything either). Never Unlock, never a prompt.

export const SECRETS_NAME = "org.freedesktop.secrets";

/**
 * What the bus says of the Secret Service:
 * - `no-bus`: no session bus at all (a headless machine): no keychain here;
 * - `absent`: nobody owns the name yet (the desktop isn't up);
 * - `locked`: its default collection is locked (waiting for a login or an unlock);
 * - `unlocked`: calls may be made;
 * - `unknown`: no tool to ask the bus with: calls are made, bounded as always.
 */
export type SecretServiceState = "no-bus" | "absent" | "locked" | "unlocked" | "unknown";

export type Gate = () => Promise<SecretServiceState>;

/** A command's output, or null when it failed, didn't exist or took too long. */
export type BusRun = (file: string, args: string[]) => Promise<string | null>;

const defaultBusRun: BusRun = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: 3000, encoding: "utf8" }, (error, stdout) =>
      resolve(error ? null : stdout),
    );
  });

/** The session bus is there: its address in the environment, or the usual socket. */
export function hasSessionBus(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.DBUS_SESSION_BUS_ADDRESS) return true;
  const uid = process.getuid?.();
  const runtime = env.XDG_RUNTIME_DIR ?? (uid === undefined ? undefined : `/run/user/${uid}`);
  return !!runtime && existsSync(`${runtime}/bus`);
}

const truth = (out: string | null): boolean | null => {
  if (out === null) return null;
  if (/\b(true|yes)\b/i.test(out)) return true;
  if (/\b(false|no)\b/i.test(out)) return false;
  return null;
};

/**
 * Asks the session bus through busctl (systemd), else dbus-send. Neither
 * question starts a service: NameHasOwner is answered by the bus, and the
 * Locked property is read only once the name has an owner (busctl with
 * auto-start off as well).
 */
export function secretServiceGate(o: { run?: BusRun; env?: NodeJS.ProcessEnv } = {}): Gate {
  const run = o.run ?? defaultBusRun;
  return async () => {
    if (!hasSessionBus(o.env)) return "no-bus";
    let owned = truth(
      await run("busctl", [
        "--user",
        "call",
        "org.freedesktop.DBus",
        "/org/freedesktop/DBus",
        "org.freedesktop.DBus",
        "NameHasOwner",
        "s",
        SECRETS_NAME,
      ]),
    );
    let via: "busctl" | "dbus-send" = "busctl";
    if (owned === null) {
      via = "dbus-send";
      owned = truth(
        await run("dbus-send", [
          "--session",
          "--print-reply",
          "--dest=org.freedesktop.DBus",
          "/org/freedesktop/DBus",
          "org.freedesktop.DBus.NameHasOwner",
          `string:${SECRETS_NAME}`,
        ]),
      );
    }
    if (owned === null) return "unknown";
    if (!owned) return "absent";
    const collection = "/org/freedesktop/secrets/aliases/default";
    const locked = truth(
      via === "busctl"
        ? await run("busctl", [
            "--user",
            "--auto-start=no",
            "get-property",
            SECRETS_NAME,
            collection,
            "org.freedesktop.Secret.Collection",
            "Locked",
          ])
        : await run("dbus-send", [
            "--session",
            "--print-reply",
            `--dest=${SECRETS_NAME}`,
            collection,
            "org.freedesktop.DBus.Properties.Get",
            "string:org.freedesktop.Secret.Collection",
            "string:Locked",
          ]),
    );
    // No default collection to read, or no answer: as good as locked; a call would prompt.
    return locked === false ? "unlocked" : "locked";
  };
}
