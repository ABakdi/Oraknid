import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { afterEach, describe, expect, it } from "vitest";
import type { Router } from "../api/router.ts";
import { type Daemon, startDaemon } from "../daemon.ts";
import { resolvePaths } from "../paths.ts";
import { fakeOs } from "../testing/fake-os.ts";
import { BrainFailed, type EyeBrain } from "./brain.ts";
import { NO_MODEL } from "./polish.ts";

// Fix wording (Chats-and-Helper → Fix wording): text.polish, one quick
// call through The Eye's brain; no model said plainly.

let daemon: Daemon | undefined;
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
});

async function start(brain: Partial<EyeBrain>) {
  const dir = mkdtempSync(join(tmpdir(), "oraknid-polish-"));
  daemon = await startDaemon({
    paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
    port: 0,
    dbFile: ":memory:",
    os: fakeOs().os,
    adapters: {},
    brain: brain as EyeBrain,
  });
  return createORPCClient<RouterClient<Router>>(
    new RPCLink({
      url: `${daemon.url}/api`,
      headers: { authorization: `Bearer ${daemon.cliToken}` },
    }),
  );
}

describe("text.polish", () => {
  it("hands the text and its kind to the quick call, and answers its rewrite", async () => {
    const asked: { text: string; kind: string; cwd: string }[] = [];
    const api = await start({
      polishText: async (i) => {
        asked.push(i);
        return { text: "  The VPS for my sites: nginx and two Node apps under pm2.\n" };
      },
    });
    const r = await api.text.polish({
      text: "the vps for my sites nginx and 2 node app under pm2",
      kind: "server-description",
    });
    expect(r).toEqual({ text: "The VPS for my sites: nginx and two Node apps under pm2." });
    expect(asked[0]).toMatchObject({
      text: "the vps for my sites nginx and 2 node app under pm2",
      kind: "server-description",
    });
    // An empty folder of Oraknid's, never a project's.
    expect(asked[0]?.cwd).toMatch(/tmp[/\\]polish$/);
    // The kind defaults to plain text.
    await api.text.polish({ text: "helo" });
    expect(asked[1]?.kind).toBe("plain");
  });

  it("says plainly when no model can", async () => {
    let api = await start({
      polishText: async () => {
        throw new BrainFailed("No Leg can think for The Eye right now: there are no Legs.");
      },
    });
    await expect(api.text.polish({ text: "helo" })).rejects.toThrow(NO_MODEL);
    await daemon?.close();
    api = await start({});
    await expect(api.text.polish({ text: "helo" })).rejects.toThrow(NO_MODEL);
  });
});
