import { describe, expect, it } from "vitest";
import { EscalationPolicy, isStale, nextRung } from "./escalation.ts";
import type { Signal } from "./monitors.ts";
import {
  agentNeedsAnswer,
  countOf,
  decideOutcome,
  type Ending,
  ILL_DO_IT,
  keepsGoingWrongAnswer,
  LEAVE_IT_OUT,
  type Outcome,
  type OutcomeInput,
  repairHintOf,
  SPENDS_ATTEMPT,
  STOP_JOB,
  shouldRotate,
  type TurnVerdict,
  unusableOf,
  verdictOf,
} from "./outcome.ts";

// decideOutcome (ADR-056 §6): the precedence of a turn's end and the
// counting of an attempt, as tables. The bugs of 2026-10-06/07 are rows.

const failing: TurnVerdict = verdictOf({
  hasChecks: true,
  failed: { command: "test -f parser.js", exitCode: 1, output: "", signature: "sig" },
  cutShort: false,
  text: "Working on it.",
});
const passing: TurnVerdict = verdictOf({
  hasChecks: true,
  failed: null,
  cutShort: false,
  text: "DONE",
});

/** A turn that ended with a failing check, on the top rung, nothing else: it is told the failure. */
const base = (): OutcomeInput => ({
  stop: { reason: "completed", text: "Working on it." },
  strayed: null,
  unusable: null,
  ownerWaiting: false,
  guidance: null,
  verdict: failing,
  repair: null,
  agentNeeds: null,
  signals: [],
  rung: { higher: null },
  history: { turns: 1, level: 0, nudged: false },
  policy: { maxTurns: 25, rotateAt: 0.6 },
  usage: null,
});
const sig = (code: string, evidence = `seen ${code}`): Signal =>
  ({ kind: "drift", code, evidence }) as Signal;
const higher = { legName: "Claude", model: "opus" };

type Rule = [string, (i: OutcomeInput) => void, (o: Outcome) => boolean];

/** The precedence, highest first (ADR-056 → As built, stage 4). */
const RULES: Rule[] = [
  [
    "the folder left the project",
    (i) => (i.strayed = "no .git"),
    (o) => o.kind === "Fail" && o.why === "strayed",
  ],
  [
    "a usage limit",
    (i) => (i.stop.reason = "rate-limited"),
    (o) => o.kind === "Unavailable" && o.cause === "limit",
  ],
  [
    "the agent's error, not the task's",
    (i) => {
      i.stop.reason = "error";
      i.unusable = { kind: "limit", until: null, reason: "quota" };
    },
    (o) => o.kind === "Unavailable" && o.cause === "error",
  ],
  [
    "a turn interrupted",
    (i) => (i.stop.reason = "interrupted"),
    (o) =>
      (o.kind === "Retry" && o.session === "same") ||
      (o.kind === "Escalate" && /without finishing one/.test(o.drift.evidence)),
  ],
  [
    "my message",
    (i) => (i.guidance = "Use tabs."),
    (o) => o.kind === "Continue" && o.why === "guidance",
  ],
  ["the work not verified yet", (i) => (i.verdict = null), (o) => o.kind === "Verify"],
  [
    "a check that looks broken",
    (i) => (i.repair = { command: "test -f 'x", hint: "quoting" }),
    (o) => o.kind === "RepairChecks",
  ],
  [
    "what the agent needs of me",
    (i) => (i.agentNeeds = { said: "Owner action required: rm -rf /root/x", asked: false }),
    (o) => o.kind === "AskOwner" && o.question === "agent-needs",
  ],
  [
    "scope drift (D1)",
    (i) => i.signals.push(sig("D1")),
    (o) => o.kind === "Escalate" && o.drift.code === "D1",
  ],
  ["done", (i) => (i.verdict = passing), (o) => o.kind === "Done"],
  ["a higher rung", (i) => (i.rung.higher = higher), (o) => o.kind === "Climb"],
  [
    "another drift (D3)",
    (i) => i.signals.push(sig("D3")),
    (o) => o.kind === "Escalate" && o.drift.code === "D3",
  ],
  [
    "the turns spent",
    (i) => (i.history.turns = 25),
    (o) => o.kind === "Escalate" && /25 turns without passing/.test(o.drift.evidence),
  ],
  ["self-prompting", () => {}, (o) => o.kind === "Continue" && o.why === "self-prompt"],
];

