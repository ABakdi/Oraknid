import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createOpenCodeAdapter } from "./adapter.ts";
import { configModel, historyModels } from "./preferred.ts";

// The models I use with OpenCode myself (ADR-068 §2), read from a stand-in
// home: never mine.

async function fakeHome(o: { messages?: [string, string, number][]; config?: string }) {
  const home = mkdtempSync(join(tmpdir(), "oraknid-oc-home-"));
  if (o.messages) {
    const dir = join(home, ".local", "share", "opencode");
    mkdirSync(dir, { recursive: true });
    const { DatabaseSync } = (await import("node:sqlite")) as unknown as {
      DatabaseSync: new (
        p: string,
      ) => {
        exec(s: string): void;
        prepare(s: string): { run(...a: unknown[]): void };
        close(): void;
      };
    };
    const db = new DatabaseSync(join(dir, "opencode.db"));
    db.exec(
      "CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)",
    );
    const insert = db.prepare("INSERT INTO message VALUES (?, 's', 0, 0, ?)");
    let n = 0;
    for (const [role, model, count] of o.messages)
      for (let i = 0; i < count; i++)
        insert.run(
          `m${n++}`,
          JSON.stringify(
            role === "assistant"
              ? { role, providerID: "opencode", modelID: model }
              : { role, model: { providerID: "opencode", modelID: model } },
          ),
        );
    db.close();
  }
  if (o.config) {
    const dir = join(home, ".config", "opencode");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "opencode.jsonc"), o.config);
  }
  return home;
}

describe("OpenCode: the models I use myself (ADR-068 §2)", () => {
  it("reads its database's assistant messages, most used first, and leaves out what I tried once", async () => {
    const home = await fakeHome({
      messages: [
        ["assistant", "big-pickle", 40],
        ["assistant", "kimi-k2-free", 5],
        ["assistant", "longcat-2.5-preview-free", 1],
        ["user", "longcat-2.5-preview-free", 30],
      ],
    });
    expect(await historyModels(home)).toEqual(["big-pickle", "kimi-k2-free"]);
  });

  it("adds its config's model (JSONC, provider prefix off), and the adapter says the same", async () => {
    const home = await fakeHome({
      messages: [["assistant", "big-pickle", 3]],
      config: `{
        // my default
        "$schema": "https://opencode.ai/config.json",
        "model": "opencode/grok-code-free", /* trailing */
      }`,
    });
    expect(configModel(home)).toBe("grok-code-free");
    const adapter = createOpenCodeAdapter();
    expect(
      await adapter.preferredModels?.({ id: "l", name: "OC", kind: "opencode", config: {} }, home),
    ).toEqual(["big-pickle", "grok-code-free"]);
  });

  it("says nothing when the tool kept nothing", async () => {
    const home = mkdtempSync(join(tmpdir(), "oraknid-oc-empty-"));
    expect(await historyModels(home)).toEqual([]);
    expect(configModel(home)).toBeNull();
  });
});
