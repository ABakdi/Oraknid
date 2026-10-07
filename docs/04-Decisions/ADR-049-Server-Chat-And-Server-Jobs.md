# ADR-049 — Server chat and server jobs

**Status:** Accepted · 2026-10-04

## Context
A job reached a server only through a project of mine that had it
ticked ([[Servers]] → Servers in projects). Most of what I want done on
a server belongs to no repo: "install fail2ban", "why does nginx return
502 for x.com", "rotate the logs of app y", "upgrade node on this box".
I want to ask for it on the server's page, have The Eye send an agent
into the server under the same approvals as any job, and find the
server's state document up to date afterwards.

Two models were weighed: jobs gaining an optional `serverId` with no
workspace, or each server getting a project of its own. A job without a
workspace would need its own path through the workspace, the worktree,
the shadow repo's checkpoints, Silk's mirror, the Workflow and the
inbox's links, each a place to get wrong.

## Decision
- **Each server has a project of its own** (`projects.server_id`), made
  with its first message: named after the server, its folder a scratch
  folder of Oraknid's (`<data>/server-jobs/<server id>`, not a git repo:
  a shadow repo keeps its checkpoints), the server its one server, the
  built-in **server-work** skill its method (no interview). It is hidden
  from the Projects list (`projects.list` leaves it out unless asked
  with `servers: true`), from a server's "projects that use it" and from
  the helper's view; its jobs, Silk, Workflow, inbox and notifications
  are those of any job. A server removed archives it, its jobs' history
  kept.
- **The Chat tab** on a server's page is that project's conversation
  with The Eye, through the server (`servers.conversation` / `talk` /
  `answer`). With a job going on the server, my message goes to it as in
  a project. With none, one quick call (`serverTalk`) decides: a
  **question** the state document and the readings answer is answered
  there, without a job (the message has no job: `eye_messages.job_id`
  may be null); **work**, or a question that needs looking on the server,
  becomes a **server job** in its project, its goal my request made
  precise, the server already chosen as its server.
- **A server job's sessions** get the server's state document, its role
  and production, and the way in of ADR-026: the alias in the job's own
  home on the Leg, named with `ssh -F <that config>` (ssh reads its
  config from the account's home, never `$HOME`, so the alias alone
  never resolved in a sandbox). They are told the job's place is the
  server, not a repo; the Git and GitHub parts of the context are left
  out. The plan is told the same, with the state document; a task that
  only looks is `research` and changes nothing.
- **Checks on the server**: a check written `ssh <alias> <command>`, of
  a task or of the job, is run by Oraknid itself over its own connection
  (the pinned host key), not from the sandbox. On production a check
  that could change something is refused, never run.
- **Saying what will change**: a server job's plan that changes the
  server waits for my approval ("Approve what will change on vps"),
  unless the job is at Full autonomy on a server that isn't production;
  a plan of research only starts at once.
- **Commands on a server** go through the approvals as before, judged as
  what runs there: `ssh <alias> '…'` with nothing after it on the line
  is judged by this computer's policy without its `sudo` (root on the
  server is the server's business, not refused as root here), never-
  allowed commands stay refused. **Production** (my mark on the server
  itself, `servers.production`, new; or its role in a project, ADR-042)
  asks before anything that doesn't only read, at any autonomy, in every
  project and in its own chat; `scp` and `rsync` to it always ask.
- **Afterwards**: the job's end runs a new discovery as before; the new
  version of the state document records the job (`server_states.job_id`)
  and, for a server job, ends with "Changes by job “…”" listing the tasks
  that changed something and their checks, whatever The Eye wrote. What
  was read of the server is forgotten so its tabs read it again. The
  Eye's report of the job (ADR-045) shows the state document's version,
  its diff from the one before, and, when its data changed, the backup
  plans to look at. `servers.history` lists the versions with the job
  that wrote each.
- **Away from home**: `servers.talk`, `servers.answer` and
  `servers.setProduction` are home only for a standard device, like
  every server action; `projects.talk` and `projects.answer` refuse a
  server's own project the same way.

## Consequences
- Server jobs need nothing new from the engine, the inbox or the web's
  job pages: a job opens in its server project's Work tab, whose header
  links back to the server.
- The scratch folder is real: notes and findings a job writes stay
  there, checkpointed, and are its Silk's mirror.
- A job of a project that has the server still updates its state
  document, without a "Changes by job" section (its tasks may be code).
- Approving a production change is asked each time: "Approve all like
  this" writes the job's rule, and production still asks.
- Migration 0037: `projects.server_id`, `servers.production`,
  `server_states.job_id`, and `eye_messages.job_id` nullable (the table
  rebuilt).

