# Approvals and Autonomy

**Is:** what Oraknid may do on its own, what waits for me, and how I
answer.
**Is not:** the command filter (see [[Security]]). That filter blocks
outright. Approvals ask.

## Autonomy levels

Set per job. Changeable while the job runs. Since auto mode
([[ADR-053-Auto-Mode]], 2026-10-07) the levels are:

| Level | I approve |
| :-- | :-- |
| **Auto** (default) | A server job's plan, each change on a production server, and what is never automatic (sending, publishing, deleting a repository, paying). Everything else is settled by the rules (layer 1) or the judge (layer 2): a block is told to the agent with its reason and it goes another way; I'm asked only when it is stuck on blocks (→ Auto mode). |
| **Careful** | The plan (The Web) before work starts, each replan, every gated action, and every action the rules don't allow at once, even when the judge would (the old Supervised and Standard's asking). "Approve all like this" is matched on the parsed command's shape. |
| **Full** | As Auto, without the judge for the job's own folder and the servers not marked production. Plans of servers, production and what is never automatic still ask. A write or delete outside the job's folder isn't asked at any level: it is refused (→ Writing outside its folder). |

Jobs from before auto mode were moved (migration 0039): Standard became
Auto, Supervised became Careful. The old names still parse in the API.

**Overrides**: per job, I can waive a specific gate, e.g. "may push to
the work branch", or what is never automatic, e.g. sending. A waiver is
recorded in the audit log.

## Gated actions

| Action | Examples |
| :-- | :-- |
| `send` | Email, messages, comments on an issue. |
| `push` | `git push` to any remote; the github tool's push anywhere but the project's linked repo, or a force-push. |
| `merge` | Merging the work branch into the release branch. |
| `deploy` | Any deploy script or command declared as deploy. |
| `delete` | Deleting a branch (`git branch -D`, `git push --delete`). A Leg's write or delete outside its folder is refused, not asked (2026-10-04, → Writing outside its folder). |
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

## Auto mode (2026-10-07, [[ADR-053-Auto-Mode]])

Every request of a Leg goes through three layers, in order:

