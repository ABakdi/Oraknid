import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readSessionLog } from "./session-log.ts";

const line = (e: Record<string, unknown>) => `${JSON.stringify({ at: 1, ...e })}\n`;

describe("reading a session's log (Checkpoint 1 → F1-3, Audit 1 → Q1-03, Q1-24)", () => {
  it("joins streamed text, summarises tools, and resumes from where it stopped", () => {
    const file = join(mkdtempSync(join(tmpdir(), "oraknid-log-")), "s.ndjson");
    writeFileSync(
      file,
      line({ type: "text.delta", text: "Hel" }) +
        line({ type: "text.delta", text: "lo" }) +
        line({ type: "tool.called", id: "1", tool: "Bash", input: { command: "ls" } }) +
        line({ type: "usage", usage: {} }),
    );
    const a = readSessionLog(file);
    expect(a.entries.map((e) => [e.kind, e.text])).toEqual([
      ["text", "Hello"],
      ["tool", "ls"],
    ]);
    appendFileSync(file, '{"at":2,"type":"text.delta","text":"half');
    expect(readSessionLog(file, a.next)).toEqual({ entries: [], next: a.next });
    appendFileSync(file, '"}\n');
    expect(readSessionLog(file, a.next).entries).toEqual([{ at: 2, kind: "text", text: "half" }]);
  });

  it("skips a line longer than a read instead of stopping there for good", () => {
    const file = join(mkdtempSync(join(tmpdir(), "oraknid-log-")), "s.ndjson");
    writeFileSync(
      file,
      line({ type: "tool.result", id: "1", ok: true, output: "x".repeat(600_000) }) +
        line({ type: "text.delta", text: "after" }),
    );
    const first = readSessionLog(file);
    expect(first.entries[0]?.text).toMatch(/too long to show/);
    const second = readSessionLog(file, first.next);
    expect(second.entries.map((e) => e.text)).toEqual(["after"]);
  });
});
