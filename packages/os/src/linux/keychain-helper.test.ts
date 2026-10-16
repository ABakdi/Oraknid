import { mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer as createHttp } from "node:http";
import { type AddressInfo, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createKeychainStore, KeychainLink } from "./keychain.ts";
import { HELPER_SOURCE, HelperClient, KeychainTimeout } from "./keychain-helper.ts";

// ADR-070: the keychain's calls run in a helper process with a deadline,
// never on the thread pool. These run the real helper source over a
// stand-in for the native keyring module: never the owner's keychain.

const dirs: string[] = [];
const closers: (() => void)[] = [];
afterEach(() => {
  for (const c of closers.splice(0)) c();
});

function tmp() {
  const d = mkdtempSync(join(tmpdir(), "oraknid-keyhelper-"));
  dirs.push(d);
  return d;
}

/** A keyring module that keeps entries in a file, like the native one would in the keychain. */
function workingKeyring() {
  const dir = tmp();
  const mod = join(dir, "keyring.cjs");
  const store = join(dir, "store.json");
  writeFileSync(
    mod,
    `const fs = require("node:fs");
const f = ${JSON.stringify(store)};
const read = () => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return {}; } };
const write = (o) => fs.writeFileSync(f, JSON.stringify(o));
class Entry {
  constructor(s, n, o) { this.k = s + "/" + n; if (o.linux.store !== "secret-service") throw new Error("wrong store"); }
  getPassword() { return read()[this.k] ?? null; }
  setPassword(v) { const o = read(); o[this.k] = v; write(o); }
  deleteCredential() { const o = read(); const had = this.k in o; delete o[this.k]; write(o); return had; }
}
function findCredentials(s) {
  return Object.keys(read()).filter((k) => k.startsWith(s + "/")).map((k) => ({ account: k.slice(s.length + 1) }));
}
module.exports = { Entry, findCredentials };
`,
  );
  return mod;
}

/**
 * A keyring that never answers, as a locked collection waiting for its
 * unlock prompt does: each helper opens one connection (counted by a
 * stand-in bus) and its call blocks its thread for good.
 */
async function hangingKeyring() {
  const dir = tmp();
  const sock = join(dir, "bus.sock");
  const live = new Set<Socket>();
  let opened = 0;
  let most = 0;
  const bus = createServer((s) => {
    opened++;
    live.add(s);
    most = Math.max(most, live.size);
    s.on("close", () => live.delete(s));
    s.on("error", () => {});
  });
  await new Promise<void>((r) => bus.listen(sock, r));
  closers.push(() => bus.close());
  const mod = join(dir, "keyring.cjs");
  writeFileSync(
    mod,
    `require("node:net").connect(${JSON.stringify(sock)}).on("error", () => {});
const forever = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
class Entry { getPassword() { forever(); } setPassword() { forever(); } deleteCredential() { forever(); } }
module.exports = { Entry, findCredentials: () => forever() };
`,
  );
  return { mod, live: () => live.size, opened: () => opened, most: () => most };
}

const helper = (mod: string, o: { timeoutMs?: number; idleMs?: number } = {}) => {
  const c = new HelperClient({
    command: () => ({ file: process.execPath, args: ["-e", HELPER_SOURCE, mod] }),
    ...o,
  });
  closers.push(() => c.close());
  return c;
};

describe("the keychain helper", () => {
  it("answers each call through the helper process", async () => {
    const c = helper(workingKeyring());
    expect(await c.get("oraknid:t", "k")).toBeUndefined();
    await c.set("oraknid:t", "k", "v");
    await c.set("oraknid:t", "j", "w");
    expect(await c.get("oraknid:t", "k")).toBe("v");
    expect((await c.find("oraknid:t")).sort()).toEqual(["j", "k"]);
    expect(await c.delete("oraknid:t", "k")).toBe(true);
    expect(await c.delete("oraknid:t", "k")).toBe(false);
    // One helper for the lot, never more than one at a time.
    expect(c.stats()).toMatchObject({ spawned: 1, alive: 1, timedOut: 0 });
  });

  it("ends an idle helper, and starts one again when asked", async () => {
    const c = helper(workingKeyring(), { idleMs: 50 });
    await c.set("s", "k", "v");
    await new Promise((r) => setTimeout(r, 150));
    expect(c.stats().alive).toBe(0);
    expect(await c.get("s", "k")).toBe("v");
    expect(c.stats().spawned).toBe(2);
  });

  it("a keychain that never answers: the call times out and the pool stays free", async () => {
    const k = await hangingKeyring();
    const c = helper(k.mod, { timeoutMs: 400 });
    const pending = c.get("oraknid:t", "k");
    const queued = c.get("oraknid:t", "j");
    // Meanwhile files are read and pages served, as the web UI's are.
    const file = join(tmp(), "f");
    writeFileSync(file, "hello");
    const started = Date.now();
    expect(await readFile(file, "utf8")).toBe("hello");
    const page = createHttp((_q, s) => s.end("index"));
    await new Promise<void>((r) => page.listen(0, "127.0.0.1", r));
    closers.push(() => page.close());
    const res = await fetch(`http://127.0.0.1:${(page.address() as AddressInfo).port}/`);
    expect(await res.text()).toBe("index");
    expect(Date.now() - started).toBeLessThan(300);
    // Then the call fails plainly, and the one queued behind it with it.
    await expect(pending).rejects.toBeInstanceOf(KeychainTimeout);
    await expect(queued).rejects.toThrow(/didn't answer/);
    expect(c.stats()).toMatchObject({ alive: 0, queued: 0, timedOut: 1 });
  });

  it("leaves no connection open across 100 calls that time out", async () => {
    const k = await hangingKeyring();
    const c = helper(k.mod, { timeoutMs: 60 });
    for (let i = 0; i < 100; i++)
      await expect(c.get("oraknid:t", `k${i}`)).rejects.toBeInstanceOf(KeychainTimeout);
    // Each helper killed with its connection: never more than one or two open at once.
    await new Promise((r) => setTimeout(r, 200));
    expect(k.live()).toBe(0);
    expect(k.most()).toBeLessThanOrEqual(2);
    expect(k.opened()).toBeGreaterThan(0);
    expect(c.stats()).toMatchObject({ spawned: 100, alive: 0, timedOut: 100 });
  }, 60_000);

  it("through the link: a timeout waits out the pause, not asked again at once", async () => {
    const k = await hangingKeyring();
    let now = 1_000_000;
    let made = 0;
    const link = new KeychainLink(
      () => {
        made++;
        return helper(k.mod, { timeoutMs: 100 });
      },
      { now: () => now, pauseMs: 0 },
    );
    const store = createKeychainStore("oraknid:t", link);
    await expect(store.get("k")).rejects.toThrow(/didn't answer/);
    expect(made).toBe(1);
    expect(link.downUntil()).toBe(now + 1000);
    await expect(store.get("k")).rejects.toThrow(/isn't answering/);
    expect(made).toBe(1);
    now += 1001;
    await expect(store.probe()).resolves.toMatchObject({ available: false });
    expect(made).toBe(2);
    store.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(k.live()).toBe(0);
  });
});