## As built (2026-10-04)
- `servers/server-jobs.ts` (the server's project, its chat, the plan
  digest, the approval, the state diff), `servers/remote.ts` (an ssh to
  an alias read, what only reads, the verdict), `servers/checks.ts`,
  `skills/server-work.md`; `serverTalk` on the quick model.
- Web: the server page's **Chat** (second tab) and **Jobs** tabs, the
  Production switch on Overview, a production badge, the state
  document's versions with the job that wrote each.

## Note (2026-10-07): requests that belong to a server, from anywhere
In the piano project's chat I asked to "stop and remove misahaty related
container and data"; The Eye asked what misahaty was, though it is in
spinet-staging's state document and a job about it had been cancelled
in that server's chat. Now the names of a message a project doesn't know
are looked up across Oraknid (state documents, other projects' and
servers' jobs, Silk, conversations; no model), given to the triage, and
a request that belongs to a server is taken into **that server's chat**
(`handOver`, as if written there): its Eye reads it and starts a server
job with its plan approval as usual, and the chat I wrote in says where
the name was found and links there; several equally likely places are
asked as a question with them as options. `serverTalk` and the triage of
a server job get the server's recent jobs (how each ended, why), the
triage the state document too; "again" or "start another job" carries
the earlier job's goal and what it learned. The chat's header has
**Cancel** for the job going on the server; its approvals are withdrawn
with it. [[The-Eye]] → Resolving what it doesn't know, Cancelling from
the chat. `eye_messages.action.place` records where a request was taken
(no migration: the action is JSON).

## Note (2026-10-07): the approved plan authorises its changes; checks by alias alone
Two server jobs of mine on spinet-staging ended in "keeps going wrong"
and I cancelled them.
- **What the approved plan names is mine to allow at once.** Deleting
  `/root/misahaty` was in the plan I approved, but layer 1 blocked `rm
  -rf /root/misahaty` and the agent had to stop. Now a layer-1 block of a
  change on the job's server that only removes what the plan names (an
  `rm` of paths it names, `docker compose down -v` of the project it
  names, volumes or containers it names; `servers/remote.ts`
  `removalTargets`, `namedIn`; the plan's text is its summary and tasks,
  `jobPlan`) is one approval: "The agent wants to run `…` on <server>
  (in the plan you approved: “<the plan's line>”). Run it?" — **Allow**
  runs that exact command once. Commands the plan doesn't name stay
  blocked; production asks per change as before. ADR-053 → Note
  (2026-10-07).
- **A check names the alias alone.** A check The Eye wrote carried the
  agent's ssh setup: `n=$(HOME=<the job's home> ssh -o BatchMode=yes -F
  <the job's home>/.ssh/config oraknid-spinet-staging docker ps -q
  --filter name=harvest- | wc -l); [ "$n" -eq 2 ]`. It didn't start with
  `ssh`, so it wasn't read as a server check and ran in the check
  sandbox, where the job's home isn't (checks run without the Leg's
  home): ssh said "Can't open user config file …/jobs/<job>/ho: No such
  file or directory", the path cut by ssh's own message (`%.100s`), not
  by Oraknid. Now a check is put in its **plain form** before it runs
  (`plainServerCheck`: `HOME=…` and ssh's options taken off an ssh to an
  alias) and stored so before the work; a check that wraps its ssh in
  local shell runs **whole on the server**, its ssh taken off, when every
  ssh in it goes to the same server (`serverCheckOf`). The plan digest,
  the check repair and `skills/server-work.md` say: `ssh <alias>
  <command>`, never `HOME=`, `-F`, `-i`, `-o` or the job's paths.
- **Setup errors are broken checks**: ssh that can't open its config or
  key or resolve its host, "No such file or directory" on Oraknid's own
  paths, a refused connection (`brokenCheckHint`) are repaired before the
  work, never charged to the agent.
- **Guard checks pass before the work.** A check of what must keep true
  ends with `# guard`; failing before any work it is wrong, and is
  repaired from the state its output shows (the repair is told it is a
  guard). The planner prefers "still running" by name (`-ge 1`) to an
  exact count.
- The agent's server prompt says the checks are Oraknid's: never make
  one pass another way (it had written a shim outside its scope to make
  the check pass); a block it can't do without is said in its last
  message.

Related: [[ADR-026-Servers]] · [[ADR-034-Projects-First]] · [[ADR-042-Several-Repos-And-Servers]] · [[ADR-043-Server-Insight]] · [[ADR-045-The-Eye-Speaks-Up]] · [[Servers]] · [[The-Eye]]
