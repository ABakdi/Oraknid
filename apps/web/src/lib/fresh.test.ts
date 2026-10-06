import { afterEach, describe, expect, it, vi } from "vitest";
import { entryOf, staleBuild } from "./fresh";

// A page left open across an update learns the daemon serves a newer build (ADR-048).

vi.mock("./remote", () => ({ remote: () => null }));

const page = (entry: string) =>
  `<!doctype html><html><head><script type="module" crossorigin src="/assets/${entry}"></script></head></html>`;

afterEach(() => {
  vi.unstubAllGlobals();
  for (const s of Array.from(document.scripts)) s.remove();
});

function loaded(entry: string) {
  const s = document.createElement("script");
  s.setAttribute("src", `/assets/${entry}`);
  document.head.append(s);
}

describe("a page older than the build served", () => {
  it("reads the entry script's name", () => {
    expect(entryOf(page("index-D6SSKEkH.js"))).toBe("/assets/index-D6SSKEkH.js");
    expect(entryOf("<html></html>")).toBeNull();
  });

  it("is stale when the daemon serves another entry, not when it serves the same", async () => {
    loaded("index-OLD1.js");
    vi.stubGlobal("fetch", async () => new Response(page("index-NEW2.js")));
    expect(await staleBuild()).toBe(true);
    vi.stubGlobal("fetch", async () => new Response(page("index-OLD1.js")));
    expect(await staleBuild()).toBe(false);
  });

  it("is not stale when the daemon doesn't answer", async () => {
    loaded("index-OLD1.js");
    vi.stubGlobal("fetch", async () => {
      throw new Error("restarting");
    });
    expect(await staleBuild()).toBe(false);
  });
});