describe("decideOutcome: the precedence of a turn's end", () => {
  it.each(RULES.map((r, n) => [r[0], n] as const))("%s alone", (_, n) => {
    const [, set, expected] = RULES[n] as Rule;
    const i = base();
    set(i);
    expect(expected(decideOutcome(i))).toBe(true);
  });

  const pairs = RULES.flatMap((hi, a) =>
    RULES.slice(a + 1).map((lo) => [`${hi[0]} before ${lo[0]}`, hi, lo] as const),
  );
  it.each(pairs)("%s", (_, hi, lo) => {
    const i = base();
    lo[1](i);
    hi[1](i);
    const o = decideOutcome(i);
    expect(hi[2](o), JSON.stringify(o)).toBe(true);
  });
});

describe("decideOutcome: the jobs of 2026-10-06/07", () => {
  const rows: [string, (i: OutcomeInput) => void, Partial<Outcome> & { kind: Outcome["kind"] }][] =
    [
      [
        // The misahaty removal: layer 1 blocked `rm -rf /root/misahaty` through the hook (D7), the
        // agent said only I can lift it, a stronger model was there: asked, not climbed nor corrected.
        "the misahaty removal blocked by layer 1: what it needs is asked, before D7 and the climb",
        (i) => {
          i.signals.push(sig("D7", "tried `rm -rf /root/misahaty` (blocked)"));
          i.rung.higher = higher;
          i.agentNeeds = {
            said: "Owner action required: rm -rf /root/misahaty",
            asked: false,
          };
        },
        { kind: "AskOwner", question: "agent-needs" },
      ],
      [
        "the misahaty removal asked once already: the forbidden action goes to the ladder, not up a rung",
        (i) => {
          i.signals.push(sig("D7", "tried `rm -rf /root/misahaty`"));
          i.rung.higher = higher;
          i.agentNeeds = { said: "Owner action required", asked: true };
        },
        { kind: "Escalate", step: "correct" },
      ],
      [
        "a hook-blocked rm the agent's own auto mode refused: asked as what it needs",
        (i) => {
          i.agentNeeds = {
            said: "3 blocks in a row by its own auto mode: “I can't remove it”",
            asked: false,
          };
        },
        { kind: "AskOwner", question: "agent-needs" },
      ],
      [
        "the broken quoted check: repaired before anyone is asked or climbs",
        (i) => {
          i.repair = { command: 'test "$(cat x)" = \'y', hint: "the shell can't parse it" };
          i.agentNeeds = { said: "The check itself is broken", asked: false };
          i.rung.higher = higher;
        },
        { kind: "RepairChecks" },
      ],
      [
        "an agent out of quota (“Resets in 51h49m11s”): unavailable, never a failure",
        (i) => {
          i.stop.reason = "rate-limited";
          i.rung.higher = higher;
        },
        { kind: "Unavailable", cause: "limit" },
      ],
      [
        "an agent's error saying its quota is out: unavailable",
        (i) => {
          i.stop.reason = "error";
          i.unusable = unusableOf("Individual quota reached. Resets in 51h49m11s", "mimo", 0);
        },
        { kind: "Unavailable", cause: "error" },
      ],
      [
        "an agent's error of its own: a failure",
        (i) => (i.stop.reason = "error"),
        { kind: "Fail", why: "error" },
      ],
      [
        "an interrupted turn: told to go on in its session, not verified",
        (i) => {
          i.stop.reason = "interrupted";
          i.verdict = null;
        },
        { kind: "Retry", session: "same" },
      ],
      [
        "a turn at its limit of steps: no climb, no question, it goes on in its session",
        (i) => {
          i.stop.reason = "max_turns";
          i.rung.higher = higher;
          i.agentNeeds = { said: "Owner action required", asked: false };
        },
        { kind: "Continue", why: "self-prompt" },
      ],
      [
        "edits outside the scope with a failing check: the scope first, not climbed (bug 13)",
        (i) => {
          i.signals.push(sig("D1", "changed files outside its scope: package.json"));
          i.rung.higher = higher;
        },
        { kind: "Escalate", step: "correct" },
      ],
      [
        "waiting on me is no stall",
        (i) => {
          i.stop.reason = "none";
          i.ownerWaiting = true;
          i.signals.push(sig("D5"));
        },
        { kind: "Continue", why: "wait" },
      ],
      [
        "a stall while no turn ends: the ladder",
        (i) => {
          i.stop.reason = "none";
          i.signals.push({ kind: "stall", code: "D5", evidence: "no output for 6 min" });
        },
        { kind: "Escalate", step: "correct" },
      ],
      [
        "nothing yet while no turn ends: keep watching",
        (i) => (i.stop.reason = "none"),
        { kind: "Continue", why: "watch" },
      ],
      [
        "at the top of the ladder, a drift after four steps: I'm asked",
        (i) => {
          i.signals.push(sig("D3"));
          i.history.level = 4;
        },
        { kind: "AskOwner", question: "keeps-going-wrong" },
      ],
      [
        "a refused gate tried again (D8): killed at once",
        (i) => i.signals.push(sig("D8", "tried `nmap` again after I refused it")),
        { kind: "Escalate", step: "kill" },
      ],
    ];
  it.each(rows)("%s", (_, set, expected) => {
    const i = base();
    set(i);
    expect(decideOutcome(i)).toMatchObject(expected);
  });

  it("the stuck monitor's and the turn budget's signals aren't drifts of the ladder", () => {
    const i = base();
    i.signals.push(
      { kind: "stuck", code: "talk", evidence: "ended 3 turns in a row with words" },
      { kind: "budget", code: "turns", evidence: "took 3 turns" },
    );
    expect(decideOutcome(i)).toMatchObject({ kind: "Continue", why: "self-prompt" });
  });

  it("self-prompting rotates the session when its context is past its share", () => {
    const i = base();
    i.usage = { contextTokens: 130_000, contextWindow: 200_000 };
    expect(decideOutcome(i)).toMatchObject({ kind: "Continue", rotate: true });
    expect(shouldRotate({ contextTokens: 100_000, contextWindow: 200_000 }, 0.6)).toBe(false);
  });

  it("the turn's failure goes back to the agent, and with a ladder's correction", () => {
    const self = decideOutcome(base());
    expect(self.kind === "Continue" && self.feedback).toMatch(
      /test -f parser\.js[\s\S]*Fix it, then say DONE/,
    );
    const i = base();
    i.signals.push(sig("D3"));
    expect(decideOutcome(i)).toMatchObject({ failure: failing.failure });
  });
});

