import { toast } from "sonner";
import { message } from "@/lib/api";

// Where things live (ADR-034): the project is the place, a job is opened
// in its project's Work tab, a draft on New work.

/** A project's tab. */
export const projectHref = (projectId: string, tab?: string) =>
  `/projects/${projectId}${tab ? `/${tab}` : ""}`;

/** A job, in its project's Work tab; a draft where it is written. */
export function jobHref(job: { id: string; projectId: string; state?: string }, sub?: string) {
  if (job.state === "draft") return `/new/${job.id}`;
  return `/projects/${job.projectId}/work/${job.id}${sub ? `/${sub}` : ""}`;
}

/**
 * A job's address when only its id is known: `/jobs/<id>` opens it in its
 * project (the redirect looks the project up), so a link never breaks.
 */
export const jobIdHref = (jobId: string, projects?: Map<string, string>) => {
  const projectId = projects?.get(jobId);
  return projectId ? jobHref({ id: jobId, projectId }) : `/jobs/${jobId}`;
};

/** The old job page's tabs, as the Work tab's parts: `null` is the project's own tab. */
export function oldJobTab(tab: string | undefined): { project: string } | { sub: string } {
  if (tab === "eye") return { project: "eye" };
  if (!tab || tab === "web") return { sub: "tasks" };
  return { sub: tab };
}

/** Runs a control and says how it went, in words (BR-17). */
export async function act(fn: () => Promise<unknown>, done?: string) {
  try {
    await fn();
    if (done) toast.success(done);
  } catch (e) {
    toast.error(message(e));
  }
}
