import { ArrowRight } from "lucide-react";
import { useMemo } from "react";
import { api } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";
import { cn } from "@/lib/utils";

// A Leg's avatar (Web-UI → Job, The Web): made from its name and kind, the
// same wherever the Leg shows (Legs, Overview, a job's Agents, its Workflow).

export interface LegLook {
  name: string;
  kind: string;
}

/** Each kind of Leg has its own family of colours: a hue, the Legs of the kind spread around it. */
const KIND_HUE: Record<string, number> = {
  "claude-code": 40,
  antigravity: 255,
  opencode: 160,
  "openai-compatible": 310,
};

/** A small stable hash (FNV-1a), so a Leg keeps its colour across pages and reloads. */
function hash(s: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** Initials (two letters: the first of two words, else the first two) and a hue. */
export function legLook({ name, kind }: LegLook): { initials: string; hue: number } {
  const words = name.split(/[\s\-_.·/]+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  const letters = (w: string) => [...w].filter((c) => /[\p{L}\p{N}]/u.test(c));
  const initials =
    words.length >= 2
      ? `${letters(words[0] ?? "")[0] ?? ""}${letters(words[1] ?? "")[0] ?? ""}`
      : letters(words[0] ?? "?")
          .slice(0, 2)
          .join("");
  const base = KIND_HUE[kind] ?? hash(kind) % 360;
  const hue = (base + (hash(name) % 80) - 40 + 360) % 360;
  return { initials: (initials || "?").toUpperCase(), hue };
}

const SIZES = { xs: "size-4 text-[8px]", sm: "size-5 text-[9px]", md: "size-6 text-[10px]" };

/** A Leg's round avatar: its initials on its colour. */
export function LegAvatar({
  leg,
  size = "sm",
  className,
}: {
  leg: LegLook;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const { initials, hue } = legLook(leg);
  return (
    <span
      role="img"
      aria-label={leg.name}
      title={`${leg.name} (${leg.kind})`}
      data-hue={hue}
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold leading-none text-white ring-1 ring-background",
        SIZES[size],
        className,
      )}
      style={{ backgroundColor: `oklch(0.56 0.15 ${hue})` }}
    >
      {initials}
    </span>
  );
}

/**
 * A task handed from one Leg to another: a dot travels from the first's
 * avatar to the second's (still, with an arrow, under reduced motion).
 */
export function LegHandoff({ from, to }: { from: LegLook; to: LegLook }) {
  return (
    <span
      data-testid="leg-handoff"
      className="inline-flex shrink-0 items-center gap-0.5"
      title={t("Handed from {from} to {to}", { from: from.name, to: to.name })}
    >
      <LegAvatar leg={from} size="xs" className="opacity-60" />
      <span className="relative inline-flex h-4 w-5 items-center justify-center">
        <ArrowRight className="size-3 text-muted-foreground motion-safe:opacity-30" />
        <span
          aria-hidden
          data-handoff-dot
          className="absolute left-0 top-1/2 hidden size-1.5 -translate-y-1/2 rounded-full bg-primary motion-safe:block motion-safe:animate-[leg-handoff_1.1s_ease-in-out_infinite]"
        />
      </span>
      <LegAvatar leg={to} size="xs" />
    </span>
  );
}

/** Every Leg's name and kind by id, for the avatars. */
export function useLegLooks() {
  const legs = useLive(() => api.legs.list(), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("leg."),
  });
  return useMemo(
    () =>
      new Map<string, LegLook>(
        (legs.data ?? []).map((l) => [l.id, { name: l.name, kind: l.kind }]),
      ),
    [legs.data],
  );
}
