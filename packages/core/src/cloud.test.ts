import type { CloudPlacement } from "@oraknid/contracts";
import { describe, expect, it } from "vitest";
import { bytesText, choosePlace, type PlaceCandidate } from "./cloud.ts";

const GB = 1e9;
const auto = (rule: CloudPlacement["rule"]): CloudPlacement => ({
  mode: "auto",
  rule,
  providerId: null,
  largeFromBytes: 100e6,
});

const drive: PlaceCandidate = { id: "d", name: "Drive", kind: "drive", free: 10 * GB, priority: 1 };
const dropbox: PlaceCandidate = {
  id: "x",
  name: "Dropbox",
  kind: "dropbox",
  free: 2 * GB,
  priority: 0,
};
const minio: PlaceCandidate = { id: "m", name: "MinIO", kind: "s3", free: 5 * GB, priority: 2 };
const aws: PlaceCandidate = { id: "a", name: "AWS", kind: "s3", free: null, priority: 3 };

describe("where an upload goes (ADR-046)", () => {
  it("most free space first", () => {
    expect(choosePlace([drive, dropbox, minio], GB, auto("free"))).toEqual({ ok: true, id: "d" });
  });

  it("the priority order, skipping one it doesn't fit in", () => {
    expect(choosePlace([drive, dropbox, minio], GB, auto("priority"))).toEqual({
      ok: true,
      id: "x",
    });
    expect(choosePlace([drive, dropbox, minio], 3 * GB, auto("priority"))).toEqual({
      ok: true,
      id: "d",
    });
  });

  it("by size: large files to object storage, small ones elsewhere, and either when only one fits", () => {
    expect(choosePlace([drive, dropbox, minio], 200e6, auto("size"))).toEqual({
      ok: true,
      id: "m",
    });
    expect(choosePlace([drive, dropbox, minio], 1e6, auto("size"))).toEqual({ ok: true, id: "d" });
    expect(choosePlace([drive, dropbox, minio], 6 * GB, auto("size"))).toEqual({
      ok: true,
      id: "d",
    });
  });

  it("a provider that can't tell its room is only used when picked; pay as you go is never full", () => {
    expect(choosePlace([aws], GB, auto("free"))).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/pick one/),
    });
    expect(choosePlace([aws], GB, auto("free"), "a")).toEqual({ ok: true, id: "a" });
    const payg = { ...aws, free: Number.POSITIVE_INFINITY };
    expect(choosePlace([drive, payg], 50 * GB, auto("free"))).toEqual({ ok: true, id: "a" });
  });

  it("a file too big for any one place is refused, never split", () => {
    const r = choosePlace([drive, dropbox, minio], 11 * GB, auto("free"));
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.reason).toMatch(
      /Too big for any one place: 11 GB.*10 GB in Drive.*never split/,
    );
    // Even across 17 GB free in all.
    expect(choosePlace([drive, minio], 12 * GB, auto("size")).ok).toBe(false);
  });

  it("a chosen provider: the setting's or this file's, refused when it can say it's too small", () => {
    const one: CloudPlacement = { ...auto("free"), mode: "provider", providerId: "x" };
    expect(choosePlace([drive, dropbox], GB, one)).toEqual({ ok: true, id: "x" });
    expect(choosePlace([drive, dropbox], 3 * GB, one)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/doesn't fit in Dropbox/),
    });
    expect(choosePlace([drive, dropbox], GB, one, "d")).toEqual({ ok: true, id: "d" });
    expect(choosePlace([], 1, one).ok).toBe(false);
    expect(choosePlace([drive], 1, one).ok).toBe(false);
  });

  it("a provider whose last check failed isn't chosen automatically", () => {
    expect(choosePlace([{ ...drive, broken: true }, dropbox], GB, auto("free"))).toEqual({
      ok: true,
      id: "x",
    });
  });

  it("says sizes in words", () => {
    expect(bytesText(512)).toBe("512 B");
    expect(bytesText(1_500_000)).toBe("1.5 MB");
    expect(bytesText(12 * GB)).toBe("12 GB");
    expect(bytesText(Number.POSITIVE_INFINITY)).toBe("no limit");
  });
});
