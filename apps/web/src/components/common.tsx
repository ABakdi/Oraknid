import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
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
  interviewing: "bg-chart-2/20 text-chart-2",
  planning: "bg-chart-1/20 text-chart-1",
  running: "bg-primary/20 text-primary",
  verifying: "bg-chart-2/20 text-chart-2",
  waiting: "bg-warning/20 text-warning",
  paused: "bg-muted text-muted-foreground",
  blocked: "bg-destructive/20 text-destructive",
  completed: "bg-success/20 text-success",
  cancelled: "bg-muted text-muted-foreground line-through",
  // tasks
  pending: "bg-muted text-muted-foreground",
  ready: "bg-secondary text-secondary-foreground",
  assigned: "bg-primary/15 text-primary",
  done: "bg-success/20 text-success",
  failed: "bg-destructive/20 text-destructive",
  skipped: "bg-muted text-muted-foreground",
  // legs
  healthy: "bg-success/20 text-success",
  degraded: "bg-warning/20 text-warning",
  "rate-limited": "bg-warning/20 text-warning",
  unavailable: "bg-destructive/20 text-destructive",
  disabled: "bg-muted text-muted-foreground",
};

export function StateBadge({ state, className }: { state: string; className?: string }) {
  return (
    <Badge
      variant="outline"
      className={cn("border-transparent font-medium capitalize", TONE[state], className)}
    >
      {state === "running" || state === "verifying" ? (
        <span className="mr-1 inline-block size-1.5 animate-pulse rounded-full bg-current" />
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
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div className="flex min-w-0 flex-1 items-start gap-1">
        {back ? <BackButton fallback={back.fallback} label={back.label} /> : null}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-semibold tracking-tight" title={title}>
            {title}
          </h1>
          {sub ? <div className="text-sm text-muted-foreground">{sub}</div> : null}
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
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-6 text-center sm:p-8">
      <div className="font-medium">{title}</div>
      {children ? <div className="max-w-md text-sm text-muted-foreground">{children}</div> : null}
      {action ? <div className="flex flex-wrap justify-center gap-2 pt-1">{action}</div> : null}
    </div>
  );
}

/** Errors in words, never only a code (BR-17). */
export function ErrorNote({ error, className }: { error: unknown; className?: string }) {
  if (!error) return null;
  return (
    <div
      role="alert"
      className={cn(
        "rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive",
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
export function Markdown({ text, className }: { text: string; className?: string }) {
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
          a: ({ node: _n, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
          // An image would be fetched by my browser as soon as I look: a way
          // out for anything an agent read (Audit 2). Shown as text instead.
          img: ({ alt, src }) => (
            <span className="text-muted-foreground">
              [{t("image")}: {alt || "—"} {typeof src === "string" ? src : ""}]
            </span>
          ),
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
    <div className="min-w-0 rounded-lg border bg-card px-3 py-2">
      <div className="truncate text-xs text-muted-foreground">{label}</div>
      <div className="truncate text-lg font-semibold tabular-nums">{value}</div>
      {hint ? <div className="truncate text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );
}
