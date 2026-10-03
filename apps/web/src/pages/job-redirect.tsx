import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { Empty, Loading } from "@/components/common";
import { Button } from "@/components/ui/button";
import { api, message } from "@/lib/api";
import { t } from "@/lib/i18n";
import { jobHref, oldJobTab, projectHref } from "@/lib/links";

/**
 * There is no job page (ADR-034): `/jobs/<id>` and `/jobs/<id>/<tab>`, from
 * a notification, an old link or the inbox, open the job's project at Work
 * with that job open (its Eye tab is the project's), a draft on New work.
 */
export function JobRedirect({ id, tab }: { id: string; tab?: string }) {
  const [, go] = useLocation();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.jobs
      .get({ id })
      .then((j) => {
        if (cancelled) return;
        const to = oldJobTab(tab);
        const href =
          j.state === "draft"
            ? jobHref(j)
            : "project" in to
              ? projectHref(j.projectId, to.project)
              : jobHref(j, to.sub);
        // The entry keeps what it carried (a task drawer, where I came from).
        go(href, { replace: true, state: history.state });
      })
      .catch((e) => !cancelled && setError(message(e)));
    return () => {
      cancelled = true;
    };
  }, [id, tab, go]);
  if (error)
    return (
      <div className="mx-auto max-w-xl pt-8">
        <Empty
          title={t("That job isn't here")}
          action={
            <Button asChild>
              <Link href="/projects">{t("Open Projects")}</Link>
            </Button>
          }
        >
          {error}
        </Empty>
      </div>
    );
  return <Loading rows={4} />;
}
