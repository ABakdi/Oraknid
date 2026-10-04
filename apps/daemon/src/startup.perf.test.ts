import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { afterEach, describe, expect, it } from "vitest";
import type { Router } from "./api/router.ts";
import { type Daemon, startDaemon } from "./daemon.ts";
import { resolvePaths } from "./paths.ts";
import { fakeMail } from "./testing/fake-mail.ts";
import { fakeOs } from "./testing/fake-os.ts";

let daemon: Daemon | undefined;
const closing: (() => Promise<void>)[] = [];
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  for (const c of closing.splice(0)) await c();
});

const message = (i: number) =>
  [
    `From: Sender ${i % 50} <s${i % 50}@example.com>`,
    "To: me@example.com",
    `Subject: Message number ${i}`,
    `Message-ID: <m${i}@example.com>`,
    ...(i % 3
      ? [`In-Reply-To: <m${i - 1}@example.com>`, `References: <m${i - 1}@example.com>`]
      : []),
    `Date: ${new Date(Date.UTC(2026, 0, 1) + i * 60_000).toUTCString()}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    `Body of message ${i}. ${"Some words of text. ".repeat(20)}`,
  ].join("\r\n");

/**
 * The worst stall of the event loop while `during` runs, in ms, beside the
 * machine's own: a worker thread doing nothing measures the same window.
 * Oraknid's work can't block the worker's loop, but the system pausing this
 * process (other test runs on a busy machine) pauses both, so `machine` is
 * what the load costs, and `stall` is judged against it.
 */
async function worstStall(
  during: () => Promise<void>,
): Promise<{ stall: number; machine: number }> {
  const sentinel = new Worker(
    `const { parentPort } = require("node:worker_threads");
     const { monitorEventLoopDelay } = require("node:perf_hooks");
     const h = monitorEventLoopDelay({ resolution: 10 });
     h.enable();
     const keep = setInterval(() => {}, 1000);
     parentPort.on("message", () => { h.disable(); clearInterval(keep); parentPort.postMessage(h.max / 1e6); });`,
    { eval: true },
  );
  const h = monitorEventLoopDelay({ resolution: 10 });
  h.enable();
  try {
    await during();
  } finally {
    h.disable();
  }
  const machine = await new Promise<number>((resolve) => {
    sentinel.once("message", (ms: number) => resolve(ms));
    sentinel.postMessage("stop");
  });
  await sentinel.terminate();
  return { stall: h.max / 1e6, machine };
}

const N = Number(process.env.STARTUP_MESSAGES ?? 6000);

describe("the daemon's first minute (a /health probe within 1 s)", () => {
  it("answers /health and never stalls long while a mailbox of thousands syncs, then again after a restart", async () => {
    const mail = await fakeMail();
    closing.push(mail.close);
    for (let i = 1; i <= N; i++) mail.deliver(message(i), i % 5 ? "INBOX" : "Archive");
    const dir = mkdtempSync(join(tmpdir(), "oraknid-startup-"));
    const os = fakeOs({ keychain: true }).os;
    const boot = async () => {
      daemon = await startDaemon({
        paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
        port: 0,
        os,
        adapters: {},
        mail: { idleDelayMs: 100, syncEveryMs: 3600_000 },
      });
      return createORPCClient<RouterClient<Router>>(
        new RPCLink({
          url: `${daemon.url}/api`,
          headers: { authorization: `Bearer ${daemon.cliToken}` },
        }),
      );
    };
    const synced = async (api: Awaited<ReturnType<typeof boot>>) => {
      const end = Date.now() + 120_000;
      let worstProbe = 0;
      for (;;) {
        const t0 = performance.now();
        const r = await fetch(`${daemon?.url}/health`);
        expect(r.ok).toBe(true);
        worstProbe = Math.max(worstProbe, performance.now() - t0);
        const a = (await api.mail.accounts())[0];
        const inbox = a ? api.mail.folders({ accountId: a.id }) : null;
        const counted = inbox ? (await inbox).reduce((n, f) => n + (f.total ?? 0), 0) : 0;
        if (a?.state === "ready" && counted >= N) return worstProbe;
        if (Date.now() > end) throw new Error(`not synced: ${counted} of ${N}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    };

    let probe = 0;
    let api0: Awaited<ReturnType<typeof boot>> | undefined;
    const booting = await worstStall(async () => {
      api0 = await boot();
    });
    const first = await worstStall(async () => {
      const api = api0 as Awaited<ReturnType<typeof boot>>;
      await api.mail.addAccount({
        provider: "imap",
        email: mail.user,
        name: "Me",
        password: "app-password",
        imap: { host: "127.0.0.1", port: mail.imapPort, security: "plain" },
        smtp: { host: "127.0.0.1", port: mail.smtpPort, security: "plain" },
      });
      probe = await synced(api);
    });
    await daemon?.close();
    daemon = undefined;
    // Mail that came while it was stopped, and flags changed.
    for (let i = N + 1; i <= N + 500; i++) mail.deliver(message(i));
    let probe2 = 0;
    const again = await worstStall(async () => {
      const api = await boot();
      probe2 = await synced(api);
    });
    console.log(
      `startup: machine stall ${Math.max(first.machine, again.machine).toFixed(0)} ms; boot (migrations) ${booting.stall.toFixed(0)} ms; ${N} messages; first sync worst stall ${first.stall.toFixed(0)} ms (worst /health ${probe.toFixed(0)} ms); after a restart ${again.stall.toFixed(0)} ms (worst /health ${probe2.toFixed(0)} ms)`,
    );
    // What this guards against: a first sync that froze the loop 1.1 s on an
    // idle machine (B1-04). Fixed, it is ~260 ms idle and up to ~700 ms when
    // every package tests at once (Oraknid's own slices run slower sharing the
    // CPU, which no idle thread can see). 800 ms, plus what the machine itself
    // paused this process in the same window, catches the freeze, not the load.
    expect(probe).toBeLessThan(1000 + 2 * first.machine);
    expect(probe2).toBeLessThan(1000 + 2 * again.machine);
    expect(first.stall).toBeLessThan(800 + 2 * first.machine);
    expect(again.stall).toBeLessThan(800 + 2 * again.machine);
  }, 300_000);
});
