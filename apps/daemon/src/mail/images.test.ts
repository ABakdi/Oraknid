import { describe, expect, it } from "vitest";
import { fetchImages, isPrivate, remoteImages } from "./images.ts";

describe("remote images in mail, fetched by the daemon (ADR-032, Audit 2)", () => {
  it("finds the images a mail names", () => {
    expect(
      remoteImages(
        `<img src="https://a.example/x.png?a=1&amp;b=2"><td background='http://b.example/bg.gif'><div style="background:url(https://c.example/c.jpg)">`,
      ),
    ).toEqual([
      "https://a.example/x.png?a=1&b=2",
      "http://b.example/bg.gif",
      "https://c.example/c.jpg",
    ]);
  });

  it("never fetches from this computer or my network", async () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "192.168.1.1",
      "172.20.0.1",
      "169.254.1.1",
      "::1",
      "fd00::1",
      "::ffff:127.0.0.1",
    ])
      expect(isPrivate(ip)).toBe(true);
    expect(isPrivate("93.184.216.34")).toBe(false);
    expect(
      await fetchImages(["http://127.0.0.1:7417/api/system/status", "http://localhost/x.png"]),
    ).toEqual({});
  });
});
