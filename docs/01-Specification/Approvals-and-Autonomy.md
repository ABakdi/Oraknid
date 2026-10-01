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
| `push` | `git push` to any remote. |
| `merge` | Merging the work branch into the release branch. |
| `deploy` | Any deploy script or command declared as deploy. |
| `delete` | Deleting outside the worktree, or deleting a branch. |
| `spend` | Any action projected to exceed the money threshold. |
| `external-write` | Any MCP or API call declared as writing. |
| `install` | Installing system packages, or global packages outside the workspace. |

## Leg permission prompts

When a Leg asks for permission (e.g. Claude Code wants to run a shell
command), The Eye decides by policy:

1. Denied by the deny list → deny, and count it as drift D7.
2. Inside the sandbox scope and on the allow list → approve.
3. A gated action → becomes an approval in the inbox, and the Leg waits.
   If the attempt ends first (pause, reassignment, a crash), the
   approval is withdrawn: my inbox never holds a question nobody waits
   for.
4. Unknown → depends on autonomy level: Supervised and Standard ask me,
   Full approves when it's in scope and not gated.

## The inbox

One list for every approval and question across all jobs, newest and
most blocking first. Each item shows:

- The job, task and Leg.
- What exactly will happen (the command, the email body, the diff summary).
- Why (the task's reason).
- Buttons: **Approve**, **Deny**, **Approve all like this for this job**
  (approvals); an answer field and suggested answers (questions).

Answering works from the inbox, the task view, or a notification.
Unanswered items never expire on their own. The waiting task shows how
long it has waited. Other tasks continue.

Related: [[Security]] · [[Notifications]] · [[Business-Rules]] · [[Skills]]
