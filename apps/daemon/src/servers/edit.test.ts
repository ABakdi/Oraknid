import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import ssh2 from "ssh2";
import { afterEach, describe, expect, it } from "vitest";
import type { Router } from "../api/router.ts";
import { type Daemon, startDaemon } from "../daemon.ts";
import type { EyeBrain } from "../eye/brain.ts";
import { resolvePaths } from "../paths.ts";
import { fakeOs } from "../testing/fake-os.ts";
import { fakeSsh } from "../testing/fake-ssh.ts";
import { sshWords } from "./ssh.ts";

// Servers that are easy to add and fix (Servers → Testing the connection,
// Editing a server): Test connection with the form as it is, and every
// field of a server changed after it was added.

let daemon: Daemon | undefined;
const closing: (() => Promise<void>)[] = [];
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  for (const c of closing.splice(0)) await c();
});

async function start() {
  const dir = mkdtempSync(join(tmpdir(), "oraknid-servers-edit-"));
  daemon = await startDaemon({
    paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
    port: 0,
    dbFile: ":memory:",
    os: fakeOs({ keychain: true }).os,
    adapters: {},
    brain: {} as EyeBrain,
    serverSampleSec: 3600,
  });
  const api = createORPCClient<RouterClient<Router>>(
    new RPCLink({
      url: `${daemon.url}/api`,
      headers: { authorization: `Bearer ${daemon.cliToken}` },
    }),
  );
  return { api, d: daemon };
}

/** A key pair of mine, its public half allowed on the fake server; with a passphrase if given. */
function myKey(home: string, passphrase?: string) {
  const k = passphrase
    ? ssh2.utils.generateKeyPairSync("ed25519", { passphrase, cipher: "aes256-ctr", rounds: 4 })
    : ssh2.utils.generateKeyPairSync("ed25519");
  mkdirSync(join(home, ".ssh"), { recursive: true });
  writeFileSync(join(home, ".ssh", "authorized_keys"), `${k.public}\n`);
  return k;
}

