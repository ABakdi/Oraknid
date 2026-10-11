import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexPreferred } from "./adapter.ts";

// The model I use with Codex myself (ADR-068 §2), from a stand-in home's config.

describe("Codex: the model I use myself (ADR-068 §2)", () => {
  it("reads the top-level model of its config, never a profile's", () => {
    const home = mkdtempSync(join(tmpdir(), "oraknid-codex-home-"));
    mkdirSync(join(home, ".codex"));
    writeFileSync(
      join(home, ".codex", "config.toml"),
      'model = "gpt-5.2-codex"\napproval_policy = "on-request"\n\n[profiles.fast]\nmodel = "gpt-5-mini"\n',
    );
    expect(codexPreferred(home, "")).toEqual(["gpt-5.2-codex"]);
  });

  it("says nothing without a config, or with no model in it", () => {
    const home = mkdtempSync(join(tmpdir(), "oraknid-codex-none-"));
    expect(codexPreferred(home, "")).toEqual([]);
    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".codex", "config.toml"), '[profiles.fast]\nmodel = "gpt-5-mini"\n');
    expect(codexPreferred(home, "")).toEqual([]);
  });
});
