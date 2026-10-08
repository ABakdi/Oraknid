import { describe, expect, it } from "vitest";
import { briefStat, STAT_FILES_MAX } from "./git.ts";

// 2026-10-08: a task committed a package store; its "Done" Silk entry and its handoff each
// carried a diff stat of thousands of files (1.5 MB).

describe("briefStat", () => {
  it("leaves a short stat as git wrote it", () => {
    const stat =
      " src/a.ts | 4 ++--\n src/b.ts | 2 +-\n 2 files changed, 3 insertions(+), 3 deletions(-)\n";
    expect(briefStat(stat)).toBe(stat);
  });

  it("keeps the first files, says how many more, and keeps git's summary", () => {
    const files = Array.from(
      { length: 20_000 },
      (_, i) => ` .pnpm-store/v10/files/${String(i).padStart(5, "0")}abcdef-exec |   52 +`,
    );
    const stat = `${files.join("\n")}\n 20000 files changed, 1040000 insertions(+)\n`;
    expect(stat.length).toBeGreaterThan(900_000);
    const brief = briefStat(stat);
    const lines = brief.split("\n");
    expect(lines).toHaveLength(STAT_FILES_MAX + 2);
    expect(lines[0]).toContain("00000abcdef");
    expect(lines.at(-2)).toBe(" … and 19,940 more files");
    expect(lines.at(-1)).toBe(" 20000 files changed, 1040000 insertions(+)");
    expect(brief.length).toBeLessThan(5000);
  });
});
