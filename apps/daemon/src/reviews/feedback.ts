// A message of mine in a project's conversation while one review is open
// there (ADR-064 §3): "the knobs are too small on the phone" is a note on
// it, not new work. The trivial path only: words about how it looks or
// feels, and no order to the job.

const ORDER =
  /^\s*(stop|cancel|pause|resume|skip|approve|merge|deploy|release|start|run|undo|revert)\b/i;

const LOOKS =
  /\b(too\s+(big|small|large|tiny|dark|light|bright|busy|cramped|wide|narrow|long|short|slow|close|far)|bigger|smaller|larger|wider|narrower|darker|lighter|bolder|colou?rs?|fonts?|buttons?|knobs?|sliders?|layout|spacing|padding|margins?|align(ed|ment)?|icons?|logo|header|footer|menu|sidebar|screen|phone|mobile|tablet|laptop|desktop|landscape|portrait|looks?|feels?|i\s+(like|love|hate|don'?t\s+like|dislike)|keep\s+the|change\s+the|move\s+the|make\s+(it|the|them)|should\s+(be|look|feel)|instead\s+of|contrast|readable|ugly|nice|clean|cluttered|design)\b/i;

/** Whether a message reads as feedback on what is being reviewed. */
export function readsAsFeedback(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 4000 || ORDER.test(t)) return false;
  return LOOKS.test(t);
}
