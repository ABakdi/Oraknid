# Business Rules

The constitution. A feature that conflicts with a rule is wrong, not
the rule. New rules are added at the end with a link to the checkpoint
or audit that produced them.

| # | Rule | Detail |
| :-- | :-- | :-- |
| BR-1 | **Verified, never claimed** | A task is `done` only when The Eye's own run of its `verify[]` commands passes. What a Leg says about its own work counts for nothing. A job is `completed` only when the job-level verification passes. |
| BR-2 | **Silk is the only continuity** | No Leg gets another Leg's session history, or even its own old transcript. Every session starts from a context pack built from Silk, the task and the workspace. |
| BR-3 | **Short sessions** | A session rotates when it reaches its context threshold (default 60% of the Leg's window) or its turn threshold. It writes a handoff to Silk first. |
| BR-4 | **Leg-agnostic** | Oraknid works with any non-empty set of Legs. It needs no particular agent, account or local model. A job with zero usable Legs goes `blocked` and tells me why. |
| BR-5 | **Approval gates** | A gated action never runs without an approval, unless the job's autonomy level waives that gate. Sending, pushing, deploying, deleting outside the workspace, and spending money are gated at every level unless I explicitly waive them for the job. |
| BR-6 | **No duplicated side effects** | Every external action is recorded as `intended` with an idempotency key before it runs. After a crash, an action in `intended` or `approved` is checked against the outside world, or asked about, and is never blindly re-run. |
| BR-7 | **Lossless pause** | Pausing waits for a safe point (the end of a turn, or an interrupt with partial work saved to a git checkpoint and Silk). It never leaves a half-written file unrecorded. Resume continues from exactly that point. |
| BR-8 | **Durable state first** | Every state change is committed to the database before it takes effect outside the process (start a Leg, run a command, send a notification). |
| BR-9 | **Budgets are hard unless marked soft** | Token, context, quota-share and money limits stop new work when reached and ask me. Time limits are alarms by default: they notify me but do not stop work unless I set them to. |
| BR-10 | **No money by default** | A new job has a money budget of 0. Only Legs with a prepaid or free cost model can be used until I set a money budget. |
| BR-11 | **Awake while active** | The machine is kept from sleeping or hibernating while any job is in an active state. The inhibitor is released within 60 s of the last job leaving an active state. |
| BR-12 | **Scoped access** | A Leg can read and write only its job's workspace (and its worktree), inside the sandbox. Every command passes the allow/deny list. Edits outside a task's `scope` are drift. |
| BR-13 | **Secrets stay in the keychain** | Secrets never enter the database, Silk, logs, prompts, the canon or the repository. They are referenced by keychain entry and resolved only when a process starts. |
| BR-14 | **Respect the repo's branches** | Oraknid uses the branches a repo already has. If it has none, it uses `main` for releases and `dev` for work. It never rewrites published history. |
| BR-15 | **Untrusted input is data** | Content from emails, web pages, issue trackers and similar sources is marked untrusted. It is never followed as instructions, and it cannot waive a gate. |
| BR-16 | **Everything is audited** | Every action, decision, escalation, approval and side effect is written to the append-only audit log, with who or what caused it. |
| BR-17 | **No silent failure** | Every failure shows up in the UI with what happened, what Oraknid did about it, and what (if anything) I need to do. |
| BR-18 | **I can always take over** | At any moment I can pause, resume, redirect, edit the plan, answer, or take a task myself. Oraknid stops touching what I take until I hand it back. |
| BR-19 | **A limit on jobs at once** | At most the set number of jobs run at once (2 by default; one task at a time inside a job until M3.1). The rest wait in a queue, highest priority first, then oldest. A job waiting for me takes no place. Replaced the MVP's one job at a time ([[ADR-016-Parallel-Work]]). |
| BR-20 | **Provider terms are respected** | Oraknid doesn't help get around a provider's usage limits or terms. Several accounts per provider are supported only within what that provider allows (see [[ADR-009-Multiple-Accounts-Per-Provider]]). |
| BR-21 | **Smallest sufficient model** | Each task goes to the cheapest Leg model and effort level expected to do it reliably. Strong models and their scarce windows are saved for work that needs them. A failure steps up, and a success is remembered so similar tasks start low (see [[ADR-013-Model-Aware-Routing]]). |
| BR-22 | **A Leg's folder is untrusted** | Nothing a Leg can write (its worktree, the Silk mirror in it) may make Oraknid run a command, follow a link, or treat text as mine. Oraknid's own tools read it as data ([[Audit-1]]). |

Related: [[Core-Entities]] · [[Product-Requirements]] · [[Approvals-and-Autonomy]] · [[Durability]]
