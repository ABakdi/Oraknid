import type { PlannedTask, WebPlan } from "@oraknid/contracts";
import { describe, expect, it } from "vitest";
import { detect } from "./drift.ts";
import {
  brokenCheckHint,
  deprecationOf,
  durationMs,
  oraknidOwn,
  resetsAtFrom,
  saysCheckBroken,
  saysOwnerNeeded,
  specComplete,
  usageLimitOf,
} from "./harness.ts";
import { effectiveProfile, emptyStoredProfile } from "./profiles.ts";
import { type RouteCandidate, type RouteTask, route, rungOf, workKindOf } from "./routing.ts";
import { shapeWeb } from "./web.ts";

// ADR-052, M15.1 and M15.3: what sank the two jobs of 2026-10-06, in their own words.

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);

describe("an agent's own words about when it can work again (M15.1)", () => {
  it("reads Antigravity's quota and its reset in 51 hours", () => {
    const said =
      "Individual quota reached for Gemini 3 Pro. Resets in 51h49m11s. Upgrade for higher limits.";
    expect(durationMs("51h49m11s")).toBe((51 * 3600 + 49 * 60 + 11) * 1000);
    expect(usageLimitOf(said, NOW)).toEqual({
      until: NOW + (51 * 3600 + 49 * 60 + 11) * 1000,
      reason: said,
    });
  });

  it("reads other ways of saying when", () => {
    expect(resetsAtFrom("Rate limit exceeded, try again in 2 hours and 5 minutes", NOW)).toBe(
      NOW + 125 * 60_000,
    );
    expect(resetsAtFrom("quota exceeded; resets in 30s", NOW)).toBe(NOW + 30_000);
    expect(resetsAtFrom("usage limit reached, resets at 2026-10-09T14:00:00Z", NOW)).toBe(
      Date.UTC(2026, 9, 9, 14),
    );
    const epoch = Math.floor(NOW / 1000) + 3600;
    expect(resetsAtFrom(`{"error":"429","reset_at": ${epoch}}`, NOW)).toBe(epoch * 1000);
    expect(usageLimitOf("Usage limit reached", NOW)).toEqual({
      until: null,
      reason: "Usage limit reached",
    });
    expect(usageLimitOf("The model refused: the task makes no sense", NOW)).toBeNull();
  });

  it("reads a deprecated model and the one its provider names instead", () => {
    expect(
      deprecationOf("Model mimo-v2.5-free has been deprecated. Use mimo-v2.6-flash-free instead."),
    ).toEqual({ model: "mimo-v2.5-free", replacement: "mimo-v2.6-flash-free" });
    expect(deprecationOf("The model gpt-x is deprecated.")).toEqual({
      model: "gpt-x",
      replacement: null,
    });
    expect(deprecationOf("Internal server error")).toBeNull();
  });
});

