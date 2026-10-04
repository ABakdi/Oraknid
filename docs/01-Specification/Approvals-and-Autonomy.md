# Approvals and Autonomy

**Is:** what Oraknid may do on its own, what waits for me, and how I
answer.
**Is not:** the command filter (see [[Security]]). That filter blocks
outright. Approvals ask.

## Autonomy levels

Set per job. Changeable while the job runs.

| Level | I approve |
| :-- | :-- |
| **Supervised** | The plan (The Web) before work starts, each replan, every gated action, and every Leg permission prompt the policy does not auto-approve. |
| **Standard** (default) | Every gated action, and every Leg permission prompt outside the job's scope or allow list. |
| **Full** | Only spending above the threshold and irreversible external actions (send, push to a remote, deploy, delete outside the workspace). |

**Overrides** (Supervised and Standard only): per job, I can waive a
specific gate, e.g. "may push to the work branch". A waiver is recorded
in the audit log. Full can never waive BR-5's always-gated set without
an explicit per-job waiver.

## Gated actions

| Action | Examples |
| :-- | :-- |
| `send` | Email, messages, comments on an issue. |
| `push` | `git push` to any remote; the github tool's push anywhere but the project's linked repo, or a force-push. |
| `merge` | Merging the work branch into the release branch. |
| `deploy` | Any deploy script or command declared as deploy. |
| `delete` | Deleting outside the worktree, or deleting a branch. |
| `spend` | Any action projected to exceed the money threshold. |
| `external-write` | Any MCP or API call not declared as a read ([[ADR-021-Tools-Broker]]). |
| `install` | Installing system packages, or global packages outside the workspace. |

## Linked work (2026-10-03, [[ADR-038-Project-Accounts]])

A project's GitHub link is my approval for its own repo. Through
Oraknid's `github` tool, these run without asking, at every autonomy:
creating the linked repo while it doesn't exist (as I chose it: its
name, its visibility), pushing a branch to it, and opening a pull
request there; each is in the job's events (`tool.linked`,
`github.pushed`, `github.repo-created`, `github.pull-request`). Still
asked: a force-push (gate `push`), a push to any other repo (`push`),
creating another repo or a pull request elsewhere (`external-write`),
and any call the tool doesn't know (`external-write`, which covers
deleting and changing visibility: the tool has no such call). A task
that read untrusted content asks even for linked work (BR-15). The
judgement is made per call, from its arguments, by the tool itself in
the daemon; "Approve all like this" on a push waives `push` for the job.

## Leg permission prompts

When a Leg asks for permission (e.g. Claude Code wants to run a shell
command), The Eye decides by policy:

1. Denied by the deny list → deny, and count it as drift D7. Since the
   piano job (2026-10-03) the list also keeps the job's folder a
   worktree of its project: moving, deleting or re-creating a `.git`
   (`mv`, `rm`, `cp`, `rsync`, a redirection, `sed -i`), `git init`
   (except a scratch repo under `/tmp`), `git worktree add|remove|move|prune|repair`,
   anything under `.git/worktrees`, and a file tool writing inside a
   `.git` are refused outright at every autonomy, whatever my allow
   rules say, never asked.
   Before the list, Oraknid's own checks (`oraknid github-…`, ADR-038) a
   Leg tries to run are answered: "Oraknid runs this check itself when
   you finish… don't run it". Not a drift, never asked (the piano job's
   Legs asked me four times).
2. Inside the sandbox scope and on the allow list → approve.
3. A gated action → becomes an approval in the inbox, and the Leg waits.
   If the attempt ends first (pause, reassignment, a crash), the
   approval is withdrawn: my inbox never holds a question nobody waits
   for.
4. Unknown → **auto approval** at Standard and Full
   ([[ADR-014-Auto-Approval]]): a classifier allows it or asks me, and
   says why; Supervised asks me. Commands are parsed as the shell
   parses them, so a heredoc or a loop is one program, not its words.

My allow and deny lists exist at three levels: the job's, the
project's (on the project page) and the global ones (Settings). The
most specific level with a matching rule decides; within a level, deny
beats allow. The never-allowed list stands above them all.

### Writing outside its folder (2026-10-04)
A Leg writing inside its job's folder is allowed. Its own scratch space,
private to its sandbox (its `/tmp`, its home for this job), is allowed
too, without asking: OpenCode asks before writing anywhere outside the
folder it was started in, and those questions reached me 16 times for
its own `/tmp` and home. Anywhere else (the project's own folder and
branches, my home) is refused, never asked, and the Leg is told to work
in its folder: the project's own branches are Oraknid's to change at the
end of the job.

### Reading the project's own repo (2026-10-04)
A task that read from the web is untrusted, and a gated action asks me
from then on (BR-15). A page of the project's own linked GitHub repo
(`github.com/<owner>/<name>…`, its API under `api.github.com/repos/…`, its
raw files) isn't outside content and doesn't count: an agent looking at
the piano repo's page made its push to that same repo ask me.

## The inbox

One list for every approval and question across all jobs, newest and
most blocking first. Each item shows:

- The job, task and Leg.
- What exactly will happen (the command, the email body, the diff summary).
- Why (the task's reason).
- Buttons: **Approve**, **Deny**, **Approve all like this for this job**
  (approvals: a gate becomes a waiver, an unknown program an allow
  rule, both audited); an answer field and suggested answers
  (questions). A question asked with options (an interview round, The
  Eye's question about a project's repo or server) is answered in the
  questions component ([[ADR-037-Questions-With-Options]]); my answers
  are kept structured and shown as a short list. When The Eye asked it
  in a project's conversation too, answering it in either place
  answers it, and my answers join the conversation.
- **What each answer does** ([[ADR-045-The-Eye-Speaks-Up]]): every
  approval and question says it on each answer. An approval's detail
  ends with **If you deny it:** and what follows; its buttons carry a
  line each (a Leg's request: it runs once / the Leg is told no and
  tries another way, and I'm asked if it can't / every such request in
  this job passes; the plan: work starts / nothing runs and the job
  stops until I say what to change; an email: sent once / not sent,
  the draft kept). Questions with plain options (a budget, Silk edits,
  whether an action happened) carry a question with the same options,
  each with its line; chosen there, the item is answered with the
  option itself.
- **After I deny a Leg's request** the Leg is told ("don't try it
  again: find another way, or say it can't be done without it") and
  The Eye says in the project's conversation what happens next.
- Answering an item a job was waiting for resumes the job at once.
- At Supervised, the plan approval is asked on every run of the job,
  before any work: once approved it passes, once denied the plan never
  runs.

Answering works from the inbox, the task view, or a notification.
Unanswered items never expire on their own. The waiting task shows how
long it has waited. Other tasks continue.

Related: [[Security]] · [[Notifications]] · [[Business-Rules]] · [[Skills]]
