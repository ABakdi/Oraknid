import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { guidanceFromOthers, parseSkill, skillChecks, skillExcerpt } from "./skills.ts";

describe("parseSkill", () => {
  it("reads the built-in canon-driven skill", () => {
    const md = readFileSync(
      join(import.meta.dirname, "../../../skills/canon-driven-development.md"),
      "utf8",
    );
    const s = parseSkill(md, "fallback");
    expect(s).toMatchObject({
      name: "canon-driven-development",
      interview: true,
      requiredTools: [],
      verify: [],
      ignored: [],
    });
    expect(s.description).toMatch(/^Run a software project/);
    expect(s.body).toMatch(/^# Canon-Driven Development/);
  });

  it("reads lists in both styles", () => {
    const s = parseSkill(
      '---\nname: x\nverify:\n  - pnpm test\n  - "pnpm lint"\nrequires:\n  tools: [email, calendar]\n---\nbody',
      "f",
    );
    expect(s.verify).toEqual(["pnpm test", "pnpm lint"]);
    expect(s.requiredTools).toEqual(["email", "calendar"]);
  });

  it("never refuses a skill for bad front matter, and says what it ignored", () => {
    const s = parseSkill("---\nname: x\ninterview: maybe\ncolour: blue\n: oops\n---\nbody", "f");
    expect(s.name).toBe("x");
    expect(s.interview).toBe(false);
    expect(s.ignored).toEqual([
      'Could not read the line ": oops".',
      '"interview" should be true or false, not "maybe".',
      '"colour" is not a field Oraknid knows; it was ignored.',
    ]);
  });

  it("works without front matter", () => {
    expect(parseSkill("# Just markdown", "my-skill")).toMatchObject({
      name: "my-skill",
      body: "# Just markdown",
      ignored: [],
    });
  });
});

describe("skillExcerpt", () => {
  it("keeps the introduction and the section the task is about", () => {
    const body =
      "# Method\nShort version.\n\n## Testing\nWrite tests first.\n\n## Releasing\nTag it.";
    const e = skillExcerpt(body, "write the release notes and tag the release");
    expect(e).toContain("Short version.");
    expect(e).toContain("Tag it.");
    expect(e).not.toContain("Write tests first.");
  });
});

describe("skillChecks", () => {
  it("reads the skill's own checks for non-code results, or nothing", () => {
    const body =
      "# Mail\n\nIntro.\n\n## Checks\n- Every draft is addressed to the sender.\n- No draft promises a date.\n\n## Sending\nAsk first.\n";
    expect(skillChecks(body)).toBe(
      "- Every draft is addressed to the sender.\n- No draft promises a date.",
    );
    expect(skillChecks("# No checks\n\n## Other\nx")).toBe("");
  });
});

describe("guidanceFromOthers", () => {
  it("brings another skill's section when it fits the task better, and nothing otherwise", () => {
    const main = "# Code\n\n## Tests\nWrite tests first.\n";
    const docs = {
      name: "docs",
      body: "# Docs\n\n## Writing the README\nA README says what, why and how to run it.\n",
    };
    expect(guidanceFromOthers(main, [docs], "Write the README for the project")).toContain(
      'From the "docs" skill',
    );
    expect(guidanceFromOthers(main, [docs], "Add tests for the parser")).toBe("");
  });
});
