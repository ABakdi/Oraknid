import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ALWAYS_HOME, HOME_ONLY } from "./lock.ts";

/** The procedures a bullet of API-Contract names: `area.proc` / `proc` … · `area.proc`. */
function named(bullet: string): Set<string> {
  const out = new Set<string>();
  let area = "";
  for (const [, word] of bullet.matchAll(/`([\w.*]+)`/g)) {
    if (!word) continue;
    if (word.includes(".")) {
      area = word.split(".")[0] ?? "";
      out.add(word);
    } else out.add(`${area}.${word}`);
  }
  return out;
}

const asName = (path: string) =>
  path.endsWith("/") ? `${path.slice(1, -1)}.*` : path.slice(1).replaceAll("/", ".");

describe("API-Contract names every call refused away from home (lock.ts)", () => {
  const doc = readFileSync(
    new URL("../../../../docs/02-Architecture/API-Contract.md", import.meta.url),
    "utf8",
  );
  const section = doc.slice(doc.indexOf("**Away from home**"), doc.indexOf("**Request ids**"));
  const always = named(
    section.slice(section.indexOf("whatever the device's rights")).split("\n- ")[0] ?? "",
  );
  const standard = named(
    section.slice(section.indexOf("for a standard device")).split("\n\n")[0] ?? "",
  );

  it("lists those home only whatever the rights", () => {
    expect([...always].sort()).toEqual(ALWAYS_HOME.map(asName).sort());
  });

  it("lists those home only for a standard device", () => {
    const own = HOME_ONLY.filter((p) => !ALWAYS_HOME.includes(p)).map(asName);
    for (const name of own) expect(standard, name).toContain(name);
    for (const name of standard) expect(own, name).toContain(name);
  });
});
