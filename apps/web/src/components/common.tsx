import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { Link } from "wouter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { message } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useBack } from "@/lib/nav";
import { cn } from "@/lib/utils";

const TONE: Record<string, string> = {
  // jobs
  draft: "bg-muted text-muted-foreground",
  interviewing: "bg-eye/15 text-eye",
  planning: "bg-chart-1/15 text-chart-1",
  running: "bg-primary/15 text-primary",
  verifying: "bg-chart-3/15 text-chart-3",
  waiting: "bg-warning/15 text-warning",
  paused: "bg-muted text-muted-foreground",
  blocked: "bg-destructive/15 text-destructive",
  completed: "bg-success/15 text-success",
  cancelled: "bg-muted text-muted-foreground line-through",
  // tasks
  pending: "bg-muted text-muted-foreground",
  ready: "bg-secondary text-secondary-foreground",
  assigned: "bg-primary/15 text-primary",
  done: "bg-success/15 text-success",
  failed: "bg-destructive/15 text-destructive",
  skipped: "bg-muted text-muted-foreground",
  // legs
  healthy: "bg-success/15 text-success",
  degraded: "bg-warning/15 text-warning",
  "rate-limited": "bg-warning/15 text-warning",
  unavailable: "bg-destructive/15 text-destructive",
  disabled: "bg-muted text-muted-foreground",
};

export function StateBadge({ state, className }: { state: string; className?: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "border-transparent font-medium capitalize ring-1 ring-current/20 ring-inset",
        TONE[state],
        className,
      )}
    >
      {state === "running" || state === "verifying" ? (
        <span className="mr-0.5 inline-block size-1.5 animate-pulse rounded-full bg-current" />
      ) : null}
      {t(state)}
    </Badge>
  );
}

/**
 * The way back from a page I drilled into (Web-UI → Going back): where I
 * came from when that was in Oraknid, else the page above it.
 */
export function BackButton({
  fallback,
  label = t("Back"),
  className,
}: {
  fallback: string;
  label?: string;
  className?: string;
}) {
  const back = useBack(fallback);
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn("-ml-2 shrink-0", className)}
      aria-label={label}
      title={label}
      onClick={back}
    >
      <ChevronLeft className="size-5" />
    </Button>
  );
}

export function PageHeader({
  title,
  sub,
  actions,
  back,
}: {
  title: string;
  sub?: ReactNode;
  actions?: ReactNode;
  /** A back control before the title: where it falls back to, and what it says. */
  back?: { fallback: string; label?: string };
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="flex min-w-0 flex-1 items-start gap-1">
        {back ? <BackButton fallback={back.fallback} label={back.label} /> : null}
        <div className="min-w-0 flex-1">
          <h1
            className="truncate text-[22px] leading-8 font-semibold tracking-[-0.015em]"
            title={title}
          >
            {title}
          </h1>
          {sub ? <div className="mt-0.5 text-sm text-muted-foreground">{sub}</div> : null}
        </div>
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** Every empty screen says what it is and what to do (Web-UI → Empty, loading and error states). */
export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border bg-card/60 bg-[radial-gradient(ellipse_60%_80%_at_50%_0%,color-mix(in_srgb,var(--primary)_9%,transparent),transparent)] p-6 text-center sm:p-10">
      <RestingEye />
      <div className="font-semibold tracking-tight">{title}</div>
      {children ? <div className="max-w-md text-sm text-muted-foreground">{children}</div> : null}
      {action ? <div className="flex flex-wrap justify-center gap-2 pt-1">{action}</div> : null}
    </div>
  );
}

/** The mark's eye, small: what an empty screen shows above its words. Decoration only. */
function RestingEye() {
  return (
    <span
      aria-hidden
      className="relative mb-1 grid size-10 place-items-center rounded-full border-2 border-primary/70 bg-background"
    >
      <span className="size-[26px] rounded-full bg-[radial-gradient(circle_at_40%_36%,#ffd98a,#f4a73a_50%,#c2621b)]" />
      <span className="absolute h-1.5 w-[22px] rounded-full bg-[#120f1f]" />
    </span>
  );
}

/** Errors in words, never only a code (BR-17). */
export function ErrorNote({ error, className }: { error: unknown; className?: string }) {
  if (!error) return null;
  return (
    <div
      role="alert"
      className={cn(
        "rounded-md border border-destructive/35 border-l-[3px] border-l-destructive bg-destructive/8 px-3 py-2 text-sm text-destructive",
        className,
      )}
    >
      {message(error)}
    </div>
  );
}

export function Loading({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-busy>
      {keyed(Array.from({ length: rows }), "s").map((r) => (
        <Skeleton key={r.key} className="h-10 w-full" />
      ))}
    </div>
  );
}

/** Gives static pieces of text stable keys (their position never changes for a given text). */
const keyed = <T,>(xs: T[], prefix: string) =>
  xs.map((value, n) => ({ value, key: `${prefix}${n}` }));

/**
 * Markdown for everything a Leg, The Eye or I write (Web-UI → Markdown):
 * GitHub-flavoured (tables, task lists, strikethrough). Raw HTML is never
 * rendered, links open in a new tab, and long lines wrap or scroll inside
 * their block, never past it.
 */
export function Markdown({
  text,
  className,
  components,
}: {
  text: string;
  className?: string;
  /** Elements drawn differently (the guide's headings, with their anchors). */
  components?: Components;
}) {
  return (
    <div
      className={cn(
        "min-w-0 space-y-2 text-sm leading-relaxed [overflow-wrap:anywhere]",
        "[&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:text-sm [&_h3]:font-semibold [&_h4]:text-sm [&_h4]:font-medium",
        "[&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:space-y-1 [&_ol]:pl-5",
        "[&_blockquote]:border-l-2 [&_blockquote]:pl-2 [&_blockquote]:text-muted-foreground",
        "[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2",
        "[&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-muted [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:font-mono [&_:not(pre)>code]:text-[0.85em]",
        "[&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-2 [&_pre]:font-mono [&_pre]:text-xs",
        "[&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_table]:text-xs [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left",
        "[&_hr]:border-border",
        className,
      )}
    >
      <ReactMarkdown
        // A line break is kept: Oraknid and the Legs write line by line.
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          // A page of Oraknid's own (the helper's links to the guide) opens here, not in a new tab.
          a: ({ node: _n, href, ...props }) =>
            href && /^\/(?!\/)/.test(href) ? (
              <Link href={href} {...props} />
            ) : (
              <a href={href} {...props} target="_blank" rel="noreferrer" />
            ),
          // An image would be fetched by my browser as soon as I look: a way
          // out for anything an agent read (Audit 2). Shown as text instead.
          img: ({ alt, src }) => (
            <span className="text-muted-foreground">
              [{t("image")}: {alt || "—"} {typeof src === "string" ? src : ""}]
            </span>
          ),
          ...components,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

export function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="min-w-0 rounded-lg border bg-card px-3 py-2.5 shadow-raised">
      <div className="eyebrow truncate">{label}</div>
      <div className="mt-1 truncate font-mono text-xl leading-7 font-semibold tracking-tight tabular-nums">
        {value}
      </div>
      {hint ? <div className="truncate text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

/** A one-line title where `backticks` mark code, as Oraknid writes them. */
export function CodeSpans({ text }: { text: string }) {
  return text.split(/`([^`]+)`/).map((part, i) =>
    i % 2 ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: the parts never move
      <code key={i} className="rounded bg-muted px-1 font-mono text-[0.85em] font-normal">
        {part}
      </code>
    ) : (
      part
    ),
  );
}