describe("the verdict of a turn", () => {
  it("a failing check after a claim of done is a false claim; at the limit of steps, words are no claim", () => {
    const f = { command: "npm test", exitCode: 1, output: "1 failed", signature: "s" };
    expect(
      verdictOf({ hasChecks: true, failed: f, cutShort: false, text: "All done." }).record,
    ).toEqual({
      failure: "s",
      falseClaim: "said it was done, but `npm test` failed",
    });
    expect(
      verdictOf({ hasChecks: true, failed: f, cutShort: true, text: "All done." }).record
        .falseClaim,
    ).toBeNull();
  });

  it("without checks: The Eye's review, accepted when it couldn't review; not done at the limit of steps", () => {
    const review = { accepted: false, reason: "no table", missing: ["the table"] };
    const v = verdictOf({ hasChecks: false, review, cutShort: false, text: "Done." });
    expect(v).toMatchObject({ verified: false, record: { failure: "evaluate:the table" } });
    expect(verdictOf({ hasChecks: false, review: null, cutShort: false, text: "" }).verified).toBe(
      true,
    );
    expect(verdictOf({ hasChecks: false, cutShort: true, text: "" }).verified).toBe(false);
  });

  it("a check looks broken by the Verifier's hint, else by the agent's words", () => {
    const report = {
      failures: [{ command: "a" }],
      broken: [] as { command: string; hint: string }[],
    };
    expect(repairHintOf(report, "Working.")).toBeNull();
    expect(repairHintOf(report, "The check itself is broken: a quoting issue.")?.hint).toMatch(
      /the agent says/,
    );
    expect(repairHintOf({ ...report, broken: [{ command: "a", hint: "syntax" }] }, "")).toEqual({
      command: "a",
      hint: "syntax",
    });
  });
});

describe("what isn't the task's, from the agent's words", () => {
  it.each([
    [
      "Model mimo-v2.5-free has been deprecated. Use mimo-v2.6 instead.",
      "mimo-v2.5-free",
      "deprecated",
    ],
    // Another model deprecated: its provider failing for this one, not this model replaced.
    ["Model other has been deprecated.", "mimo-v2.5-free", "provider"],
    ["Individual quota reached. Resets in 51h49m11s", "m", "limit"],
    ["503 Service Unavailable", "m", "provider"],
    ["TypeError: x is undefined", "m", null],
  ])("%s", (error, model, kind) => {
    expect(unusableOf(error, model, 0)?.kind ?? null).toBe(kind);
  });

  it("any failure to start is the Leg's", () => {
    expect(unusableOf("spawn ENOENT", "m", 0, true)).toMatchObject({
      kind: "provider",
      failure: { scope: "leg" },
    });
  });
});

