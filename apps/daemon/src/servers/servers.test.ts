import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { afterEach, describe, expect, it } from "vitest";
import type { Router } from "../api/router.ts";
import { type Daemon, startDaemon } from "../daemon.ts";
import type { EyeBrain } from "../eye/brain.ts";
import { resolvePaths } from "../paths.ts";
import { fakeOs } from "../testing/fake-os.ts";
import { fakeSsh } from "../testing/fake-ssh.ts";

let daemon: Daemon | undefined;
const closing: (() => Promise<void>)[] = [];
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  for (const c of closing.splice(0)) await c();
});

describe("servers (ADR-026/027)", () => {
  it("sets a server up: its own key in place of the password, discovery, the document, the monitor", async () => {
    let ssh = await fakeSsh({ password: "pw" });
    closing.push(ssh.close);
    const dir = mkdtempSync(join(tmpdir(), "oraknid-servers-"));
    const docs: { previous: string; discovery: string }[] = [];
    const brain = {
      serverState: async (i: { previous: string; discovery: string; name: string }) => {
        docs.push(i);
        return { document: `# ${i.name}\n\nVersion ${docs.length}.` };
      },
    } as unknown as EyeBrain;
    daemon = await startDaemon({
      paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
      port: 0,
      dbFile: ":memory:",
      os: fakeOs({ keychain: true }).os,
      adapters: {},
      brain,
      serverSampleSec: 3600,
    });
    const api = createORPCClient<RouterClient<Router>>(
      new RPCLink({
        url: `${daemon.url}/api`,
        headers: { authorization: `Bearer ${daemon.cliToken}` },
      }),
    );
    const s = await api.servers.add({
      name: "vps",
      host: "127.0.0.1",
      port: ssh.port,
      user: "me",
      description: "My sites: nginx and two Node apps.",
      password: "pw",
    });
    expect(s).toMatchObject({ auth: "password", setup: "new", hostKey: null });
    const ready = await api.servers.setup({ id: s.id });
    expect(ready).toMatchObject({ auth: "oraknid-key", setup: "ready", error: null });
    expect(ready.hostKey).toMatch(/^SHA256:/);
    // Oraknid's key is in authorized_keys; the monitor is installed; discovery only read.
    expect(readFileSync(join(ssh.home, ".ssh", "authorized_keys"), "utf8")).toMatch(
      /^ssh-ed25519 \S+ oraknid-/,
    );
    expect(existsSync(join(ssh.home, ".local", "bin", "oraknid-monitor"))).toBe(true);
    expect(docs[0]?.discovery).toContain("## System");
    expect((await api.servers.state({ id: s.id }))?.body).toBe("# vps\n\nVersion 1.");

    // The monitor answers over SSH.
    await daemon.servers.sampleAll();
    const [view] = await api.servers.list();
    expect(view?.latest?.memTotal).toBeGreaterThan(0);
    expect((await api.servers.samples({ id: s.id, since: 0 })).length).toBe(1);

    // My edit is a version; discovering again sees the last document.
    await api.servers.editState({ id: s.id, body: "# vps\n\nMine." });
    await api.servers.discover({ id: s.id });
    expect(docs[1]?.previous).toBe("# vps\n\nMine.");
    expect((await api.servers.state({ id: s.id }))?.version).toBe(3);

    // A different host key stops everything until I accept it.
    await ssh.close();
    const home = ssh.home;
    ssh = await fakeSsh({});
    closing.push(ssh.close);
    // Same home, same keys: only the host key changed.
    await import("node:fs").then((fs) => fs.cpSync(home, ssh.home, { recursive: true }));
    daemon.db.$client.prepare("update servers set port = ? where id = ?").run(ssh.port, s.id);
    daemon.servers.forget(s.id);
    await expect(api.servers.discover({ id: s.id })).rejects.toThrow(/host key changed/);
    const changed = (await api.servers.list())[0];
    expect(changed?.hostKeyOffered).toMatch(/^SHA256:/);
    await api.servers.acceptHostKey({ id: s.id });
    await api.servers.discover({ id: s.id });

    // Removed: off the server, then gone here.
    expect(await api.servers.remove({ id: s.id })).toEqual({ cleaned: true });
    expect(existsSync(join(ssh.home, ".local", "bin", "oraknid-monitor"))).toBe(false);
    expect(readFileSync(join(ssh.home, ".ssh", "authorized_keys"), "utf8")).not.toContain(
      "oraknid-",
    );
    expect(await api.servers.list()).toEqual([]);
  }, 120_000);
});
