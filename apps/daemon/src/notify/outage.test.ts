import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_NOTIFICATION_SETTINGS } from "@oraknid/contracts";
import { createKeychainStore, type KeychainClient, KeychainLink } from "@oraknid/os";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/open.ts";
import { EventBus } from "../events/bus.ts";
import type { InboxStore } from "../inbox/store.ts";
import type { Notifications } from "./notifications.ts";
import { startNotificationRouter } from "./router.ts";

// The keychain's D-Bus closed under the daemon (the desktop session restarted,
// 2026-10-12): every notification failed and was logged, twenty times in half
// an hour, and one read became an unhandled rejection. A stand-in keychain,
// never the real one.

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("notifications while the keychain's D-Bus is gone", () => {
  it("says a failure once per outage, and its end once; the next send reconnects", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oraknid-outage-"));
    const db = await openDatabase({ file: ":memory:", backupsDir: join(dir, "b") });
    const bus = new EventBus(db, Date.now);
    // A keychain whose connection closes when told; a new one works.
    let closed = false;
    let connections = 0;
    const connect = (): KeychainClient => {
      connections++;
      const live = () => {
        if (closed) throw new Error("Platform failure: DBus error: Connection is closed");
      };
      return {
        get: async () => {
          live();
          return "vapid-key";
        },
        set: async () => live(),
        delete: async () => {
          live();
          return true;
        },
        find: async () => {
          live();
          return [];
        },
      };
    };
    const keychain = createKeychainStore("oraknid:t", new KeychainLink(connect, { pauseMs: 0 }));
    // Push reads its key from the keychain at each send, as the daemon's does.
    const sends: string[] = [];
    const notifications = {
      settings: () => DEFAULT_NOTIFICATION_SETTINGS,
      send: async (n: { title: string }) => {
        await keychain.get("push.vapid");
        sends.push(n.title);
        return [];
      },
    } as unknown as Notifications;
    const logs: string[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    const router = startNotificationRouter({
      db,
      bus,
      inbox: {} as InboxStore,
      notifications,
      uiUrl: () => "http://127.0.0.1:1",
      log: (m) => logs.push(m),
    });
    const recovered = () =>
      bus.publish({
        type: "system.recovered",
        topic: "overview",
        jobId: null,
        payload: { jobsResumed: [] },
      });
    try {
      recovered();
      await wait(10);
      expect(sends).toHaveLength(1);
      expect(connections).toBe(1);

      // D-Bus goes: three notifications fail, one line said.
      closed = true;
      for (let i = 0; i < 3; i++) recovered();
      await wait(20);
      expect(logs).toEqual(["notification failed (said once until one goes through)"]);

      // Back: the next one goes through on a new connection, and that is said once.
      closed = false;
      await wait(1100);
      recovered();
      await wait(20);
      expect(sends).toHaveLength(2);
      expect(connections).toBeGreaterThan(1);
      expect(logs).toEqual([
        "notification failed (said once until one goes through)",
        "notifications go through again",
      ]);
      expect(unhandled).toEqual([]);
    } finally {
      router.stop();
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
