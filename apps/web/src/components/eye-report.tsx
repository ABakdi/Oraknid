import type { EyeMessage, EyeReport } from "@oraknid/contracts";
import {
  Ban,
  CircleAlert,
  CircleCheck,
  CircleSlash,
  ExternalLink,
  FolderSync,
  Hourglass,
  PartyPopper,
  ScanEye,
  ShieldX,
} from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";
import { JobCiLine } from "@/components/ci-badge";
import { Markdown } from "@/components/common";
import { api } from "@/lib/api";
import { ago } from "@/lib/format";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** The report a message of The Eye carries, when it spoke up on its own (ADR-045). */
export const reportOf = (m: EyeMessage): EyeReport | null => m.action?.report ?? null;

const LOOK: Record<
  Exclude<EyeReport["kind"], "task-done" | "job-done">,
  { icon: typeof Ban; tone: string; label: string }
> = {
  "task-left-out": { icon: CircleSlash, tone: "border-l-muted-foreground", label: "Left out" },
  blocked: { icon: CircleAlert, tone: "border-l-warning", label: "Blocked" },
  waiting: { icon: Hourglass, tone: "border-l-eye", label: "Waiting for you" },
  denied: { icon: ShieldX, tone: "border-l-muted-foreground", label: "Denied" },
  cancelled: { icon: Ban, tone: "border-l-muted-foreground", label: "Stopped" },
  "folder-restored": { icon: FolderSync, tone: "border-l-warning", label: "Folder put back" },
  "visual-check": { icon: ScanEye, tone: "border-l-eye", label: "Visual check" },
};

/**
 * What The Eye says on its own in the project's conversation (ADR-045): a
 * task done as one compact line, the job done as a card with where its work
 * is and what's left to me, anything else as a short note marked by kind.
 */
export function EyeReportView({
  message,
  report,
  resultHref,
}: {
  message: EyeMessage;
  report: EyeReport;
  /** The job's page, where its result is. */
  resultHref: string;
}) {
  if (report.kind === "task-done")
    return (
      <div
        data-testid="report-task-done"
        className="flex min-w-0 items-start gap-1.5 px-1 text-xs text-muted-foreground"
      >
        <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />
        <Markdown text={message.text} className="min-w-0 flex-1 text-xs leading-snug" />
        {report.facts[0] ? (
          <span className="hidden shrink-0 font-mono text-[10px] sm:inline">
            {report.facts[0].value}
          </span>
        ) : null}
      </div>
    );

  if (report.kind === "job-done")
    return (
      <div
        data-testid="report-job-done"
        className="min-w-0 max-w-full rounded-lg border border-l-4 border-l-success bg-card p-3 text-sm shadow-raised md:max-w-[85%]"
      >
        <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-success">
          <PartyPopper className="size-3.5" aria-hidden />
          {t("Job done")}
          <span className="flex-1" />
          <span className="font-normal text-muted-foreground">{ago(message.createdAt)}</span>
        </div>
        <Markdown text={message.text} />
        {report.facts.length ? (
          <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
            {report.facts.map((f) => (
              <div key={`${f.label}:${f.value}`} className="contents">
                <dt className="text-muted-foreground">{t(f.label)}</dt>
                <dd className="min-w-0 font-mono [overflow-wrap:anywhere]">
                  {f.href ? (
                    <a
                      href={f.href}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
                    >
                      {f.value}
                      <ExternalLink className="size-3 shrink-0" aria-hidden />
                    </a>
                  ) : (
                    f.value
                  )}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
        {report.todo.length ? (
          <div className="mt-2">
            <div className="text-xs font-medium">{t("Left to you")}</div>
            <ul className="mt-0.5 list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
              {report.todo.map((x) => (
                <li key={x} className="[overflow-wrap:anywhere]">
                  {x}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {/* Its pull request's CI, when it put something on GitHub (ADR-058). */}
        {message.jobId ? <JobCiLine jobId={message.jobId} projectId={message.projectId} /> : null}
        <Link
          href={resultHref}
          className="mt-2 inline-block text-xs font-medium text-primary underline-offset-2 hover:underline"
        >
          {t("Open the result")}
        </Link>
      </div>
    );

  const look = LOOK[report.kind];
  const Icon = look.icon;
  return (
    <div
      data-testid={`report-${report.kind}`}
      className={cn(
        "min-w-0 max-w-[85%] rounded-lg border-l-4 bg-muted px-3 py-2 text-sm [overflow-wrap:anywhere]",
        look.tone,
      )}
    >
      <div className="mb-0.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Icon className="size-3.5" aria-hidden />
        {t(look.label)}
      </div>
      <Markdown text={message.text} />
      {report.kind === "visual-check" && message.jobId && report.facts.length ? (
        <VisualShots jobId={message.jobId} shots={report.facts} />
      ) : null}
      {report.todo.length && report.kind !== "blocked" && report.kind !== "visual-check" ? (
        <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">
          {report.todo.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      ) : null}
      <div className="mt-0.5 text-[10px] text-muted-foreground">{ago(message.createdAt)}</div>
    </div>
  );
}

/**
 * The screenshots a visual check took (ADR-064 §5), one per device and
 * page, loaded when I ask: they live in the job's folder.
 */
function VisualShots({ jobId, shots }: { jobId: string; shots: EyeReport["facts"] }) {
  const [urls, setUrls] = useState<Record<string, string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    setError(null);
    Promise.all(
      shots.map((s) =>
        api.jobs
          .visualShot({ id: jobId, path: s.value })
          .then((r) => [s.value, r.dataUrl] as const),
      ),
    ).then(
      (pairs) => setUrls(Object.fromEntries(pairs)),
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  };
  if (!urls)
    return (
      <div className="mt-1 text-xs">
        <button
          type="button"
          onClick={load}
          className="font-medium text-primary underline-offset-2 hover:underline"
        >
          {t("Show the screenshots")} ({shots.length})
        </button>
        {error ? <span className="ml-2 text-destructive">{error}</span> : null}
      </div>
    );
  return (
    <div data-testid="visual-shots" className="mt-2 flex flex-wrap gap-2">
      {shots.map((s) => (
        <figure key={s.value} className="min-w-0 max-w-[45%]">
          <img
            src={urls[s.value]}
            alt={`${s.label}: ${s.value}`}
            className="max-h-64 rounded border object-contain"
          />
          <figcaption className="mt-0.5 font-mono text-[10px] text-muted-foreground">
            {s.label}
          </figcaption>
        </figure>
      ))}
    </div>
  );
}
