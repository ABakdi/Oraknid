import { ExternalLink } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import { remote } from "@/lib/remote";
import { reviewHref } from "@/lib/review";

/** Opens a review (ADR-064): its own tab at home, in place away from home. */
export function ReviewLink({ id, label }: { id: string; label?: string }) {
  const href = reviewHref(id);
  return remote() ? (
    <Button asChild size="xs">
      <Link href={href}>{label ?? t("Open")}</Link>
    </Button>
  ) : (
    <Button asChild size="xs">
      <a href={href} target={`review-${id}`} rel="opener">
        {label ?? t("Open")}
        <ExternalLink />
      </a>
    </Button>
  );
}
