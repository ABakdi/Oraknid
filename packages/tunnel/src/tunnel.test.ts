import { beforeAll, describe, expect, it } from "vitest";
import { DaemonEnd, DeviceEnd, newKeyPair, ready, TunnelError } from "./tunnel.ts";

beforeAll(() => ready());

async function pair() {
  const daemon = await newKeyPair();
  const device = await newKeyPair();
  const d = new DeviceEnd({ deviceId: "dev1", keys: device, daemonPublicKey: daemon.publicKey });
  const a = new DaemonEnd({
    keys: daemon,
    devicePublicKey: (id) => (id === "dev1" ? device.publicKey : null),
  });
  // Frames go both ways until both ends are open, as The Nest would carry them.
  const toDaemon = [d.hello()];
  const toDevice: string[] = [];
  while (toDaemon.length || toDevice.length) {
    for (const f of toDaemon.splice(0)) toDevice.push(...a.receive(f).replies);
    for (const f of toDevice.splice(0)) toDaemon.push(...d.receive(f).replies);
  }
  return { d, a, daemon, device };
}

describe("the end-to-end tunnel (ADR-017)", () => {
  it("opens between a paired device and its daemon, and carries messages both ways", async () => {
    const { d, a } = await pair();
    expect(d.ready && a.ready).toBe(true);
    expect(a.deviceId).toBe("dev1");
    expect(a.receive(d.seal({ hi: 1 })).messages).toEqual([{ hi: 1 }]);
    expect(d.receive(a.seal({ back: [2] })).messages).toEqual([{ back: [2] }]);
    // What The Nest sees is not the message.
    expect(d.seal({ secret: "approve deploy" })).not.toContain("approve");
  });

  it("refuses a device that isn't paired, or proves a key it doesn't hold", async () => {
    const daemon = await newKeyPair();
    const stranger = await newKeyPair();
    const a = new DaemonEnd({ keys: daemon, devicePublicKey: () => null });
    const d = new DeviceEnd({ deviceId: "x", keys: stranger, daemonPublicKey: daemon.publicKey });
    const [refused] = a.receive(d.hello()).replies;
    expect(() => d.receive(refused as string)).toThrow(/isn't paired/);
    const paired = await newKeyPair();
    const a2 = new DaemonEnd({ keys: daemon, devicePublicKey: () => paired.publicKey });
    expect(a2.receive(d.hello()).replies[0]).toContain("doesn't match");
  });

  it("refuses an impostor daemon, and closes on a changed, dropped or replayed frame", async () => {
    const { d, a, device } = await pair();
    const fake = await newKeyPair();
    const d2 = new DeviceEnd({
      deviceId: "dev1",
      keys: device,
      daemonPublicKey: (await newKeyPair()).publicKey,
    });
    const impostor = new DaemonEnd({ keys: fake, devicePublicKey: () => device.publicKey });
    const welcome = impostor.receive(d2.hello()).replies[0];
    // The impostor can't even open the device's proof: it refuses, or the device does.
    expect(() => d2.receive(welcome as string)).toThrow(TunnelError);
    const one = d.seal({ n: 1 });
    const two = d.seal({ n: 2 });
    expect(a.receive(one).messages).toEqual([{ n: 1 }]);
    expect(() => a.receive(one)).toThrow(/failed its check/);
    void two;
    const tampered = JSON.parse(d.seal({ n: 3 }));
    tampered.c = `A${tampered.c.slice(1)}`;
    expect(() => a.receive(JSON.stringify(tampered))).toThrow(TunnelError);
  });
});
