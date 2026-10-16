import { describe, expect, it } from "vitest";
import { createKeychainStore, type KeychainClient, KeychainLink } from "./keychain.ts";
import { type BusRun, secretServiceGate } from "./secret-service-gate.ts";

// ADR-070: Oraknid never starts the desktop keychain itself, nor asks it
// to unlock. A stand-in session bus: never the real one.

/** A bus whose Secret Service is absent, locked or unlocked, as the test says. */
function fakeBus(tool: "busctl" | "dbus-send" = "busctl") {
  const calls: string[][] = [];
  let state: "absent" | "locked" | "unlocked" = "absent";
  const run: BusRun = async (file, args) => {
    calls.push([file, ...args]);
    if (file !== tool) return null;
    const yes = (b: boolean) => (tool === "busctl" ? `b ${b}` : `   boolean ${b}`);
    if (args.some((a) => a.includes("NameHasOwner"))) return yes(state !== "absent");
    // Anything sent to the Secret Service itself while nobody owns it would start it.
    if (state === "absent") throw new Error(`activation: ${args.join(" ")}`);
    if (args.includes("Locked") || args.includes("string:Locked")) return yes(state === "locked");
    return null;
  };
  return {
    run,
    calls,
    set: (s: typeof state) => {
      state = s;
    },
  };
}

/** A keychain client that counts the calls it was asked. */
function counting() {
  const kept = new Map<string, string>();
  let made = 0;
  let asked = 0;
  const connect = (): KeychainClient => {
    made++;
    return {
      async get(s, n) {
        asked++;
        return kept.get(`${s}/${n}`);
      },
      async set(s, n, v) {
        asked++;
        kept.set(`${s}/${n}`, v);
      },
      async delete(s, n) {
        asked++;
        return kept.delete(`${s}/${n}`);
      },
      async find() {
        asked++;
        return [];
      },
    };
  };
  return { connect, kept, made: () => made, asked: () => asked };
}

const env = { DBUS_SESSION_BUS_ADDRESS: "unix:path=/nowhere" };

describe("the Secret Service gate", () => {
  for (const tool of ["busctl", "dbus-send"] as const)
    it(`with ${tool}: no owner, no call; unlocked, calls; locked, waits and never prompts`, async () => {
      const bus = fakeBus(tool);
      const c = counting();
      let now = 0;
      const link = new KeychainLink(c.connect, {
        gate: secretServiceGate({ run: bus.run, env }),
        now: () => now,
      });
      const store = createKeychainStore("oraknid:t", link);

      // Before the desktop: the name has no owner, so nothing is sent to it.
      const probe = await store.probe();
      expect(probe).toMatchObject({ available: false, waiting: true });
      expect(probe.detail).toMatch(/Waiting for the desktop keychain/);
      await expect(store.get("k")).rejects.toThrow(/isn't running yet/);
      expect(c.made()).toBe(0);
      expect(bus.calls.every((call) => call.join(" ").includes("NameHasOwner"))).toBe(true);
      expect(
        bus.calls.some(
          (call) =>
            call.includes("org.freedesktop.secrets") && !call.join(" ").includes("NameHasOwner"),
        ),
      ).toBe(false);

      // The session's keyring is up but locked: still no call, and no Unlock asked.
      bus.set("locked");
      now += 5000;
      expect((await store.probe()).detail).toMatch(/Waiting for the keychain to unlock/);
      expect(c.made()).toBe(0);
      expect(bus.calls.flat().some((a) => /Unlock|Prompt/.test(a))).toBe(false);

      // Unlocked by the login: secrets are read.
      bus.set("unlocked");
      now += 5000;
      c.kept.set("oraknid:t/k", "v");
      expect(await store.probe()).toMatchObject({ available: true });
      expect(await store.get("k")).toBe("v");
      expect(c.asked()).toBe(2);
    });

  it("on a machine without a session bus: no keychain, nothing to wait for", async () => {
    const bus = fakeBus();
    const c = counting();
    // Wherever the test runs, no bus in the environment and no socket in a runtime folder.
    const headless = secretServiceGate({
      run: bus.run,
      env: { XDG_RUNTIME_DIR: "/nonexistent-oraknid" },
    });
    expect(await headless()).toBe("no-bus");
    const probe = await createKeychainStore(
      "oraknid:t",
      new KeychainLink(c.connect, { gate: headless }),
    ).probe();
    expect(probe).toMatchObject({ available: false, waiting: false });
    expect(bus.calls).toHaveLength(0);
    expect(c.made()).toBe(0);
  });

  it("no tool to ask the bus with: calls are made, bounded as always", async () => {
    const gate = secretServiceGate({ run: async () => null, env });
    expect(await gate()).toBe("unknown");
  });
});
