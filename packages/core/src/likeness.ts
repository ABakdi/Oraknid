// Telling when two pieces of text say the same thing (The-Eye → Planning,
// Skills → The interview): a question asked again in other words, the same
// task planned twice. Deterministic and coarse on purpose: words, not
// meaning, so it only catches what is plainly the same.

const STOP = new Set(
  `a about above after again all also am an and any are as at be because been before being below
  between both but by can could did do does doing down during each else few for from further had has
  have having he her here hers him his how i if in into is it its itself just let lets like me more
  most my no nor not now of off on once only or other our ours out over own please same shall she
  should so some such than that the their theirs them then there these they this those through to
  too under until up us very was we were what when where which while who whom why will with would you
  your yours yourself want wants need needs should any anything something thing things kind way
  first next last one ones still already new also else ok okay e g eg ie etc say said tell type
  just yes no say want`
    .split(/\s+/)
    .filter(Boolean),
);

/** The words that carry a text's meaning: lower case, no punctuation or small words, rough stems. */
export function meaningWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || STOP.has(raw)) continue;
    out.add(stem(raw));
  }
  return out;
}

/** A rough stem: "colors" → "color", "libraries" → "librari", "playing" → "play". */
function stem(w: string): string {
  let s = w;
  if (s.length > 5 && s.endsWith("ing")) s = s.slice(0, -3);
  else if (s.length > 4 && s.endsWith("ies")) s = `${s.slice(0, -3)}i`;
  else if (s.length > 4 && s.endsWith("es") && !s.endsWith("ses")) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith("s") && !s.endsWith("ss")) s = s.slice(0, -1);
  else if (s.length > 4 && s.endsWith("ed")) s = s.slice(0, -2);
  if (s.endsWith("y") && s.length > 3) s = `${s.slice(0, -1)}i`;
  return s;
}

/**
 * How alike two texts are, 0–1: the meaning words they share, against
 * both their sizes (a short question inside a long one isn't the same
 * question), and never much from one or two words shared by chance.
 */
export function likeness(a: string, b: string): number {
  const x = meaningWords(a);
  const y = meaningWords(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / Math.sqrt(Math.max(x.size, 3) * Math.max(y.size, 3));
}

/** Two texts that plainly say the same thing (the same question, the same task). */
export function sameMeaning(a: string, b: string, threshold = 0.6): boolean {
  const na = a.trim().toLowerCase().replace(/\s+/g, " ");
  const nb = b.trim().toLowerCase().replace(/\s+/g, " ");
  if (na && na === nb) return true;
  return likeness(a, b) >= threshold;
}

/** A question's id that says what it is about ("visual_direction"), not just its place ("q2"). */
const telling = (id: string) => id.length > 3 && !/^(q|question|o|opt|option)[-_]?\d+$/i.test(id);

/**
 * The questions of a new round that were not asked before (Skills → The
 * interview): one asked already, in the same or other words, or with the
 * same telling id, is dropped, as is one repeated within the round; at
 * most `max` are kept.
 */
export function freshQuestions<Q extends { id: string; prompt: string }>(
  questions: Q[],
  asked: { id: string; prompt: string }[],
  max = 5,
): { fresh: Q[]; dropped: Q[] } {
  const fresh: Q[] = [];
  const dropped: Q[] = [];
  const askedIds = new Set(asked.map((q) => q.id).filter(telling));
  for (const q of questions) {
    const again =
      (telling(q.id) && askedIds.has(q.id)) ||
      asked.some((p) => sameMeaning(p.prompt, q.prompt)) ||
      fresh.some((p) => sameMeaning(p.prompt, q.prompt));
    if (again || fresh.length >= max) dropped.push(q);
    else fresh.push(q);
  }
  return { fresh, dropped };
}

const STRONG_END =
  /\b(interview(?:'s| is)? (?:is )?(?:over|done|finished)|(?:end|stop|finish) (?:the |this )?interview|stop asking|no more questions|enough (?:questions|asking)|enough[,.!]* (?:just )?(?:start|go|begin|plan|build)|start (?:now|working|the work|building|planning|coding)|just (?:start|build it|do it|go)|go ahead and (?:start|build|plan)|let'?s (?:start|begin|go)|you have (?:enough|everything)|i(?:'ve| have) (?:already )?answered (?:all|everything|enough))\b/i;
const WEAK_END =
  /^(?:ok(?:ay)?[,.!]?\s*)?(?:enough|that'?s (?:all|it|enough)|start|begin|go|go ahead|proceed|done|nothing (?:more|else))[.!]*$/i;

/**
 * My words end the interview (Skills → The interview): "enough, start",
 * "start now", "that's all", "the interview is over". A long answer that
 * merely contains "start" ("they start playing at once") doesn't.
 */
export function endsInterview(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (STRONG_END.test(t)) return true;
  return WEAK_END.test(t.replace(/\s+/g, " "));
}

const CORRECTION_START =
  /^(?:no\b|nope\b|nah\b|wait\b|stop\b|hold on\b|hang on\b|actually\b|instead\b|rather\b|not (?:that|this|like that|so)\b|don'?t\b|do not\b|never\b|wrong\b|that'?s (?:wrong|not (?:it|right|what))|this is (?:wrong|not)|you'?re wrong|you got it wrong|scratch that|forget (?:that|it|about)|cancel that|undo that|redo\b|rethink\b|change of plan|correction\b)/i;
const CORRECTION_ANYWHERE =
  /\b(?:that'?s (?:wrong|not (?:it|right|what i (?:want|meant|asked)))|is wrong|you misunderstood|misread|i (?:meant|said)\b|not what i (?:want|meant|asked)|use [\w.+#-]+(?: [\w.+#-]+)? instead|instead of\b|rather than\b|don'?t use\b|do not use\b|stop (?:planning|thinking|that)|start over|think again|plan again|redo (?:it|that|the plan))/i;

/**
 * A message that corrects what The Eye is thinking right now ("no, use
 * Postgres", "that's wrong", "actually, one page only") rather than adding
 * to it (The-Eye → Thinking out loud, M13.25): sent while it thinks, it
 * stops the thinking and has it think again with my words. Anything else
 * ("also add dark mode", "the API key is in .env") is added as context.
 */
export function correctsThinking(text: string): boolean {
  const t = text.trim().replace(/\s+/g, " ");
  if (!t) return false;
  return CORRECTION_START.test(t) || CORRECTION_ANYWHERE.test(t);
}
