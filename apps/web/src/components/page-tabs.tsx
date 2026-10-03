import { type ReactNode, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { typing } from "@/components/shell";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export interface PageTab {
  id: string;
  label: string;
  /** A count or a word next to the label. */
  badge?: ReactNode;
  /** The tab fills the height it is given and scrolls inside itself (a conversation, a terminal). */
  fill?: boolean;
  content: () => ReactNode;
}

/**
 * A page in tabs (Web-UI → Layout): the tab is in the address
 * (`<base>/<tab>`), `1`…`9` switch tabs, and the page itself never
 * scrolls: the header and the tabs stay, each tab scrolls inside, so
 * changing tabs never jumps. A tab, once opened, stays mounted and keeps
 * its scroll and state.
 */
export function PageTabs({
  base,
  tab,
  tabs,
  header,
  className,
  keys = true,
}: {
  base: string;
  tab: string | undefined;
  tabs: PageTab[];
  header?: ReactNode;
  className?: string;
  /** `1`…`9` switch these tabs; off for tabs inside another page's tab. */
  keys?: boolean;
}) {
  const [, go] = useLocation();
  const current = tabs.find((x) => x.id === tab) ?? tabs[0];
  const [seen, setSeen] = useState<Set<string>>(() => new Set(current ? [current.id] : []));
  const list = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the current tab matters
  useEffect(() => {
    if (current && !seen.has(current.id)) setSeen(new Set([...seen, current.id]));
    // On a phone the tab I am on is always in sight, even far along the row.
    list.current
      ?.querySelector<HTMLElement>("[aria-selected=true]")
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [current?.id]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the tabs' ids are what matter
  useEffect(() => {
    if (!keys) return;
    const on = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e)) return;
      const n = Number(e.key);
      const to = n >= 1 && n <= 9 ? tabs[n - 1] : undefined;
      if (to) go(`${base}/${to.id}`, { replace: true, state: history.state });
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [base, keys, tabs.map((x) => x.id).join()]);

  return (
    <div
      className={cn(
        // The page's whole height under the app's header (and above the phone's tab bar).
        "-mb-24 flex h-[calc(100dvh-7.5rem)] min-h-0 flex-col gap-3 md:-mb-8 md:h-[calc(100dvh-4.5rem)]",
        className,
      )}
    >
      {header}
      <div
        ref={list}
        role="tablist"
        className="isolate flex shrink-0 gap-0.5 overflow-x-auto border-b [scrollbar-width:none]"
      >
        {tabs.map((x, i) => (
          <button
            key={x.id}
            type="button"
            role="tab"
            aria-selected={x.id === current?.id}
            title={i < 9 ? `${x.label} (${i + 1})` : x.label}
            // The entry keeps what it was opened with (where I came from), only the tab changes.
            onClick={() => go(`${base}/${x.id}`, { replace: true, state: history.state })}
            className={cn(
              // A violet rule under the tab I'm on; a soft wash under the one I'm over.
              "relative -mb-px flex shrink-0 cursor-pointer items-center gap-1.5 border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground outline-none transition-colors duration-150 after:absolute after:inset-x-1 after:top-1 after:bottom-1 after:-z-10 after:rounded-md after:bg-accent after:opacity-0 after:transition-opacity hover:text-foreground hover:after:opacity-60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset pointer-coarse:min-h-11",
              x.id === current?.id && "border-primary font-medium text-foreground",
            )}
          >
            {x.label}
            {x.badge !== undefined && x.badge !== null && x.badge !== 0 ? (
              <Badge
                variant="secondary"
                className={cn(
                  "h-5 min-w-5 justify-center px-1 font-mono text-[10px]",
                  x.id === current?.id && "border-primary/30 bg-primary/15 text-primary",
                )}
              >
                {x.badge}
              </Badge>
            ) : null}
          </button>
        ))}
      </div>
      {tabs
        .filter((x) => seen.has(x.id) || x.id === current?.id)
        .map((x) => (
          <div
            key={x.id}
            role="tabpanel"
            hidden={x.id !== current?.id}
            className={cn(
              "min-h-0 flex-1",
              x.id !== current?.id && "hidden",
              x.fill ? "flex flex-col" : "overflow-y-auto pb-6",
            )}
          >
            {x.content()}
          </div>
        ))}
    </div>
  );
}
