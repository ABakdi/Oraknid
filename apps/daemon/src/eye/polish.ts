import { mkdirSync } from "node:fs";
import type { TextPolish } from "@oraknid/contracts";
import type { EyeBrain } from "./brain.ts";

// Fix wording (Chats-and-Helper → Fix wording): one quick-model call that
// rewrites a text of mine, for any textarea of the web app. Nothing is kept:
// the text comes back, and the web app keeps mine to undo.

export const NO_MODEL =
  "No model can rephrase text right now: add a Leg, or choose The Eye's quick model (Settings → The Eye).";

export async function polishText(
  brain: EyeBrain,
  /** An empty folder of Oraknid's: the call's working directory. */
  cwd: string,
  input: TextPolish,
): Promise<{ text: string }> {
  if (!brain.polishText) throw new Error(NO_MODEL);
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  try {
    const r = await brain.polishText({ cwd, text: input.text, kind: input.kind });
    return { text: r.text.trim() };
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    // No Leg: said plainly, as a plain error the API shows as is.
    if (/^No Leg can think/.test(why)) throw new Error(NO_MODEL);
    throw new Error(`The text couldn't be rephrased: ${why}`);
  }
}
