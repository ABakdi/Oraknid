import { t } from "./i18n";

export const tokens = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 10_000
      ? `${Math.round(n / 1000)}k`
      : n >= 1000
        ? `${(n / 1000).toFixed(1)}k`
        : String(n);

export const bytes = (n: number) =>
  n >= 1 << 30
    ? `${(n / (1 << 30)).toFixed(1)} GiB`
    : n >= 1 << 20
      ? `${Math.round(n / (1 << 20))} MiB`
      : n >= 1024
        ? `${Math.round(n / 1024)} KiB`
        : `${n} B`;

export function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return t("just now");
  if (s < 3600) return t("{n} min ago", { n: Math.round(s / 60) });
  if (s < 86400) return t("{n} h ago", { n: Math.round(s / 3600) });
  return t("{n} d ago", { n: Math.round(s / 86400) });
}

export function until(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((at - now) / 1000));
  if (s < 3600) return t("in {n} min", { n: Math.max(1, Math.round(s / 60)) });
  if (s < 86400)
    return t("in {h} h {m} min", { h: Math.floor(s / 3600), m: Math.round((s % 3600) / 60) });
  return new Date(at).toLocaleString();
}

export const clock = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/**
 * A long text said briefly: its start, and how much more there is. A reason or a
 * message is never shown whole when a tool's output became it (3 MB, 2026-10-08).
 */
export function clip(text: string, max = 400): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}… (${(text.length - max).toLocaleString()} more characters)`;
}
