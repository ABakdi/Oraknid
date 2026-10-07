import type { JudgeAnswer } from "../eye/brain.ts";

/** The command a judge prompt carries (ADR-053's template), for fake brains in tests. */
export function commandInJudgePrompt(prompt: string): string {
  const m = /^Command \(a JSON string[^\n]*?\): (".*")$/m.exec(prompt);
  return m ? (JSON.parse(m[1] as string) as string) : "";
}

/** A fake judge: decides by the command; stage 1 one word, stage 2 the reason. */
export function fakeJudge(
  decide: (command: string) => { decision: "allow" | "block"; reason: string },
): (i: { stage: 1 | 2; prompt: string }) => Promise<JudgeAnswer> {
  return async ({ stage, prompt }) => {
    const v = decide(commandInJudgePrompt(prompt));
    return stage === 1
      ? { decision: v.decision, category: null, reason: "" }
      : { decision: v.decision, category: null, reason: v.reason };
  };
}