describe("my answers, as outcomes", () => {
  it.each([
    ["Allow", "rm -rf /root/x", { kind: "Continue", why: "owner", grant: "rm -rf /root/x" }],
    ["Allow", null, { kind: "Continue", why: "owner", feedback: "The owner answers: Allow" }],
    [ILL_DO_IT, "x", { kind: "OwnerTakes" }],
    [LEAVE_IT_OUT, "x", { kind: "LeaveOut", dependents: true }],
    [STOP_JOB, "x", { kind: "CancelJob" }],
    [
      "Just write the file.",
      "x",
      { kind: "Continue", feedback: "The owner answers: Just write the file." },
    ],
  ] as const)("to what it needs: %s", (answer, command, expected) => {
    expect(agentNeedsAnswer(answer, command, "Remove it", "Allow")).toMatchObject(expected);
  });

  it.each([
    [{ kind: "mine" }, { kind: "OwnerTakes" }],
    [
      { kind: "leave-out", dependents: false },
      { kind: "LeaveOut", dependents: false },
    ],
    [{ kind: "stop" }, { kind: "CancelJob" }],
    [
      { kind: "advice", advice: "" },
      { kind: "Retry", byOwner: true, reason: "retrying, as I asked" },
    ],
    [
      { kind: "advice", advice: "Tabs." },
      { kind: "Retry", reason: "retrying with my advice" },
    ],
    [
      { kind: "another-leg", legId: "l2", advice: "", legName: "OpenCode" },
      { kind: "Retry", legId: "l2", reason: "given to OpenCode by me" },
    ],
  ] as const)("to “keeps going wrong”: %j", (choice, expected) => {
    expect(keepsGoingWrongAnswer(choice, "Parse")).toMatchObject(expected);
  });
});

describe("counting, written once", () => {
  const rows: [string, Ending, string, boolean, boolean][] = [
    ["done", { kind: "Done" }, "succeeded", false, true],
    ["a failure of its own", { kind: "Fail", why: "error", reason: "" }, "failed", true, true],
    ["the folder put back", { kind: "Fail", why: "strayed", reason: "" }, "failed", true, true],
    ["a climb on a real failure", { kind: "Climb", to: higher, failure: "" }, "failed", true, true],
    [
      "the ladder's step up, reassign or kill",
      {
        kind: "Escalate",
        step: "kill",
        level: 4,
        drift: { code: "D8", evidence: "" },
        failure: "",
      },
      "reassigned",
      true,
      true,
    ],
    [
      "out of quota or its provider failing",
      { kind: "Unavailable", cause: "limit" },
      "unavailable",
      false,
      false,
    ],
    ["a session that couldn't start", { kind: "CouldNotStart" }, "unavailable", false, false],
    [
      "my “try again” (bug 10)",
      { kind: "Retry", session: "new", byOwner: true, reason: "", advice: "" },
      "redirected",
      false,
      false,
    ],
    ["“I'll do it” (bug 11)", { kind: "OwnerTakes" }, "abandoned", false, false],
    ["“Leave it out” (bug 11)", { kind: "LeaveOut", dependents: true }, "abandoned", false, false],
    ["“Stop the job” (bug 11)", { kind: "CancelJob", reason: "" }, "abandoned", false, false],
    ["stopped by its Leg", { kind: "Stopped", byJob: false }, "abandoned", false, true],
    ["stopped by me or its job", { kind: "Stopped", byJob: true }, "abandoned", false, false],
  ];
  it.each(rows)("%s", (_, ending, record, spends, learn) => {
    expect(countOf(ending)).toMatchObject({ record, spends, learn });
  });

  it("only failures spend the task's attempts", () => {
    expect([...SPENDS_ATTEMPT]).toEqual(["failed", "reassigned"]);
  });
});

describe("the escalation policy", () => {
  const ranked = [
    { rung: 1, id: "a" },
    { rung: 3, id: "b" },
    { rung: 4, id: "c" },
  ];

  it("the first route on a higher rung, else the top", () => {
    expect(nextRung(1, ranked, false)).toEqual({ rung: 3, id: "b" });
    expect(nextRung(4, ranked, false)).toBe("top");
    expect(nextRung(0, [], false)).toBe("top");
  });

  it("a task I pinned or gave to a Leg doesn't climb", () => {
    expect(nextRung(1, ranked, true)).toBe("top");
  });

  it("the drift ladder: correct, reset, step up or reassign, kill, ask; D8 kills", () => {
    const steps = [0, 1, 2, 3, 4].map((l) => EscalationPolicy.step(l, "D3").step);
    expect(steps).toEqual(["correct", "reset", "step-up", "kill", "ask"]);
    expect(EscalationPolicy.step(2, "D2").step).toBe("reassign");
    expect(EscalationPolicy.step(0, "D8").step).toBe("kill");
  });

  it.each([
    [3, { attemptCount: 3, settledAttempt: 2 }, false],
    [3, { attemptCount: 4, settledAttempt: 2 }, true],
    [3, { attemptCount: 3, settledAttempt: 3 }, true],
  ])("attempt %i's result is stale: %j → %s", (n, task, stale) => {
    expect(isStale(n, task)).toBe(stale);
  });
});
