import { remote } from "./remote";

// This device's unlocked session (ADR-029). Session storage on this
// computer, so closing the tab or the browser locks; in memory away from
// home, where the UI's frame keeps nothing.

const KEY = "oraknid.unlock";
let memory: string | null = null;
const listeners = new Set<() => void>();

export const unlock = {
  get(): string | null {
    if (remote()) return memory;
    try {
      return sessionStorage.getItem(KEY);
    } catch {
      return memory;
    }
  },
  set(session: string | null) {
    memory = session;
    if (remote()) return;
    try {
      if (session === null) sessionStorage.removeItem(KEY);
      else sessionStorage.setItem(KEY, session);
    } catch {}
  },
  /** The daemon said "locked" (423), or the idle timer ran out. */
  locked() {
    unlock.set(null);
    for (const l of listeners) l();
  },
  onLocked(f: () => void): () => void {
    listeners.add(f);
    return () => {
      listeners.delete(f);
    };
  },
};
