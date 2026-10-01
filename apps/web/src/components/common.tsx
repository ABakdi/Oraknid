import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { message } from "@/lib/api";
import { t } from "@/lib/i18n";
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

export function PageHeader({
  title,
  sub,
  actions,
}: {
  title: string;
  sub?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="truncate text-xl font-semibold tracking-tight">{title}</h1>
        {sub ? <div className="text-sm text-muted-foreground">{sub}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
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
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-8 text-center">
      <div className="font-medium">{title}</div>
      {children ? <div className="max-w-md text-sm text-muted-foreground">{children}</div> : null}
      {action}
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

/** Minimal markdown for Silk, skills and inbox details: headings, lists, code, bold, inline code, links. */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = keyed(text.split(/\n```[a-z]*\n?/), "b");
  return (
    <div className={cn("space-y-2 text-sm leading-relaxed [overflow-wrap:anywhere]", className)}>
      {blocks.map((b, i) =>
        i % 2 === 1 ? (
          <pre key={b.key} className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs">
            {b.value.replace(/```$/, "")}
          </pre>
        ) : (
          <div key={b.key} className="space-y-1.5">
            {keyed(b.value.split("\n"), `${b.key}l`).map((l) =>
              l.value.trim() ? <Line key={l.key} line={l.value} /> : null,
            )}
          </div>
        ),
      )}
    </div>
  );
}

function Line({ line }: { line: string }) {
  const h = line.match(/^(#{1,4})\s+(.*)/);
  if (h) {
    return (
      <div className={cn("font-semibold", (h[1] as string).length <= 2 ? "text-base" : "text-sm")}>
        {inline(h[2] as string)}
      </div>
    );
  }
  const li = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)/);
  if (li) {
    return (
      <div className="flex gap-2" style={{ paddingLeft: `${(li[1] as string).length * 6}px` }}>
        <span className="text-muted-foreground">{/\d/.test(li[2] as string) ? li[2] : "•"}</span>
        <span>{inline(li[3] as string)}</span>
      </div>
    );
  }
  if (line.startsWith(">"))
    return (
      <div className="border-l-2 pl-2 text-muted-foreground">
        {inline(line.replace(/^>\s?/, ""))}
      </div>
    );
  return <p>{inline(line)}</p>;
}

function inline(s: string): ReactNode[] {
  return keyed(s.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g), "i").map(
    ({ value: p, key }) => {
      if (p.startsWith("`") && p.endsWith("`")) {
        return (
          <code key={key} className="rounded bg-muted px-1 font-mono text-[0.85em]">
            {p.slice(1, -1)}
          </code>
        );
      }
      if (p.startsWith("**")) return <strong key={key}>{p.slice(2, -2)}</strong>;
      const link = p.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (link) {
        return (
          <a
            key={key}
            href={link[2]}
            className="text-primary underline underline-offset-2"
            target="_blank"
            rel="noreferrer"
          >
            {link[1]}
          </a>
        );
      }
      return p;
    },
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