describe("Test connection (servers.test)", () => {
  it("tries the form as it is, saves nothing, and says why it fails in plain words", async () => {
    const ssh = await fakeSsh({ password: "pw" });
    closing.push(ssh.close);
    const { api } = await start();
    const at = { host: "127.0.0.1", port: ssh.port, user: "me" };

    const ok = await api.servers.test({ ...at, password: "pw" });
    expect(ok).toMatchObject({ ok: true, fingerprint: expect.stringMatching(/^SHA256:/) });
    expect(ok.system).toMatch(/\S/);
    expect(ok.said).toMatch(/^Logged in as me: /);
    expect(await api.servers.list()).toEqual([]);

    const wrong = await api.servers.test({ ...at, password: "nope" });
    expect(wrong).toMatchObject({ ok: false, system: null });
    expect(wrong.said).toMatch(/refused the SSH login of me/);

    // A key with a passphrase, given without it, then with a wrong one.
    const k = myKey(ssh.home, "secret");
    expect((await api.servers.test({ ...at, privateKey: k.private })).said).toMatch(
      /has a passphrase/,
    );
    expect(
      (await api.servers.test({ ...at, privateKey: k.private, passphrase: "nope" })).said,
    ).toMatch(/passphrase doesn't open/);
    expect(
      (await api.servers.test({ ...at, privateKey: k.private, passphrase: "secret" })).ok,
    ).toBe(true);
    // The public half pasted in place of the private one.
    expect((await api.servers.test({ ...at, privateKey: k.public })).said).toMatch(/not the \.pub/);

    // Nobody listening on that port.
    const gone = await fakeSsh({ password: "pw" });
    await gone.close();
    expect((await api.servers.test({ ...at, port: gone.port, password: "pw" })).said).toMatch(
      /refused the connection: is SSH running there/,
    );
  }, 60_000);

  it("uses the kept credentials of a server being edited, and its pinned host key", async () => {
    const ssh = await fakeSsh({ password: "pw" });
    closing.push(ssh.close);
    const { api, d } = await start();
    const s = await api.servers.add({
      name: "vps",
      host: "127.0.0.1",
      port: ssh.port,
      user: "me",
      description: "",
      password: "pw",
    });
    const at = { id: s.id, host: "127.0.0.1", port: ssh.port, user: "me" };
    expect((await api.servers.test(at)).ok).toBe(true);
    // The form's own password goes before the kept one.
    expect((await api.servers.test({ ...at, password: "nope" })).ok).toBe(false);

    // Pinned to another key: refused, with the fingerprint it presented.
    d.db.$client
      .prepare("update servers set host_key = ? where id = ?")
      .run("SHA256:somethingelse", s.id);
    const changed = await api.servers.test(at);
    expect(changed).toMatchObject({
      ok: false,
      fingerprint: expect.stringMatching(/^SHA256:/),
    });
    expect(changed.said).toMatch(/another host key than the one pinned/);
  }, 60_000);
});

describe("editing a server (servers.update)", () => {
  it("changes the address, the user and the credentials, forgetting the old host key", async () => {
    const ssh = await fakeSsh({ password: "pw" });
    closing.push(ssh.close);
    const { api, d } = await start();
    // Added with a typo in the port and a wrong password.
    const s = await api.servers.add({
      name: "vps",
      host: "127.0.0.1",
      port: 1,
      user: "root",
      description: "nginx",
      password: "typo",
    });
    d.db.$client
      .prepare("update servers set host_key = ?, error = ? where id = ?")
      .run("SHA256:old", "refused the connection", s.id);

    const fixed = await api.servers.update({
      id: s.id,
      port: ssh.port,
      user: "me",
      password: "pw",
      description: "nginx and Postgres",
    });
    expect(fixed).toMatchObject({
      port: ssh.port,
      user: "me",
      description: "nginx and Postgres",
      hostKey: null,
      error: null,
      auth: "password",
      setup: "new",
    });
    expect(await d.secrets.get(`server.${s.id}.password`)).toBe("pw");
    expect((await api.servers.test({ ...fixed, id: s.id })).ok).toBe(true);

    // My own key in place of the password: the password is forgotten.
    const k = myKey(ssh.home, "secret");
    const keyed = await api.servers.update({ id: s.id, privateKey: k.private });
    expect(keyed.auth).toBe("my-key");
    expect(await d.secrets.get(`server.${s.id}.password`)).toBeUndefined();
    // Saved without its passphrase: Test says so; the passphrase alone fixes it.
    expect((await api.servers.test({ ...fixed, id: s.id })).said).toMatch(/has a passphrase/);
    await api.servers.update({ id: s.id, passphrase: "secret" });
    expect(await d.secrets.get(`server.${s.id}.passphrase`)).toBe("secret");
    expect((await api.servers.test({ ...fixed, id: s.id })).ok).toBe(true);

    // The name alone leaves the rest, credentials included.
    const renamed = await api.servers.update({ id: s.id, name: "web" });
    expect(renamed).toMatchObject({ name: "web", auth: "my-key", port: ssh.port });
    expect(await d.secrets.get(`server.${s.id}.key`)).toContain("PRIVATE KEY");

    await expect(
      api.servers.update({ id: s.id, privateKey: k.private, password: "pw" }),
    ).rejects.toThrow(/not both/);
  }, 60_000);
});

describe("sshWords", () => {
  const srv = { name: "vps", host: "203.0.113.7", port: 22, user: "me" };
  it("says each failure in plain words", () => {
    expect(sshWords(new Error("Timed out while waiting for handshake"), srv)).toMatch(
      /gave no answer/,
    );
    expect(
      sshWords(Object.assign(new Error("getaddrinfo ENOTFOUND x"), { code: "ENOTFOUND" }), srv),
    ).toMatch(/There's no host "203.0.113.7"/);
    expect(sshWords(new Error("All configured authentication methods failed"), srv)).toMatch(
      /refused the SSH login of me/,
    );
  });
});
