import { execFileSync } from "node:child_process";
import { createECDH, randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { Agent, createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nodemailer, { type SendMailOptions } from "nodemailer";
import { describe, expect, it } from "vitest";
import { createEmailChannel } from "./email.ts";
import { createDesktopChannel } from "./linux/desktop.ts";
import { createWebPushChannel, generateVapidKeys, type PushSubscription } from "./web-push.ts";

describe("desktop channel", () => {
  /** A notify-send stand-in that records its arguments and "clicks" Open. */
  function fakeNotifySend(click: boolean, exitCode = 0) {
    const dir = mkdtempSync(join(tmpdir(), "oraknid-notify-"));
    const log = join(dir, "args");
    const script = join(dir, "notify-send");
    writeFileSync(
      script,
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${log}\n${click ? "echo open" : ""}\nexit ${exitCode}\n`,
    );
    chmodSync(script, 0o755);
    return { script, args: () => readFileSync(log, "utf8").trim().split("\n") };
  }

  it("shows a notification with title, body and urgency", async () => {
    const f = fakeNotifySend(false);
    const r = await createDesktopChannel({ notifySend: f.script }).send({
      title: "Approval needed",
      body: "Push to origin/dev",
      urgency: "critical",
    });
    expect(r).toEqual({ delivered: 1, problems: [] });
    expect(f.args()).toEqual([
      "--app-name=Oraknid",
      "--urgency=critical",
      "Approval needed",
      "Push to origin/dev",
    ]);
  });

  it("opens the UI when Open is clicked", async () => {
    const f = fakeNotifySend(true);
    const opened: string[] = [];
    await createDesktopChannel({ notifySend: f.script, open: (u) => opened.push(u) }).send({
      title: "t",
      body: "b",
      url: "http://127.0.0.1:7417/inbox",
      urgency: "normal",
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(f.args()).toContain("--action=open=Open");
    expect(opened).toEqual(["http://127.0.0.1:7417/inbox"]);
  });

  it("says what failed", async () => {
    const f = fakeNotifySend(false, 3);
    const r = await createDesktopChannel({ notifySend: f.script }).send({
      title: "t",
      body: "b",
      urgency: "low",
    });
    expect(r.delivered).toBe(0);
    expect(r.problems[0]).toMatch(/notify-send failed/);
  });
});

describe("web push channel", () => {
  function subscription(endpoint: string): PushSubscription {
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    return {
      endpoint,
      keys: {
        p256dh: ecdh.getPublicKey().toString("base64url"),
        auth: randomBytes(16).toString("base64url"),
      },
    };
  }

  /** A stand-in push service: answers 201, or 410 for /gone. */
  async function pushService() {
    const seen: { req: IncomingMessage; body: Buffer }[] = [];
    // A throwaway self-signed certificate: push services are always HTTPS.
    const dir = mkdtempSync(join(tmpdir(), "oraknid-tls-"));
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
        "-keyout",
        join(dir, "key.pem"),
        "-out",
        join(dir, "cert.pem"),
        "-days",
        "1",
        "-subj",
        "/CN=127.0.0.1",
      ],
      { stdio: "ignore" },
    );
    const tls = {
      key: readFileSync(join(dir, "key.pem")),
      cert: readFileSync(join(dir, "cert.pem")),
    };
    const server = createServer(tls, (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        seen.push({ req, body: Buffer.concat(chunks) });
        res.statusCode = req.url === "/gone" ? 410 : 201;
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const agent = new Agent({ ca: tls.cert, checkServerIdentity: () => undefined });
    return { base, seen, agent, close: () => server.close() };
  }

  it("sends an encrypted, VAPID-signed message and drops expired subscriptions", async () => {
    const svc = await pushService();
    const subs = [subscription(`${svc.base}/ok`), subscription(`${svc.base}/gone`)];
    const expired: string[] = [];
    const channel = createWebPushChannel({
      vapid: generateVapidKeys(),
      subject: "mailto:owner@example.com",
      subscriptions: () => subs,
      onExpired: (e) => expired.push(e),
      agent: svc.agent,
    });
    const r = await channel.send({ title: "Job done", body: "SECRET-BODY", urgency: "normal" });
    svc.close();

    expect(r.delivered).toBe(1);
    expect(expired).toEqual([`${svc.base}/gone`]);
    expect(r.problems).toHaveLength(1);
    const ok = svc.seen.find((s) => s.req.url === "/ok");
    expect(ok?.req.headers.authorization).toMatch(/^vapid t=.+, k=.+/);
    expect(ok?.req.headers["content-encoding"]).toBe("aes128gcm");
    expect(ok?.body.length).toBeGreaterThan(0);
    expect(ok?.body.toString("latin1")).not.toContain("SECRET-BODY");
  });
});

describe("email channel", () => {
  it("sends a plain message that links to the UI", async () => {
    const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
    const sent: string[] = [];
    const original = transport.sendMail.bind(transport);
    transport.sendMail = (async (mail: SendMailOptions) => {
      const info = await original(mail);
      sent.push(String((info as unknown as { message: Buffer }).message));
      return info;
    }) as typeof transport.sendMail;

    const channel = createEmailChannel({
      host: "unused",
      port: 0,
      secure: true,
      user: "u",
      from: "oraknid@example.com",
      to: "me@example.com",
      password: async () => "p",
      transport,
    });
    const r = await channel.send({
      title: "Job blocked",
      body: "All Legs are out of quota until 14:05.",
      url: "http://127.0.0.1:7417/jobs/1",
      urgency: "normal",
    });
    expect(r).toEqual({ delivered: 1, problems: [] });
    expect(sent[0]).toContain("Subject: Oraknid: Job blocked");
    expect(sent[0]).toContain("Open in Oraknid: http://127.0.0.1:7417/jobs/1");
  });

  it("reports a failed send in plain words", async () => {
    const transport = nodemailer.createTransport({ streamTransport: true });
    transport.sendMail = (async () => {
      throw new Error("Invalid login");
    }) as typeof transport.sendMail;
    const r = await createEmailChannel({
      host: "x",
      port: 0,
      secure: true,
      user: "u",
      from: "a@b.c",
      to: "d@e.f",
      password: async () => "p",
      transport,
    }).send({ title: "t", body: "b", urgency: "low" });
    expect(r).toEqual({ delivered: 0, problems: ["Email failed: Invalid login"] });
  });
});
