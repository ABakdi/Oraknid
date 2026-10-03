# Phase 13 — Projects first

Touches [[Web-UI]], [[Jobs-and-Projects]], [[The-Eye]], [[Silk]], [[Budgets-and-Quotas]], [[The-Nest]].
Written 2026-10-03.

## Why

A job page beside a project page confused me: the work I asked for on
the piano project went to a job I wasn't looking at. I work in a
project; jobs should be its history. And my Nests showed too little
(public) or too much (private).

## Milestones

### M13.1 — The project is the place ([[ADR-034-Projects-First]])
- [x] The Eye's conversation per project; talking from the project starts or feeds its jobs (migration 0029 gives each message its project; a project with no job starts one from my message, kept as a draft with the reason when it can't start)
- [x] The project page: The Eye, The Web across its jobs, Work (the jobs as a timeline, each opened in place), Inbox, Silk by job, Activity, Budget & stats, Settings (a job opened in Work keeps its own Silk and Inbox tabs too)
- [x] No job page and no Jobs page: their links open the project at Work, "Running now" on the Overview (notification links keep `/jobs/<id>`, which the app opens in the project)
- [x] New work lands in the project's Eye tab (its drafts are listed on New work now)
- [x] A project budget across its jobs, and the default for a new job in it (a follow-up job keeps the budget of the job it follows)
- [x] Context packs take earlier jobs' standing Silk

Tested (2026-10-03): `pnpm check`'s lint and typecheck green, every
package's tests green (the daemon's and OpenCode's run with `TMPDIR`
outside `/tmp`, whose inodes the test folders left behind over time had
used up: the tests don't remove their temporary folders). Daemon tests in
`apps/daemon/src/eye/projects-first.test.ts`: the project's
conversation starts a first job from my message, passes the next to
the job running, starts a follow-up once it ended and then talks to the
follow-up; a first job that can't start stays a draft and says why; the
0029 migration fills a message's project from its job; `silk.byProject`
groups by job, newest first; a second job's context pack holds the
first job's decision and not its note for later; the project budget is
a new job's default, pauses a job past the project's total and asks
once, doubling it resumes the job, keeping it paused doesn't. Core:
the pack puts earlier jobs' entries after the job's own and cuts them
first. Web: The Web's folding, the job addresses and the old tabs'
mapping, no `g j`. By hand, on a sample daemon (fake OS, scripted Leg,
its own data folder and port) at 1440 px and 390 px: three jobs asked
for from the piano project's Eye tab, an instruction passed to the
running one, The Web with earlier jobs folded and one opened, Work with
the job opened (tasks, drawer, budget), Silk by job, the project's
budget, Running now with Pause, `/jobs` and `/jobs/<id>/budget`
redirected.

### M13.2 — What a Nest shows ([[ADR-035-Nest-Pages-By-Mode]])
- [x] Public: Open Oraknid in the site's header and hero, and a strip under the hero saying this is a public Nest (open, or invite needed, from `/info`) with Pair or open a device
- [x] Private: no site, a bare 404 everywhere but the loader and the relay, `X-Robots-Tag: noindex` on everything, robots.txt disallowing all; the loader page `noindex` on both kinds
- [x] My private Nest's address out of the canon and the repository's files (old commits still have it)

Tested (M13.2): `apps/nest/src/relay.test.ts` (a public Nest's site
indexable and its loader not; a private Nest's root, site pages and
unknown paths a bare 404, its loader served, robots.txt); both kinds
run locally and the public site checked at 1440 and 390 px.

## Exit criterion

I ask for new work on the piano project from its Eye tab and follow it
there to the end, without a job page; a search engine and a visitor
find nothing on my private Nest.

Related: [[Roadmap]] · [[Phase-11-Workspace]]
