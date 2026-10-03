# Phase 13 — Projects first

Touches [[Web-UI]], [[Jobs-and-Projects]], [[The-Eye]], [[Silk]], [[Budgets-and-Quotas]], [[The-Nest]], [[OS-Integration]], [[Approvals-and-Autonomy]].
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

Tested (2026-10-03): `pnpm check` green. (The tests' temporary folders
had used up `/tmp`'s inodes; each package's test run now keeps them in
one folder of its own, removed when the run ends, `vitest.tmp.ts`.)
Daemon tests in
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

### M13.3 — Install with one script ([[ADR-036-One-Script-Install]])
- [ ] `install.sh` at the root: missing packages, clone, build, `oraknid` on my PATH, the service, a pairing code
- [ ] Services for systemd, OpenRC and runit; an autostart entry otherwise; `oraknid install`/`uninstall` the same
- [ ] The guide and the site's install block say the one command

### M13.4 — Questions with options ([[ADR-037-Questions-With-Options]])
- [ ] Questions shaped single, multi, text, confirm, with a recommended option and "Other"
- [ ] The interview and The Eye's conversation answer them in tabs, by keyboard and touch

### M13.5 — Workflow ([[ADR-034-Projects-First]] → Changed)
- [ ] The tab named Workflow, the diagram filling it, compact and expanded, a job's box opening its own workflow

### M13.6 — A project's GitHub repo and servers ([[ADR-038-Project-Accounts]])
- [ ] Several GitHub accounts; a project's GitHub link (account, repo) beside its servers
- [ ] The Eye asks in its conversation once, with options, and saves the answer to the project
- [ ] The built-in `github` tool (create the repo, push, pull request) run by Oraknid with the token; Legs told not to use `gh`
- [ ] Linked work runs without asking; the rest still asks
- [ ] The piano project's stalled push finished through it

### M13.7 — Mail accounts that explain themselves ([[ADR-032-Email]] → Fixed after a failed Namecheap POP account)
- [x] Presets from the domain's MX, port and security together, errors in plain words, Test, failures logged

Tested (M13.7): Namecheap's server probed for real (POP3 995 and 110
reach its login with Oraknid's client; a wrong port and security give
the raw TLS error the fix explains). `apps/daemon/src/mail/diagnose.test.ts`
(providers from MX, usual ports, each kind of error in words);
`mail.test.ts` (TLS to a clear port, a refused login, a closed port,
Test checking each side and saving nothing, a failed add logged without
the password, Namecheap found from its MX); the form's test (servers
filled in from the address, port and security together, Test's results).

### M13.8 — Plan usage in front of me ([[ADR-039-Plan-Usage-In-View]])
- [ ] Each Claude Code Leg's windows (how full, reset, Oraknid's share) on the Overview and in the Leg's details, with how old it is

### M13.9 — Repos ([[ADR-040-Repos-Page]])
- [ ] A Repos page: accounts, repositories, and in one: code, commits with diffs, branches, pull requests, its project

### M13.10 — The guide inside, and a helper that shows me ([[ADR-041-Docs-And-A-Guiding-Helper]])
- [x] Docs in the sidebar: the guide's pages, a search, Ask the helper about this
- [x] The helper knows the guide, a map of the screens, and my data (mail included) through the API
- [x] The helper navigates, highlights a control, and fills a field for me to check

Tested (M13.10, 2026-10-03): `pnpm check` green. Daemon
(`apps/daemon/src/helper/helper.test.ts`): the helper reads my mail
through the mail service (accounts, a search, a thread from a stand-in
IMAP server), the next round gets it wrapped as untrusted data with the
injected "ignore all previous instructions" inside the wrapper, and the
conversation keeps only a short result; servers, Legs' usage, inbox and
settings read; navigate, highlight and fill end the turn in one round,
a wrong input fails; the route, the guide pages and the screens sent by
the web app reach the prompt; a context too large is refused. Web: every
id of the help map (82 controls, 103 with the tabs) is a `data-help` in the screens
(`help-map.test.ts`); the guide is the site's, its search puts headings
first, its links map to the app (`guide.test.ts`); navigate, highlight
(page and tab, a menu and a dialog opened on the way, a folded
`<details>`, scroll still under reduced motion, the ring gone on a click
or a new page) and fill as typed (`helper-show.test.tsx`); the panel
sends route, guide and screens, shows a reply's actions once, and steps
aside on a phone (`helper.test.tsx`). By hand in headless Chromium on a
sample daemon (fake OS, scripted Leg, stand-in brain, its own data
folder, port 7533) at 1440 and 390 px: Docs, a search ("pair phone",
11 places), a heading's address, Ask the helper about this, a reply that
rings the terminal switch in Settings → Security, one that opens a
mail account's menu and settings dialog (on a phone through the
folders drawer) to ring Auto-send, one that opens the piano project's
Work tab, one that fills New work's goal, and one that reads the
invoice from the mail and answers; no page errors, nothing past the
right edge. The site still builds, its page list now read from
`apps/site/docs/guide.json`.

## Exit criterion

I ask for new work on the piano project from its Eye tab and follow it
there to the end, without a job page; a search engine and a visitor
find nothing on my private Nest.

Related: [[Roadmap]] · [[Phase-11-Workspace]]
