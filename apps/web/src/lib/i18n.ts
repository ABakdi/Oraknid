/**
 * Every visible string goes through t() so other languages can be added
 * later (Web-UI → Look). English is the only language for now; {name}
 * placeholders are filled from `vars`.
 */
export function t(text: string, vars: Record<string, string | number> = {}): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}
