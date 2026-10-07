import { ShieldAlert } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * Full rights, shown on the device itself (ADR-030): this device may do away
 * from home what it may at home, and every such use is in the audit log.
 * Nothing shows on a device with standard rights.
 */
export function FullRightsBadge({
  status,
  className,
}: {
  status: { full: boolean; remote: boolean } | null | undefined;
  className?: string;
}) {
  if (!status?.full) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-testid="full-rights"
          className={cn(
            "flex items-center gap-1 rounded-full border border-warning/50 bg-warning/10 px-1.5 py-0.5 text-[10.5px] font-medium text-warning",
            className,
          )}
        >
          <ShieldAlert className="size-3.5" aria-hidden />
          <span className="hidden sm:inline">
            {status.remote ? t("Full rights, away") : t("Full rights")}
          </span>
          <span className="sr-only sm:hidden">{t("Full rights")}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">
        {status.remote
          ? t(
              "This device has full rights: away from home it may use the terminal and change servers, projects, Legs, tools and policies. Each of those uses is in the audit log.",
            )
          : t(
              "This device has full rights: away from home it may do what it can at home (the PIN, pairing and rights stay at home). Each use away from home is in the audit log.",
            )}
      </TooltipContent>
    </Tooltip>
  );
}