describe("checks told broken from failing on the work (M15.1)", () => {
  it("knows a quoting bug, a syntax error, a missing tool from a check that fails on the work", () => {
    expect(brokenCheckHint(2, "sh: 1: [: too many arguments")).toMatch(/quoting/);
    expect(
      brokenCheckHint(1, "sh: -c: line 1: unexpected EOF while looking for matching `'`"),
    ).toMatch(/syntax or quoting/);
    expect(brokenCheckHint(2, "sh: 1: Syntax error: Unterminated quoted string")).toMatch(
      /syntax or quoting/,
    );
    expect(brokenCheckHint(127, "sh: 1: rg: not found")).toBe(
      "`rg` isn't installed where checks run",
    );
    expect(brokenCheckHint(126, "sh: 1: jq: Permission denied")).toMatch(/can't be run/);
    // A script of the work not written, or not made executable, yet: the work's.
    expect(brokenCheckHint(127, "sh: 1: ./hello.sh: not found")).toBeNull();
    expect(brokenCheckHint(126, "sh: 1: ./hello.sh: Permission denied")).toBeNull();
    expect(brokenCheckHint(2, "grep: invalid option -- '5'\nUsage: grep [OPTION]...")).toMatch(
      /invalid|refused/,
    );
    // Failing on the work: the file isn't there, the test fails, the grep finds nothing.
    expect(brokenCheckHint(2, "grep: notes.md: No such file or directory")).toBeNull();
    expect(brokenCheckHint(1, "FAIL src/app.test.ts > adds\nexpected 2 to be 3")).toBeNull();
    expect(brokenCheckHint(1, "")).toBeNull();
  });

  it("hears an agent say, with evidence, that a check is broken", () => {
    const report =
      "The removal is actually complete: the compose project is gone and its volumes backed up. Oraknid's automated check #1 fails due to a quoting issue in the check itself.";
    expect(saysCheckBroken(report)).toMatch(/check #1 fails due to a quoting issue/);
    expect(saysCheckBroken("DONE. All checks pass.")).toBeNull();
    expect(saysCheckBroken("The tests fail; I couldn't fix the reducer.")).toBeNull();
  });

  it("knows a check whose ssh can't set up, before any work, as broken (2026-10-07)", () => {
    // ssh cuts the path at 100 characters in its own message: the path isn't where checks run.
    const said =
      "Can't open user config file /home/abakdi/.local/share/oraknid/legs/01K6Z/jobs/01K70ABCDEFG/ho: No such file or directory";
    expect(brokenCheckHint(255, said)).toMatch(/ssh can't set up/);
    expect(
      brokenCheckHint(
        2,
        "cat: /home/me/.local/share/oraknid/legs/l1/jobs/j1/home/x: No such file or directory",
      ),
    ).toMatch(/private to the job/);
    expect(
      brokenCheckHint(
        255,
        "ssh: Could not resolve hostname oraknid-spinet-staging: Name or service not known",
      ),
    ).toMatch(/ssh can't set up/);
    expect(
      brokenCheckHint(255, "ssh: connect to host 10.0.0.9 port 22: Connection refused"),
    ).toMatch(/couldn't connect/);
    // A file of the work on the server, not there yet: the work's.
    expect(
      brokenCheckHint(1, "ls: cannot access '/srv/app': No such file or directory"),
    ).toBeNull();
  });

  it("hears an agent say it can't finish without the owner (2026-10-07)", () => {
    const report =
      "Removed the containers and volumes. The check is right and the fix is blocked by a guardrail that only the owner can lift. Owner action required: rm -rf /root/misahaty";
    expect(saysOwnerNeeded(report)).toMatch(/guardrail that only the owner can lift/);
    expect(saysOwnerNeeded(report)).toContain("Owner action required: rm -rf /root/misahaty");
    expect(saysOwnerNeeded("DONE. Removed everything; the checks pass.")).toBeNull();
    expect(saysOwnerNeeded("The tests fail; I couldn't fix the reducer.")).toBeNull();
  });
});

describe("Oraknid's own files are never scope drift (M15.1)", () => {
  it("ignores notes/handoff.md and .oraknid/, still sees the rest", () => {
    expect(oraknidOwn("notes/handoff.md")).toBe(true);
    expect(oraknidOwn(".oraknid/silk/progress.md")).toBe(true);
    expect(oraknidOwn("notes/findings.md")).toBe(false);
    const found = detect(
      {
        scope: ["src/**"],
        changedPaths: ["src/a.ts", "notes/handoff.md", ".oraknid/x", "README.md"],
        commands: [],
        verifyFailures: [],
        falseClaim: null,
        lastActivityAt: NOW,
        tokensSinceProgress: 0,
        taskBudgetTokens: null,
        forbidden: [],
        gateBypass: [],
        local: false,
      },
      NOW,
    );
    expect(found.map((d) => d.evidence)).toEqual(["changed files outside its scope: README.md"]);
  });
});

describe("one interview round when the spec is complete (M15.3)", () => {
  it("tells a complete spec from a one-line goal", () => {
    expect(specComplete("Build me a piano app")).toBe(false);
    const spec = `# Piano\n\n## Features\n${Array.from({ length: 8 }, (_, i) => `- feature ${i}`).join("\n")}\n\n## Stack\nReact, Vite.`;
    expect(specComplete(spec)).toBe(true);
  });
});

// ── The ladder ─────────────────────────────────────────────────────

const cand = (
  legName: string,
  kind: "claude-code" | "opencode",
  model: string,
  over: Partial<RouteCandidate> = {},
): RouteCandidate => ({
  legId: legName,
  legModelId: `m-${model}`,
  model,
  legName,
  legKind: kind,
  health: "healthy",
  paused: false,
  effortLevels: [],
  profile: effectiveProfile(kind, model, emptyStoredProfile()),
  windows: [],
  ...over,
});
const free = cand("OpenCode", "opencode", "big-pickle-free");
const sonnet = cand("Claude", "claude-code", "sonnet");
const opus = cand("Claude", "claude-code", "opus");
const job = (over: Partial<RouteTask> = {}): RouteTask => ({
  kind: "implement",
  difficulty: "low",
  requiredCapabilities: ["implementation"],
  estimatedTokens: 20_000,
  stepUp: 0,
  ...over,
});
const first = (t: RouteTask, o: Parameters<typeof route>[2] = { moneyAllowed: false }) =>
  route(t, [free, sonnet, opus], o).ranked[0]?.candidate.model;

describe("the ladder (M15.3)", () => {
  it("orders rungs per kind of work from the profiles", () => {
    const code = workKindOf({ kind: "implement", scope: ["src/**"] });
    expect(code).toBe("code");
    expect(workKindOf({ kind: "implement", scope: ["docs/**", "README.md"] })).toBe("docs");
    expect(workKindOf({ kind: "mechanical" }, true)).toBe("server");
    const rung = (c: RouteCandidate) => rungOf(c.profile, code, "implement");
    expect(rung(free)).toBeLessThan(rung(sonnet));
    expect(rung(sonnet)).toBeLessThan(rung(opus));
  });

  it("starts low, and one failure moves the task up a rung, then to the top", () => {
    // A free model may take small work first (or a stronger one does).
    expect(["big-pickle-free", "sonnet"]).toContain(first(job()));
    // The free model failed it: never another model at its rung or below, Sonnet next.
    const r = route(job({ avoid: ["m-big-pickle-free"] }), [free, sonnet, opus], {
      moneyAllowed: false,
    });
    expect(r.ranked[0]?.candidate.model).toBe("sonnet");
    expect(r.ranked[0]?.reasons[0]).toBe("a rung up after a failure");
    expect(r.ranked.map((x) => x.candidate.model)).not.toContain("big-pickle-free");
    expect(first(job({ avoid: ["m-big-pickle-free", "m-sonnet"] }))).toBe("opus");
    // The top of the ladder failed it too: the strongest allowed takes it again.
    const top = route(
      job({ avoid: ["m-big-pickle-free", "m-sonnet", "m-opus"] }),
      [free, sonnet, opus],
      {
        moneyAllowed: false,
      },
    ).ranked[0];
    expect(top?.candidate.model).toBe("opus");
    expect(top?.reasons[0]).toMatch(/top of the ladder/);
  });

  it("keeps a job within its Claude share while something else can take the task", () => {
    expect(
      first(job(), {
        moneyAllowed: false,
        claudeShare: { limit: 0.2, used: 0.5 },
      }),
    ).toBe("big-pickle-free");
    // Nothing else left: Claude takes it, share or not.
    expect(
      route(job(), [sonnet], { moneyAllowed: false, claudeShare: { limit: 0, used: 1 } }).ranked[0]
        ?.candidate.model,
    ).toBe("sonnet");
  });
});

// ── Whole goals: crumbs merged ────────────────────────────────────

const step = (key: string, title: string, over: Partial<PlannedTask> = {}): PlannedTask => ({
  key,
  title,
  instructions: `${title}.`,
  kind: "mechanical",
  dependsOn: [],
  scope: ["notes/**"],
  verify: [],
  requiredCapabilities: ["mechanical"],
  difficulty: "low",
  ...over,
});

describe("whole goals: a plan of crumbs merged (M15.3)", () => {
  it("makes the misahaty removal's chain of crumbs one task", () => {
    const crumbs: WebPlan = {
      summary: "Remove the misahaty compose project.",
      jobVerify: [],
      tasks: [
        step("look", "Inspect the misahaty compose project", {
          kind: "research",
          scope: ["findings.md"],
        }),
        step("backup", "Back up its volumes", {
          dependsOn: ["look"],
          verify: ["ssh vps test -s /root/backup.tgz"],
        }),
        step("down", "Run docker compose down", {
          dependsOn: ["backup"],
          verify: ["ssh vps true"],
        }),
        step("rm", "Remove the project's folder", { dependsOn: ["down"] }),
        step("check", "Verify nothing of it runs", {
          kind: "test",
          dependsOn: ["rm"],
          verify: ["ssh vps sh -c '! docker ps | grep -q misahaty'"],
        }),
      ],
    };
    const { plan, notes } = shapeWeb(crumbs);
    expect(plan.tasks).toHaveLength(1);
    const one = plan.tasks[0];
    expect(one?.key).toBe("look");
    expect(one?.kind).toBe("mechanical");
    expect(one?.title).toMatch(/^Inspect the misahaty compose project/);
    expect(one?.instructions).toMatch(/1\. \*\*Inspect[\s\S]*5\. \*\*Verify nothing of it runs/);
    expect(one?.verify).toEqual([
      "ssh vps test -s /root/backup.tgz",
      "ssh vps true",
      "ssh vps sh -c '! docker ps | grep -q misahaty'",
    ]);
    expect(one?.scope).toEqual(["findings.md", "notes/**"]);
    expect(notes.join(" ")).toMatch(
      /5 small steps one after another on the same place are one task/,
    );
  });

  it("keeps substantial or independent work apart", () => {
    const apart: WebPlan = {
      summary: "s",
      jobVerify: [],
      tasks: [
        step("api", "Build the API", {
          kind: "implement",
          scope: ["api/**"],
          verify: ["pnpm -C api test"],
          difficulty: "high",
        }),
        step("web", "Build the web app", {
          kind: "implement",
          scope: ["web/**"],
          verify: ["pnpm -C web test"],
          dependsOn: ["api"],
        }),
        step("e2e", "End-to-end tests", {
          kind: "test",
          scope: ["e2e/**"],
          verify: ["pnpm e2e"],
          dependsOn: ["web"],
        }),
      ],
    };
    expect(shapeWeb(apart).plan.tasks.map((t) => t.key)).toEqual(["api", "web", "e2e"]);
    // Two small steps are a chain, not crumbs.
    const two: WebPlan = {
      ...apart,
      tasks: [step("a", "A"), step("b", "B", { dependsOn: ["a"] })],
    };
    expect(shapeWeb(two).plan.tasks).toHaveLength(2);
  });

  it("keeps what came after the chain after the merged task", () => {
    const p: WebPlan = {
      summary: "s",
      jobVerify: [],
      tasks: [
        step("a", "A"),
        step("b", "B", { dependsOn: ["a"] }),
        step("c", "C", { dependsOn: ["b"] }),
        step("x", "Something else", {
          kind: "implement",
          scope: ["src/**"],
          verify: ["pnpm test"],
          difficulty: "high",
          dependsOn: ["c"],
        }),
      ],
    };
    const shaped = shapeWeb(p).plan.tasks;
    expect(shaped.map((t) => [t.key, t.dependsOn])).toEqual([
      ["a", []],
      ["x", ["a"]],
    ]);
  });
});
