import { describe, expect, it } from "vitest";
import { asRequest, TOOL_VOCABULARY, toolClass } from "./tools.ts";
import { capabilitiesOf, NO_CAPABILITIES } from "./types.ts";

// Each agent's tool names, read as what they do (ADR-056 §2): the harness
// asks the SDK, never names a tool itself.

describe("tool classes, per adapter (ADR-056 §2)", () => {
  it.each([
    ["Bash", "shell"],
    ["run_command", "shell"],
    ["bash", "shell"],
    ["Read", "read"],
    ["read_file", "read"],
    ["list_dir", "read"],
    ["view_file", "read"],
    ["Write", "write"],
    ["edit_file", "write"],
    ["write_to_file", "write"],
    ["apply_patch", "write"],
    ["WebFetch", "other"],
    ["mcp__oraknid-github__push", "other"],
  ])("%s is %s", (tool, cls) => {
    expect(toolClass(tool)).toBe(cls);
  });

  it("reads a tool in one adapter's own names when told which", () => {
    expect(toolClass("run_command", TOOL_VOCABULARY.antigravity)).toBe("shell");
    expect(toolClass("run_command", TOOL_VOCABULARY["claude-code"])).toBe("other");
  });

  it("reads a call the agent made as the ask it would have been, for an audit after the fact", () => {
    // Antigravity's own names and fields.
    expect(asRequest("run_command", { CommandLine: "rm -rf /tmp/x" })).toEqual({
      tool: "Bash",
      input: { CommandLine: "rm -rf /tmp/x" },
      command: "rm -rf /tmp/x",
      path: null,
    });
    expect(asRequest("write_to_file", { TargetFile: "/w/a.ts", CodeContent: "x" })).toMatchObject({
      tool: "Write",
      command: null,
      path: "/w/a.ts",
    });
    // OpenCode's file path field.
    expect(asRequest("edit", { filePath: "/w/b.ts" })).toMatchObject({
      tool: "Write",
      path: "/w/b.ts",
    });
    // Anything else keeps its own name.
    expect(asRequest("WebFetch", { url: "https://x" })).toMatchObject({
      tool: "WebFetch",
      command: null,
    });
  });
});

describe("capabilities from the probe (ADR-056 §2)", () => {
  it("a Leg never probed, or probed by an older Oraknid, can do none of them", () => {
    expect(capabilitiesOf(null)).toEqual(NO_CAPABILITIES);
    expect(capabilitiesOf({ resume: true })).toEqual({ ...NO_CAPABILITIES, resume: true });
  });

  it("each one the probe reports is kept", () => {
    const all = { inlineGate: true, preToolHook: true, stopHook: true, resume: true, steer: true };
    expect(capabilitiesOf(all)).toEqual(all);
  });
});
