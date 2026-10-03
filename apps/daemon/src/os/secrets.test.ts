import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isDefaultDataDir } from "../paths.ts";
import { fakeOs } from "../testing/fake-os.ts";
import { keychainId, Secrets } from "./secrets.ts";

const dir = () => mkdtempSync(join(tmpdir(), "oraknid-secrets-"));

/** A fake keychain over these services: one desktop's keychain, shared. */
function keychainOf(services: Map<string, Map<string, string>>) {
  const k = fakeOs({ keychain: true, keychainServices: services }).os.keychain;
  if (!k) throw new Error("no fake keychain");
  return k;
}

/** Two daemons of one user, on one desktop keychain (Audit 2, S2-23). */
function oneKeychain() {
  const services = new Map<string, Map<string, string>>();
  const open = async (dataDir: string, ownsLegacy = false) => {
    const s = new Secrets(dataDir, keychainOf(services), {
      ownsLegacy,
    });
    await s.init();
    return s;
  };
  return { services, open };
}

describe("keychain entries per data folder (S2-23)", () => {
  it("keeps a stable id in the data folder, readable by me alone", () => {
    const d = dir();
    const id = keychainId(d);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(keychainId(d)).toBe(id);
    expect(readFileSync(join(d, "keychain-id"), "utf8").trim()).toBe(id);
    expect(statSync(join(d, "keychain-id")).mode & 0o777).toBe(0o600);
    expect(keychainId(dir())).not.toBe(id);
  });

  it("two data folders don't see or overwrite each other's secrets", async () => {
    const { services, open } = oneKeychain();
    const real = await open(dir());
    const test = await open(dir());
    await real.set("nest.secret", "the real one");
    await test.set("nest.secret", "a test daemon's");
    await test.set("github.token", "test only");
    expect(await real.get("nest.secret")).toBe("the real one");
    expect(await test.get("nest.secret")).toBe("a test daemon's");
    expect(await real.get("github.token")).toBeUndefined();
    await test.delete("nest.secret");
    expect(await real.get("nest.secret")).toBe("the real one");
    // Each under its own service; nothing under the shared one of before.
    const named = [...services.keys()].filter((s) => services.get(s)?.size);
    expect(named).toHaveLength(2);
    expect(named.every((s) => /^oraknid:[0-9a-f]{16}$/.test(s))).toBe(true);
  });

  it("a restart finds the same entries", async () => {
    const { open } = oneKeychain();
    const d = dir();
    await (await open(d)).set("smtp.password", "pw");
    expect(await (await open(d)).get("smtp.password")).toBe("pw");
  });

  it("moves the entries of before into the default data folder's own service, once", async () => {
    const { services, open } = oneKeychain();
    services.set(
      "oraknid",
      new Map([
        ["nest.secret", "old nest"],
        ["leg.L1", "sk-1"],
      ]),
    );
    const logs: string[] = [];
    const home = dir();
    const s = new Secrets(home, keychainOf(services), {
      ownsLegacy: true,
      log: (m) => logs.push(m),
    });
    await s.init();
    expect(services.get("oraknid")?.size).toBe(0);
    const mine = services.get(`oraknid:${keychainId(home)}`);
    expect(mine?.get("nest.secret")).toBe("old nest");
    expect(mine?.get("leg.L1")).toBe("sk-1");
    // A count, never a value.
    expect(logs).toEqual(["Keychain: 2 entries moved under this data folder's own name."]);
    // Another data folder never had them.
    const other = await open(dir());
    expect(await other.get("nest.secret")).toBeUndefined();
    // Started again: nothing left to move.
    const again = await open(home, true);
    expect(await again.get("leg.L1")).toBe("sk-1");
  });

  it("keeps an entry written under the new service over an old one of the same name", async () => {
    const { services, open } = oneKeychain();
    const home = dir();
    await (await open(home, true)).set("nest.secret", "new");
    services.set("oraknid", new Map([["nest.secret", "stale"]]));
    const s = await open(home, true);
    expect(await s.get("nest.secret")).toBe("new");
    expect(services.get("oraknid")?.has("nest.secret")).toBe(false);
  });

  it("moves an entry when it is read, when the old ones can't be listed", async () => {
    const { services } = oneKeychain();
    services.set("oraknid", new Map([["vapid.private", "key"]]));
    const keychain = keychainOf(services);
    const logs: string[] = [];
    const s = new Secrets(
      dir(),
      {
        ...keychain,
        names: async () => {
          throw new Error("no search here");
        },
      },
      { ownsLegacy: true, log: (m) => logs.push(m) },
    );
    await s.init();
    expect(logs[0]).toMatch(/could not be listed/);
    expect(services.get("oraknid")?.get("vapid.private")).toBe("key");
    expect(await s.get("vapid.private")).toBe("key");
    expect(services.get("oraknid")?.has("vapid.private")).toBe(false);
  });

  it("a data folder other than the default never reads the entries of before", async () => {
    const { services, open } = oneKeychain();
    services.set("oraknid", new Map([["nest.secret", "the real one"]]));
    const test = await open(dir(), false);
    expect(await test.get("nest.secret")).toBeUndefined();
    await test.set("nest.secret", "test");
    expect(services.get("oraknid")?.get("nest.secret")).toBe("the real one");
  });

  it("knows the default data folder", () => {
    const env = { XDG_DATA_HOME: "/home/me/.local/share" };
    expect(isDefaultDataDir("/home/me/.local/share/oraknid", env)).toBe(true);
    expect(isDefaultDataDir("/home/me/.local/share/oraknid/", env)).toBe(true);
    expect(
      isDefaultDataDir("/home/me/.local/share/oraknid", {
        ...env,
        ORAKNID_DATA_DIR: "/home/me/.local/share/oraknid",
      }),
    ).toBe(true);
    expect(
      isDefaultDataDir("/tmp/oraknid-test", { ...env, ORAKNID_DATA_DIR: "/tmp/oraknid-test" }),
    ).toBe(false);
  });
});
