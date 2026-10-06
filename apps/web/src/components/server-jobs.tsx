import type { JobView, ServerView } from "@oraknid/contracts";
import { Empty, Loading } from "@/components/common";
import { EyeChat } from "@/components/eye-chat";
import { WorkRow } from "@/components/project-work";
import { api } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";
import { InboxItemCard } from "@/pages/inbox";

// A server's conversation and its jobs (ADR-049): its own project's, the
// same chat, Work rows and approvals as a project's, through the server.

/** The server's jobs, live: none until its first message. */
function useServerJobs(projectId: string | null) {
  return useLive<JobView[]>(
    () => (projectId ? api.jobs.list({ projectId }) : Promise.resolve([])),
    {
      topics: ["overview"],
      refreshOn: (e) => e.type.startsWith("job.") || e.type.startsWith("task."),
      deps: [projectId],
    },
  );
}

/** The Chat tab: The Eye answers about the server, or sends an agent into it. */
export function ServerChatTab({ server }: { server: ServerView }) {
  const jobs = useServerJobs(server.projectId);
  return (
    <EyeChat
      projectId={server.projectId}
      jobs={jobs.data ?? []}
      server={{ id: server.id, name: server.name }}
    />
  );
}

/** The Jobs tab: the jobs that worked on the server, running and done, and what they wait on. */
export function ServerJobsTab({ server }: { server: ServerView }) {
  const jobs = useServerJobs(server.projectId);
  const items = useLive(
    () =>
      server.projectId
        ? api.inbox.list({ projectId: server.projectId, state: "open" })
        : Promise.resolve([]),
    { topics: ["inbox"], deps: [server.projectId] },
  );
  if (jobs.loading) return <Loading />;
  const list = [...(jobs.data ?? [])].reverse();
  if (!list.length)
    return (
      <Empty title={t("No jobs on this server yet")}>
        {t(
          "Ask for work in the Chat tab: The Eye plans it, says what will change, and an agent does it over SSH, each command through the approvals.",
        )}
      </Empty>
    );
  return (
    <div className="space-y-4" data-testid="server-jobs">
      {items.data?.length ? (
        <section className="space-y-2">
          <h3 className="text-sm font-medium">{t("Waiting for you")}</h3>
          {items.data.map((i) => (
            <InboxItemCard key={i.id} item={i} />
          ))}
        </section>
      ) : null}
      <section className="space-y-2">
        <h3 className="text-sm font-medium">{t("Jobs on {name}", { name: server.name })}</h3>
        <ol className="divide-y rounded-lg border">
          {list.map((j) => (
            <WorkRow key={j.id} job={j} />
          ))}
        </ol>
      </section>
    </div>
  );
}
