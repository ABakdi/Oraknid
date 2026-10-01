/** Per-device preferences; never assumed to work (private windows, cleared storage). */
export const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(`oraknid.${key}`);
    } catch {
      return null;
    }
  },
  set(key: string, value: string | null) {
    try {
      if (value === null) localStorage.removeItem(`oraknid.${key}`);
      else localStorage.setItem(`oraknid.${key}`, value);
    } catch {}
  },
};
