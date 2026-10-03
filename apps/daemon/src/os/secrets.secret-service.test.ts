import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKeychainStore, keychainService } from "@oraknid/os";
import { describe, expect, it } from "vitest";
import { keychainId, Secrets } from "./secrets.ts";

/**
 * The real Secret Service, in a throwaway session only (Audit 2, S2-23):
 * never my desktop's keyring. Run it with
 *   apps/daemon/scripts/secret-service-test.sh
 * which starts a private D-Bus session and a gnome-keyring in a temporary
 * home. Without that it is skipped.
 */
const throwaway =
  process.env.ORAKNID_SECRET_SERVICE_TEST === "1" &&
  /\/oraknid-ss-[^/]+\/data$/.test(process.env.XDG_DATA_HOME ?? "");

describe.skipIf(!throwaway)("keychain entries per data folder, on a real Secret Service", () => {
  it("keeps two data folders apart and moves the entries of before", async () => {
    const legacy = createKeychainStore();
    expect((await legacy.probe()).available).toBe(true);
    await legacy.set("nest.secret", "old nest");
    await legacy.set("leg.L1", "sk-1");
    expect((await legacy.names()).sort()).toEqual(["leg.L1", "nest.secret"]);

    const home = mkdtempSync(join(tmpdir(), "oraknid-ss-home-"));
    const logs: string[] = [];
    const real = new Secrets(home, createKeychainStore(), {
      ownsLegacy: true,
      log: (m) => logs.push(m),
    });
    await real.init();
    expect(logs).toEqual(["Keychain: 2 entries moved under this data folder's own name."]);
    expect(await legacy.names()).toEqual([]);
    const mine = createKeychainStore(keychainService(keychainId(home)));
    expect((await mine.names()).sort()).toEqual(["leg.L1", "nest.secret"]);
    expect(await real.get("nest.secret")).toBe("old nest");

    const test = new Secrets(
      mkdtempSync(join(tmpdir(), "oraknid-ss-test-")),
      createKeychainStore(),
    );
    await test.init();
    expect(await test.get("nest.secret")).toBeUndefined();
    await test.set("nest.secret", "a test daemon's");
    expect(await real.get("nest.secret")).toBe("old nest");
    expect(await test.get("nest.secret")).toBe("a test daemon's");
    expect(await test.delete("nest.secret")).toBe(true);
    expect(await real.get("nest.secret")).toBe("old nest");
  });
});
