import type { EventBus } from "../events/bus.ts";
import type { InboxStore } from "../inbox/store.ts";

/** Waits for my answer to an inbox item; a pause or cancel stops the wait (BR-7). */
export function waitForAnswer(
  inbox: InboxStore,
  bus: EventBus,
  itemId: string,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const settled = () => {
      const item = inbox.get(itemId);
      if (item?.state === "answered") return item.answer ?? "";
      return null;
    };
    const now = settled();
    if (now !== null) return resolve(now);
    const off = bus.subscribe((e) => {
      if (e.type !== "inbox.answered" || (e.payload as { id: string }).id !== itemId) return;
      off();
      signal.removeEventListener("abort", onAbort);
      resolve((e.payload as { answer: string }).answer);
    });
    const onAbort = () => {
      off();
      reject(signal.reason);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}
