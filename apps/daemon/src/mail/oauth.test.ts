import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { afterEach, describe, expect, it } from "vitest";
import type { Router } from "../api/router.ts";
import { remoteAllowed } from "../auth/lock.ts";
import { type Daemon, startDaemon } from "../daemon.ts";
import { resolvePaths as paths } from "../paths.ts";
import { fakeMail } from "../testing/fake-mail.ts";
import { type FakeOAuth, startFakeOAuth } from "../testing/fake-oauth.ts";
import { fakeOs } from "../testing/fake-os.ts";

// Gmail and Outlook signed in with Google or Microsoft (ADR-063): the app I
// registered, the browser flow with PKCE back to the daemon, Microsoft's
// device code, XOAUTH2 for IMAP and SMTP, tokens refreshed and kept in the
// keychain; against a stand-in sign-in server and a stand-in mail server.

let daemon: Daemon | undefined;
const closing: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  for (const c of closing.splice(0)) await c();
});

const plain = (port: number) => ({ host: "127.0.0.1", port, security: "plain" as const });

async function until<T>(fn: () => T | Promise<T>, ms = 10_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function rig(o: { secret?: string; expiresIn?: number } = {}) {
  const mail = await fakeMail({ gmail: true, accessToken: "none-yet" });
  closing.push(mail.close);
  const oauth: FakeOAuth = await startFakeOAuth({
    email: mail.user,
    clientId: "my-app-id",
    ...(o.secret ? { clientSecret: o.secret } : {}),
    onAccessToken: (t) => mail.setAccessToken(t),
    ...(o.expiresIn ? { expiresIn: o.expiresIn } : {}),
  });
  closing.push(oauth.close);
  const servers = {
    imap: plain(mail.imapPort),
    pop: plain(mail.popPort),
    smtp: plain(mail.smtpPort),
    appendSent: false,
  };
  const dir = mkdtempSync(join(tmpdir(), "oraknid-mail-oauth-"));
  closing.push(() => rmSync(dir, { recursive: true, force: true }));
  const os = fakeOs({ keychain: true });
  daemon = await startDaemon({
    paths: resolvePaths(dir),
    port: 0,
    dbFile: ":memory:",
    os: os.os,
    adapters: {},
    mail: {
      idleDelayMs: 100,
      syncEveryMs: 3600_000,
      presets: { gmail: servers, outlook: servers },
      oauthEndpoints: { google: oauth.endpoints, microsoft: oauth.endpoints },
      devicePollMs: 50,
    },
  });
  const api = createORPCClient<RouterClient<Router>>(
    new RPCLink({
      url: `${daemon.url}/api`,
      headers: { authorization: `Bearer ${daemon.cliToken}` },
    }),
  );
  return { mail, oauth, api, d: daemon, store: os.store };
}

const resolvePaths = (dir: string) => paths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir });

/** What a browser does: open the sign-in page, follow it back to the daemon. */
async function browser(url: string) {
  const r = await fetch(url, { redirect: "manual" });
  const back = r.headers.get("location");
  if (!back) throw new Error(`no redirect: ${r.status}`);
  const page = await fetch(back);
  return { status: page.status, text: await page.text(), back };
}

