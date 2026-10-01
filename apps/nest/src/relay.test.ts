import { DaemonEnd, DeviceEnd, newKeyPair, ready } from "@oraknid/tunnel";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createNest } from "./relay.ts";

let nest: ReturnType<typeof createNest> | undefined;
beforeAll(() => ready());
afterEach(async () => {
  await nest?.close();
  nest = undefined;
});

async function start(limits = {}) {
  nest = createNest({ daemons: new Map([["home", "s3cret"]]), limits });
  await new Promise<void>((r) => nest?.server.listen(0, "127.0.0.1", () => r()));
  const port = (nest.server.address() as { port: number }).port;
  return `ws://127.0.0.1:${port}`;
}

const opened = (ws: WebSocket) =>
  new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("unexpected-response", (_q, res) => reject(new Error(String(res.statusCode))));
    ws.once("error", reject);
  });

describe("The Nest (Nest-Protocol)", () => {
  it("carries an end-to-end tunnel between a device and its daemon, seeing only ciphertext", async () => {
    const base = await start();
    const daemonKeys = await newKeyPair();
    const deviceKeys = await newKeyPair();
    const daemon = new WebSocket(`${base}/daemon?id=home`, {
      headers: { authorization: "Bearer s3cret" },
    });
    await opened(daemon);
    const ends = new Map<number, DaemonEnd>();
    const got: unknown[] = [];
    daemon.on("message", (data) => {
      const m = JSON.parse(String(data)) as { c: number; open?: boolean; f?: string };
      if (m.open) {
        ends.set(
          m.c,
          new DaemonEnd({ keys: daemonKeys, devicePublicKey: () => deviceKeys.publicKey }),
        );
        return;
      }
      if (!m.f) return;
      const end = ends.get(m.c) as DaemonEnd;
      const r = end.receive(m.f);
      for (const f of r.replies) daemon.send(JSON.stringify({ c: m.c, f }));
      for (const msg of r.messages) {
        got.push(msg);
        daemon.send(JSON.stringify({ c: m.c, f: end.seal({ echo: msg }) }));
      }
    });
    const device = new WebSocket(`${base}/device?daemon=home`);
    await opened(device);
    const me = new DeviceEnd({
      deviceId: "phone",
      keys: deviceKeys,
      daemonPublicKey: daemonKeys.publicKey,
    });
    const answers: unknown[] = [];
    const isOpen = new Promise<void>((resolve) => {
      device.on("message", (data) => {
        const r = me.receive(String(data));
        for (const f of r.replies) device.send(f);
        answers.push(...r.messages);
        if (me.ready) resolve();
      });
    });
    device.send(me.hello());
    await isOpen;
    device.send(me.seal({ approve: "item 7" }));
    const end = Date.now() + 2000;
    while (answers.length === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    expect(got).toEqual([{ approve: "item 7" }]);
    expect(answers).toEqual([{ echo: { approve: "item 7" } }]);
    device.close();
    daemon.close();
  });

  it("refuses a daemon with the wrong secret, a device for a daemon that isn't there, and too many devices", async () => {
    const base = await start({ devicesPerAddress: 1 });
    await expect(
      opened(
        new WebSocket(`${base}/daemon?id=home`, { headers: { authorization: "Bearer nope" } }),
      ),
    ).rejects.toThrow("401");
    await expect(opened(new WebSocket(`${base}/device?daemon=home`))).rejects.toThrow("404");
    const daemon = new WebSocket(`${base}/daemon?id=home`, {
      headers: { authorization: "Bearer s3cret" },
    });
    await opened(daemon);
    const first = new WebSocket(`${base}/device?daemon=home`);
    await opened(first);
    await expect(opened(new WebSocket(`${base}/device?daemon=home`))).rejects.toThrow("429");
    first.close();
    daemon.close();
  });
});
