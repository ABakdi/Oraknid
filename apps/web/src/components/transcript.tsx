import { ListTree } from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// A conversation read like a terminal's transcript (M13.25, Web-UI → The Eye's
// conversation): one column, my prompts marked, replies, thinking and work
// inline; a slim rail of my prompts beside it to jump back to one.

/** One of my prompts, for the rail. */
export interface PromptMark {
  id: string;
  title: string;
}

/** A prompt's title in the rail: its first words. */
export function promptTitle(text: string, words = 6): string {
  const flat = text
    .replace(/[#*_`>[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!flat) return t("(empty)");
  let title = flat.split(" ").slice(0, words).join(" ");
  if (title.length > 48) title = title.slice(0, 47).trimEnd();
  return title.length < flat.length ? `${title}…` : title;
}

/** The element id of a prompt in the transcript. */
export const promptAnchor = (id: string) => `prompt-${id}`;

/** Scrolls the transcript to one of my prompts. */
export function jumpTo(id: string) {
  document
    .getElementById(promptAnchor(id))
    ?.scrollIntoView?.({ block: "start", behavior: "smooth" });
}

/**
 * The prompt being read: the topmost of mine in the upper part of the
 * transcript, else the last one seen there (reading a long reply keeps its
 * prompt lit).
 */
export function useActivePrompt(
  box: RefObject<HTMLElement | null>,
  ids: string[],
): [string | null, (id: string) => void] {
  const [active, setActive] = useState<string | null>(null);
  const key = ids.join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: the prompts' ids identify what to observe
  useEffect(() => {
    const root = box.current;
    if (!root || typeof IntersectionObserver === "undefined" || !ids.length) return;
    const seen = new Map<string, boolean>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries)
          seen.set((e.target as HTMLElement).dataset.promptId ?? "", e.isIntersecting);
        const top = ids.find((id) => seen.get(id));
        if (top) setActive(top);
      },
      // The upper part of the transcript is where a prompt is "being read".
      { root, rootMargin: "0px 0px -55% 0px", threshold: 0 },
    );
    for (const id of ids) {
      const el = document.getElementById(promptAnchor(id));
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [key]);
  // Before any scrolling, the newest prompt is the one in view.
  const shown = active && ids.includes(active) ? active : (ids.at(-1) ?? null);
  return [shown, setActive];
}

/** My prompt in the transcript: a "›" mark, a subtle rule, slightly emphasised. */
export function PromptLine({
  id,
  active,
  children,
  meta,
}: {
  id: string;
  active?: boolean;
  children: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <div
      id={promptAnchor(id)}
      data-prompt-id={id}
      data-testid="prompt"
      className={cn(
        "flex min-w-0 scroll-mt-2 gap-2 rounded-r-md border-l-2 bg-muted/50 py-1.5 pr-2 pl-2 text-sm font-medium",
        active ? "border-l-primary" : "border-l-muted-foreground/40",
      )}
    >
      <span aria-hidden className="select-none font-mono text-primary">
        ›
      </span>
      <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        {children}
        {meta ? (
          <div className="mt-0.5 text-[10px] font-normal text-muted-foreground">{meta}</div>
        ) : null}
      </div>
    </div>
  );
}

/** The rail beside the transcript: a dot and a short title per prompt of mine (desktop). */
export function PromptRail({
  prompts,
  active,
  onJump,
}: {
  prompts: PromptMark[];
  active: string | null;
  onJump: (id: string) => void;
}) {
  if (!prompts.length) return null;
  return (
    <nav
      aria-label={t("Your prompts")}
      data-testid="prompt-rail"
      className="hidden w-44 shrink-0 overflow-y-auto border-l py-1 pl-2 md:block"
    >
      <PromptList prompts={prompts} active={active} onJump={onJump} />
    </nav>
  );
}

function PromptList({
  prompts,
  active,
  onJump,
}: {
  prompts: PromptMark[];
  active: string | null;
  onJump: (id: string) => void;
}) {
  return (
    <ol className="relative space-y-0.5 before:absolute before:top-2 before:bottom-2 before:left-[5px] before:w-px before:bg-border">
      {prompts.map((p) => (
        <li key={p.id}>
          <button
            type="button"
            onClick={() => onJump(p.id)}
            aria-current={p.id === active ? "true" : undefined}
            title={p.title}
            className={cn(
              "relative flex w-full min-w-0 items-center gap-2 rounded px-0 py-1 text-left text-xs",
              p.id === active
                ? "font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "z-10 size-[11px] shrink-0 rounded-full border-2 bg-background",
                p.id === active ? "border-primary bg-primary" : "border-muted-foreground/50",
              )}
            />
            <span className="min-w-0 truncate">{p.title}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}

/** On a phone the rail is a small button opening the same list. */
export function PromptJump({
  prompts,
  active,
  onJump,
}: {
  prompts: PromptMark[];
  active: string | null;
  onJump: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (prompts.length < 2) return null;
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1 px-2 text-xs md:hidden"
          aria-label={t("Jump to a prompt")}
        >
          <ListTree className="size-3.5" />
          {t("{n} prompts", { n: prompts.length })}
        </Button>
      </SheetTrigger>
      <SheetContent side="bottom" className="max-h-[70vh]">
        <SheetHeader>
          <SheetTitle>{t("Jump to a prompt")}</SheetTitle>
          <SheetDescription>{t("What you asked here, oldest first.")}</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 overflow-y-auto px-4 pb-4">
          <PromptList
            prompts={prompts}
            active={active}
            onJump={(id) => {
              setOpen(false);
              // After the sheet has closed, so the transcript can scroll.
              setTimeout(() => onJump(id), 50);
            }}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