describe("mail OAuth (ADR-063)", () => {
  it("says what is missing before an app is registered, and keeps the app's secret in the keychain", async () => {
    const { api, store } = await rig({ secret: "google-secret" });
    await expect(api.mail.oauthStart({ provider: "google" })).rejects.toThrow(/Mail → OAuth apps/);
    await api.mail.setOAuthApp({ provider: "google", clientId: "my-app-id" });
    // Google's desktop apps have a secret: not ready without it.
    expect((await api.mail.oauthApps()).find((a) => a.provider === "google")).toMatchObject({
      clientId: "my-app-id",
      hasSecret: false,
      ready: false,
    });
    await api.mail.setOAuthApp({
      provider: "google",
      clientId: "my-app-id",
      clientSecret: "google-secret",
    });
    const apps = await api.mail.oauthApps();
    expect(apps.find((a) => a.provider === "google")).toMatchObject({
      hasSecret: true,
      ready: true,
    });
    expect(apps[0]?.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/mail\/callback$/);
    expect(JSON.stringify(apps)).not.toContain("google-secret");
    expect([...store.values()]).toContain("google-secret");
    // Microsoft's public client needs no secret.
    await api.mail.setOAuthApp({ provider: "microsoft", clientId: "ms-app" });
    expect((await api.mail.oauthApps()).find((a) => a.provider === "microsoft")?.ready).toBe(true);
    // An empty id forgets the app and its secret.
    await api.mail.setOAuthApp({ provider: "google", clientId: "" });
    expect((await api.mail.oauthApps())[0]).toMatchObject({ clientId: "", hasSecret: false });
    expect([...store.values()]).not.toContain("google-secret");
  });

  it("Gmail: signed in through the browser with PKCE, synced and checked over XOAUTH2, the token refreshed, a revoked one asking to sign in again", async () => {
    const { api, mail, oauth, d, store } = await rig({ secret: "google-secret", expiresIn: 30 });
    mail.deliver("Message-ID: <a@x>\r\nFrom: bob@example.com\r\nSubject: Hi\r\n\r\nHello.");
    await api.mail.setOAuthApp({
      provider: "google",
      clientId: "my-app-id",
      clientSecret: "google-secret",
    });
    const start = await api.mail.oauthStart({ provider: "google" });
    if (start.kind !== "browser") throw new Error("expected the browser flow");
    expect(start.url).toContain(oauth.url);
    expect(start.url).toContain("code_challenge_method=S256");
    const page = await browser(start.url);
    expect(page.back).toContain(`${d.url}/oauth/mail/callback`);
    expect(page.status).toBe(200);
    expect(page.text).toContain("me@example.com is connected");
    expect(await api.mail.oauthStatus({ id: start.id })).toEqual({
      state: "done",
      email: "me@example.com",
      error: null,
    });
    const account = await until(async () => {
      const a = (await api.mail.accounts())[0];
      return a?.state === "ready" ? a : null;
    });
    expect(account).toMatchObject({ email: "me@example.com", provider: "gmail", auth: "google" });
    expect(mail.commands.some((c) => c === "AUTHENTICATE")).toBe(true);
    expect(mail.commands.some((c) => c === "LOGIN")).toBe(false);
    const threads = await until(async () => {
      const t = await api.mail.threads({ accountId: account.id });
      return t.threads.length ? t : null;
    });
    expect(threads.threads[0]?.subject).toBe("Hi");
    // The refresh token is in the keychain; no token in any event.
    expect([...store.keys()]).toContain(`mail.${account.id}.refresh`);
    const events = (
      d.db.$client.prepare("select payload from events").all() as { payload: string }[]
    )
      .map((e) => e.payload)
      .join("\n");
    expect(events).not.toMatch(/\b(at|rt)-[0-9a-f]{16}\b/);
    expect(oauth.grants.every((g) => g.hadSecret)).toBe(true);

    // The access token lives 30 s, under the minute kept in hand: the next connection refreshes it.
    mail.dropConnections();
    await until(() => oauth.grants.some((g) => g.grant === "refresh_token"));
    await until(async () => (await api.mail.accounts())[0]?.state === "ready");

    // Revoked at Google: Reconnect, in words, and a password is no answer.
    oauth.revoke();
    mail.setAccessToken(null);
    mail.dropConnections();
    const stuck = await until(async () => {
      const a = (await api.mail.accounts())[0];
      return a?.state === "reconnect" ? a : null;
    });
    expect(stuck.error).toMatch(/refused|revoked/i);
    await expect(api.mail.reconnect({ id: account.id, password: "x" })).rejects.toThrow(
      /sign in again/,
    );
    // Signing in again to the same account brings it back.
    const again = await api.mail.oauthStart({ provider: "google", accountId: account.id });
    if (again.kind !== "browser") throw new Error("expected the browser flow");
    expect(again.url).toContain("login_hint=me%40example.com");
    expect((await browser(again.url)).status).toBe(200);
    await until(async () => (await api.mail.accounts())[0]?.state === "ready");
    expect(await api.mail.accounts()).toHaveLength(1);
  });

  it("Outlook: signed in with a code typed on Microsoft's page, as a public client without a secret", async () => {
    const { api, mail, oauth } = await rig();
    await api.mail.setOAuthApp({ provider: "microsoft", clientId: "my-app-id" });
    const start = await api.mail.oauthStart({ provider: "microsoft" });
    if (start.kind !== "device") throw new Error("expected the device flow");
    expect(start.userCode).toBe("ABCD-1234");
    expect(start.verificationUri).toBe("https://microsoft.com/devicelogin");
    // Waiting for me: the code isn't typed yet.
    await new Promise((r) => setTimeout(r, 200));
    expect((await api.mail.oauthStatus({ id: start.id })).state).toBe("pending");
    oauth.approveDevice();
    const done = await until(async () => {
      const s = await api.mail.oauthStatus({ id: start.id });
      return s.state === "pending" ? null : s;
    });
    expect(done).toEqual({ state: "done", email: "me@example.com", error: null });
    const a = await until(async () => {
      const x = (await api.mail.accounts())[0];
      return x?.state === "ready" ? x : null;
    });
    expect(a).toMatchObject({ provider: "outlook", auth: "microsoft" });
    expect(oauth.grants.some((g) => g.hadSecret)).toBe(false);
    expect(mail.commands.some((c) => c === "AUTHENTICATE")).toBe(true);
    // An unknown sign-in says so.
    expect((await api.mail.oauthStatus({ id: "nope" })).state).toBe("failed");
  });

  it("refuses a callback it didn't start, and keeps the app and the sign-in at home", async () => {
    const { d } = await rig();
    const r = await fetch(`${d.url}/oauth/mail/callback?state=forged&code=x`);
    expect(r.status).toBe(400);
    expect(await r.text()).toContain("wasn't started here");
    expect(remoteAllowed("/mail/setOAuthApp")).toBe(false);
    expect(remoteAllowed("/mail/oauthStart")).toBe(false);
  });
});
