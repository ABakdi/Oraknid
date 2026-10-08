/**
 * What one row may hold (Persistence-and-Recovery → Size caps). A reason
 * that was a tool's whole output (3 MB) or a Silk entry holding a diff stat
 * of thousands of files (1.5 MB) froze every screen that read it, and was
 * sent again at each reload. Texts past their cap are cut short where they
 * are written, with a note that says how long they were; a tool's output
 * keeps its start and its end, where the error usually is.
 */

/** The Eye's messages and mine in a conversation. */
export const EYE_MESSAGE_MAX = 20_000;
/** Each string in an event's payload (a tool's output, a command, a reason). */
export const EVENT_STRING_MAX = 32_000;
/** A Silk entry's body. */
export const SILK_BODY_MAX = 64_000;
/** An inbox item's detail. */
export const INBOX_DETAIL_MAX = 20_000;
/** A job's blocked or paused reason (as the engine has cut them since 0.4.4). */
export const REASON_MAX = 600;

/** The note a text cut short carries: how long it was. */
export const cutNote = (length: number) =>
  `(cut short; ${length.toLocaleString("en-US")} characters)`;

/** Whether `text` already is one cut short (by a cap or the upkeep): left as it is. */
export const isCutShort = (text: string) => /\(cut short; [\d,]+ characters\)/.test(text);

/**
 * `text` in at most about `max` characters: as it is when it fits, else its
 * start and its end around a note of its whole length ("head-tail", for
 * output), or its start and the note ("head").
 */
export function cutShort(
  text: string,
  max: number,
  keep: "head-tail" | "head" = "head-tail",
): string {
  if (text.length <= max) return text;
  const note = cutNote(text.length);
  const room = Math.max(0, max - note.length - 8);
  if (keep === "head") return `${text.slice(0, room).trimEnd()}… ${note}`;
  const head = Math.ceil(room * 0.6);
  const tail = room - head;
  return `${text.slice(0, head).trimEnd()}\n… ${note} …\n${tail > 0 ? text.slice(-tail).trimStart() : ""}`;
}

/** Every string in a JSON value cut to `max` (an event's payload); the same value when none is. */
export function cutStrings<T>(value: T, max: number): T {
  if (typeof value === "string") return (value.length > max ? cutShort(value, max) : value) as T;
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v) => {
      const c = cutStrings(v, max);
      if (c !== v) changed = true;
      return c;
    });
    return (changed ? out : value) as T;
  }
  if (value && typeof value === "object") {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const c = cutStrings(v, max);
      if (c !== v) changed = true;
      out[k] = c;
    }
    return (changed ? out : value) as T;
  }
  return value;
}
