import { describe, expect, it } from "vitest";
import {
  createKeychainStore,
  deadConnection,
  type KeychainClient,
  KeychainLink,
} from "./keychain.ts";

// The keychain's D-Bus connection closing under the daemon (the desktop
// session restarted, 2026-10-13): a stand-in client, never a real keyring.

/** A keychain whose connections close when told to; each `connect` is a new one. */
function standIn() {
  const kept = new Map<string, string>();
  const made: { closed: boolean }[] = [];
  let busDown = false;
  const connect = (): KeychainClient => {
    const conn = { closed: false };
    made.push(conn);
    const live = () => {
      if (busDown) throw new Error("Platform failure: DBus error: No DBus session found");
      if (conn.closed) throw new Error("Platform failure: DBus error: Connection is closed");
    };
    return {
      async get(service, name) {
        live();
        return kept.get(`${service}/${name}`);
      },
      async set(service, name, value) {
        live();
        kept.set(`${service}/${name}`, value);
      },
      async delete(service, name) {
        live();
        return kept.delete(`${service}/${name}`);
      },
      async find(service) {
        live();
        return [...kept.keys()]
          .filter((k) => k.startsWith(`${service}/`))
          .map((k) => k.slice(service.length + 1));
      },
    };
  };
  return {
    connect,
    made,
    closeAll: () => {
      for (const c of made) c.closed = true;
    },
    setBusDown: (down: boolean) => {
      busDown = down;
    },
  };
}

describe("the keychain over a D-Bus connection that closes", () => {
  it("drops a closed connection and makes a new one, the read retried once", async () => {
    const s = standIn();
    const store = createKeychainStore("oraknid:t", new KeychainLink(s.connect, { pauseMs: 0 }));
    await store.set("push.vapid", "key");
    expect(s.made).toHaveLength(1);
    s.closeAll();
    // The next read: the dead connection dropped, a new one made, the read answered.
    expect(await store.get("push.vapid")).toBe("key");
    expect(s.made).toHaveLength(2);
    expect(await store.get("push.vapid")).toBe("key");
    expect(s.made).toHaveLength(2);
  });

  it("shares the connection with its scoped stores", async () => {
    const s = standIn();
    const legacy = createKeychainStore("oraknid", new KeychainLink(s.connect, { pauseMs: 0 }));
    const mine = legacy.scoped("oraknid:abc");
    await legacy.set("a", "1");
    await mine.set("b", "2");
    expect(s.made).toHaveLength(1);
    expect(await mine.names()).toEqual(["b"]);
  });

  it("while D-Bus stays down, waits a growing pause between tries and says so", async () => {
    const s = standIn();
    let now = 1_000_000;
    const link = new KeychainLink(s.connect, { pauseMs: 0, now: () => now });
    const store = createKeychainStore("oraknid:t", link);
    await store.set("k", "v");
    s.setBusDown(true);
    await expect(store.get("k")).rejects.toThrow(/No DBus session/);
    expect(link.downUntil()).toBe(now + 1000);
    // Within the pause: no new connection tried, a plain error at once.
    const made = s.made.length;
    await expect(store.get("k")).rejects.toThrow(/isn.t answering/);
    expect(s.made).toHaveLength(made);
    now += 1001;
    await expect(store.get("k")).rejects.toThrow(/No DBus session/);
    expect(link.downUntil()).toBe(now + 2000);
    // Back: the next try after the pause works, and the pause is forgotten.
    s.setBusDown(false);
    now += 2001;
    expect(await store.get("k")).toBe("v");
    expect(link.downUntil()).toBeNull();
  });

  it("never repeats a delete, and passes other failures as they are", async () => {
    const s = standIn();
    const store = createKeychainStore("oraknid:t", new KeychainLink(s.connect, { pauseMs: 0 }));
    await store.set("k", "v");
    s.closeAll();
    await expect(store.delete("k")).rejects.toThrow(/Connection is closed/);
    expect(await store.delete("k")).toBe(true);
    const odd = new KeychainLink(() => {
      throw new Error("Secret Service: object locked");
    });
    await expect(createKeychainStore("x", odd).get("k")).rejects.toThrow(/object locked/);
  });

  it("knows a dead connection from the keychain's own refusals", () => {
    expect(deadConnection(new Error("Platform failure: DBus error: Connection is closed"))).toBe(
      true,
    );
    expect(
      deadConnection(
        new Error(
          "Platform failure: DBus error: Connection was disconnected before a reply was received",
        ),
      ),
    ).toBe(true);
    expect(deadConnection(new Error("Secret Service: unlock prompt was dismissed"))).toBe(false);
  });
});