1. **The rules** (the guard, `@oraknid/guard`, under a few
   milliseconds; a plain read under one). The command is parsed with
   tree-sitter-bash: pipelines, `&&` and `;`, subshells, redirections,
   `$(…)`, `sh -c '…'`, and the command an `ssh [options] host '…'`
   runs there (`ssh -F <config> alias '…'` too), each read again.
   - **Blocked at once**: CC Safety Net's rules and its Terraform, AWS,
     gcloud and Azure rulebooks (force push, `reset --hard`,
     `checkout --`, `git clean -f`, `rm -rf` outside the folder,
     reading `.env`, `~/.ssh`, `~/.aws`…); our own rules for its gaps
     (`docker system|volume prune`, `docker compose down -v` on a
     project the task doesn't name, `kubectl delete`, `DROP`/`TRUNCATE`,
     `redis-cli FLUSHALL`, a download run as code, `terraform destroy`,
     a deploy to production from this computer); and a credential in a
     command that goes out (secretlint's recommended rules and
     gitleaks-style patterns). The agent is told "Blocked: <reason>…
     find another way", and goes on.
   - **Allowed at once**: reads, searches and edits in the job's folder
     and its scratch; every part on the read-only list (and over ssh,
     on the job's servers, the same list on the far side); the
     project's own build, test and lint commands; installing what the
     lockfile names; a project's own script run by its interpreter.
   - **Asked**: a change on a production server, `scp`/`rsync` to one.
   - The rest goes to the judge.
2. **The judge**, a model, reasoning-blind: it sees my messages, the
   job's goal, the task and its scope, and the pending action, never
   the agent's prose or output. Stage 1, on the fastest model allowed,
   answers ALLOW or BLOCK; a BLOCK goes to stage 2, the strongest model
   allowed, which says why, in one of four categories (destroying or
   exfiltrating data; weakening security; crossing a trust boundary;
   bypassing review or touching shared or production infrastructure).
   Verdicts are cached per task by the normalised command and folder;
   a judge that doesn't answer in 10 s counts as BLOCK. At Careful, what
   it allows is mine to approve.
3. **Me**: a server job's plan, each change on production, what is
   never automatic, and an agent **stuck on blocks**: three in a row or
   twenty in a task, and The Eye asks me, listing what was blocked and
   why: "Let it run this one" or "Keep it blocked" (the agent then goes
   another way, or says it can't be done without it).

Every decision is in the audit log (`policy.decision`: the action, the
verdict, its layer, its reason; the judge's own `policy.judged`), and in
the session's log next to the request. The Eye's report of a finished
job counts what was blocked, by layer.

Claude Code runs in its own auto mode (`--permission-mode auto`, its
own classifier) at Auto and Full, with Oraknid's rules before every
tool as a PreToolUse hook: a block is denied with its reason, a
production change or what is never automatic comes back to Oraknid as a
permission prompt, and what Claude Code's classifier refuses comes back
as an event shown in the session. The other Legs go through all three
layers. At Careful Claude Code asks Oraknid for everything, as before.

## Leg permission prompts

When a Leg asks for permission (e.g. Claude Code wants to run a shell
command), The Eye decides by policy (layer 1's frame, → Auto mode):

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
2. Blocked by the guard (→ Auto mode) → refused with its reason, above
   my allow rules; not a drift, it counts toward "stuck on blocks".
3. Inside the sandbox scope and on the guard's allow list → approve.
4. A gated action: what is never automatic → an approval in the inbox,
   at every level; the rest → the judge at Auto and Full, an approval
   at Careful. The Leg waits for an approval. If the attempt ends first
   (pause, reassignment, a crash), the approval is withdrawn: my inbox
   never holds a question nobody waits for.
5. Anything else → the judge (→ Auto mode); at Careful what it allows
   asks me.

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

Its scratch also counts its Leg's own `tmp` and `.cache`, and its home
for the job has a `tmp` of its own (M13.22, 2026-10-04): the job's
`tmp` was a link to the Leg's, so OpenCode's writes to its own temp
folder (`legs/<leg>/home/tmp/opencode/*`) were refused four times. And
OpenCode's "external directory" question, asked before it reads or
writes a folder outside the project, is allowed: the folder alone
writes nothing, the read or the edit it then asks for is judged with
its own path, and the sandbox shows only what it was given. Its other
questions get answers without a classifier too: a sub-agent and a
question are like Claude Code's, its MCP resources are reads, and "go
on after the same call failed three times" is left to drift control
(D2, D3).

### Reading the project's own repo (2026-10-04)
A task that read from the web is untrusted, and a gated action asks me
from then on (BR-15). A page of the project's own linked GitHub repo
(`github.com/<owner>/<name>…`, its API under `api.github.com/repos/…`, its
raw files) isn't outside content and doesn't count: an agent looking at
the piano repo's page made its push to that same repo ask me.

### Commands on a server (2026-10-04, [[ADR-049-Server-Chat-And-Server-Jobs]])
A command that reaches one of the job's servers is judged as what runs
there. `ssh <alias> '…'`, with nothing after it on the line, is judged
by this policy without its `sudo`: root on the server is the server's
business, never refused as root on this computer, and the never-allowed
list still holds (a `shutdown`, a local `| sudo tee` after the ssh).
On a **production** server (my mark on it, or its role in the project)
anything that doesn't only read asks me, at any autonomy, whatever my
rules allow; `scp` and `rsync` to it always ask. What only reads is a
fixed list: `systemctl status` and `is-active`, `journalctl`, `docker ps`
and `logs`, `nginx -t`, `cat`, `tail`, `grep`… with no `>` into a file.
A server job's plan that changes its server waits for my approval
before work starts (at Auto and Careful; at Full only on production).
Since auto mode the read-only list is the guard's, the same on this
computer and over ssh, and `cd /root/x && docker compose -p x ps -a` or
`docker logs` on a non-production server run without asking: one server
session asked me 22 times on 2026-10-06, mostly for such reads. The
`deploy` gate is `deploy` as a word (`make deploy`, `./deploy.sh`), no
longer any name with it (`/root/spinet-deploy` asked before).

## The inbox

One list for every approval and question across all jobs, newest and
most blocking first. Each item shows:

- The job, task and Leg.
- What exactly will happen (the command, the email body, the diff summary).
- Why (the task's reason).
- Buttons: **Approve**, **Deny**, **Approve all like this for this job**
  (approvals: a gate becomes a waiver; a command, a `shape:` rule of the
  job matched on its parsed shape (where each part runs, its program,
  subcommands and flags; not its paths and names), so
  `ssh s1 'docker compose -p x restart web'` approves the same restart
  of `api`; both audited); an answer field and suggested answers
  (questions). An agent stuck on blocks asks with **Let it run this
  one** and **Keep it blocked**. A question asked with options (an interview round, The
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
- At Careful, the plan approval is asked on every run of the job,
  before any work: once approved it passes, once denied the plan never
  runs.

Answering works from the inbox, the task view, or a notification.
Unanswered items never expire on their own. The waiting task shows how
long it has waited. Other tasks continue.

Related: [[Security]] · [[Notifications]] · [[Business-Rules]] · [[Skills]]
