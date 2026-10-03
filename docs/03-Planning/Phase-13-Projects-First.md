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
- [x] Questions shaped single, multi, text, confirm, with a recommended option and "Other"
- [x] The interview and The Eye's conversation answer them in tabs, by keyboard and touch

Tested (2026-10-03): contracts `questions.test.ts` (Yes and No for a
confirm, unique ids, recommended filled in where I said nothing, the
short list). Daemon: `brain.test.ts` (a shaped round through the
brain's parsing, an old round upgraded, The Eye's reply with questions
and without), `eye.test.ts` (a draft round asked with options and
answered structured, its Silk; an inbox round answered structured; an
old text answer still taken), `projects-first.test.ts` (questions in a
reply, my answers as my next message, answered once). Web:
`questions.test.tsx` (recommended selected, ↑/↓, Space, Enter, ←/→,
Tab, 1–9, Shift+Enter, Other, Submit with the recommended filled in,
keys kept from the page, 44 px rows). By hand on a sample daemon (fake
OS, scripted Leg): an interview round in the project's inbox answered
by keyboard only, a draft round on New work, The Eye's questions in the
conversation, at 1568 px (the window couldn't be set to 1440) and
390 px (headless Chromium, no sideways scroll).

### M13.5 — Workflow ([[ADR-034-Projects-First]] → Changed)
- [x] The tab named Workflow, the diagram filling it, compact and expanded, a job's box opening its own workflow

Tested (2026-10-03): `pnpm check` green. Web tests in
`apps/web/src/components/project-work.test.tsx`: a box per job in the
order they ran, each after the one before, the current one marked (the
newest once all ended, never a draft); the drilled-in job's address and
`/projects/<id>/web` going to `/workflow`; expanded frames stacked
across and down; the mode kept per project and compact when storage
refuses. By hand on a sample daemon (fake OS, scripted Legs, its own
data folder and port, three jobs on the piano project, one running) at
1440 px and 390 px: the old address redirected, compact with the
running job highlighted, a box opened (address, All jobs back, a task's
drawer and Esc), expanded with each job framed, on a phone top to
bottom with the zoom controls reachable. (The window couldn't be
resized below the screen, so 390 px was a 390 px frame of the app.)

### M13.6 — A project's GitHub repo and servers ([[ADR-038-Project-Accounts]])
- [x] Several GitHub accounts; a project's GitHub link (account, repo) beside its servers
- [x] The Eye asks in its conversation once, with options, and saves the answer to the project
- [x] The built-in `github` tool (create the repo, push, pull request) run by Oraknid with the token; Legs told not to use `gh`
- [x] Linked work runs without asking; the rest still asks
- [ ] The piano project's stalled push finished through it

Tested (2026-10-03): `apps/daemon/src/eye/project-links.test.ts`
reproduces the piano's task against a stand-in GitHub API and a local
bare repo: my one token of before named by its account (kept under its
old keychain entry), "Create a GitHub repo for the piano project and
push the dev branch" asked in the project's conversation (repo and
visibility, public recommended because I asked for public, my only
account said), answered there, the link saved, the repo created public
and empty by the tool and `dev` pushed (the same commit), a push to
another repo asking and denied, the token in no Leg's start, no event
and not in `.git/config`; a second test with two accounts, the account
asked too, answered from the inbox with a repo typed, and Settings'
change, unlink and an unknown account refused; the policy per call
(linked create, push and pull request allowed; force, elsewhere,
another repo, an unknown call asked; created already asks). Core:
linked and gated declarations, untrusted content asking. By hand on the
sample daemon: the question in the conversation, Submit, "Linked" and
the job done, the project's Settings (GitHub repo beside servers,
Change), Settings → Connections → GitHub, at 1568 px and 390 px.
Found by hand and fixed: the UI's page was a 404 when Oraknid's folder
has a hidden folder in its path; saving the same link again marked a
created repo as to be created. The piano item stays open until the
real job is resumed on this build.

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
- [x] Each Claude Code Leg's windows (how full, reset, Oraknid's share) on the Overview and in the Leg's details, with how old it is (read through the SDK's usage request, no prompt; the rate-limit events and a 15-minute prompt when it can't: ADR-039 → As built)

Tested (2026-10-03): `pnpm check` green. Adapter
(`packages/legs/claude-code/src/adapter.test.ts`): the plan's windows
read without a message, as shares and milliseconds, in the Leg's own
config folder; none on an API key; no reading when the CLI refuses the
request. Daemon (`apps/daemon/src/legs/plan-usage.test.ts`): account
windows stored on the Leg and a model's on its model, fullest first
with their time and source; Oraknid's tokens per window by model, only
since it began; reads at most every 5 minutes and only when asked, two
callers sharing one; an unchanged reading only moving its time, a fill
and a reset in the history; the fallback prompt at most every 15
minutes on the cheapest model, its tokens counted, none while a
session has reported; other kinds' notes. Web
(`apps/web/src/components/plan-usage.test.tsx`): Legs and windows
fullest first, near and at the limit, the "as of" age and reset words.
By hand on the same sample daemon (two scripted Claude Code Legs with
readings, eight days of history, an Ollama Leg) at 1440 and 390 px:
the Overview's card (Max at limit first, its Opus window first), a
Leg's details with fills and resets and Oraknid's share, Ollama's note.
Not run against a real account (only `claude --help`).

### M13.9 — Repos ([[ADR-040-Repos-Page]])
- [x] A Repos page: accounts, repositories, and in one: code, commits with diffs, branches, pull requests, its project

Tested (2026-10-03): `pnpm check` green. Daemon
(`apps/daemon/src/workspace/github-repos.test.ts`, against a stand-in
GitHub API, `testing/fake-github.ts`; nothing called the real GitHub):
every account's repositories listed once in two pages of 100, with
visibility, default branch, last push and the linking project, one
account's alone, an unknown account refused; a repository's info (an
empty one said empty, one only another account sees read through it),
branches, the root folder (folders first) and a subfolder at a branch
with a slash, the recursive tree, a text file, a binary one, one over
512 KB, the README (none on an empty repository), a branch's commits in
pages of 30, none on an empty repository, a commit with each file's
patch (none for a binary), open and closed (merged) pull requests and
one with its description, commits and files, a 404 in words; a read
kept a minute, then asked again with the ETag and the 304 costing
nothing, a new repository listed at once; the hourly allowance in
words, used up (the list naming the account and still showing the
others), and slow down; no response carrying a token; reads allowed
away from home, creating and linking home only (full rights may). Web
(`apps/web/src/pages/repos.test.tsx`): the addresses (a branch with a
slash, a path with a space, a commit, a pull request), `g r`, the list's
rows and search, opening a repository, Code by default with its tree
and README, the tab and branch read from the address and a tab click
changing it, a patch's line numbers, a file's diff marked and coloured
in its own scrolling block and folded, no diff said, the language by
name and highlighted lines with a comment across lines and the text
escaped. By hand on a sample daemon (fake OS, a scripted Leg, the
stand-in GitHub with two accounts, its own data folder, port 7539) at
1568 px: the list and the accounts with their allowance, `g r`, the
code at a branch, a file coloured, a commit's diff, a pull request, a
repository linked to a project from its Project tab (the list showing
it live), New work on another account's repository arriving with it
chosen; at 390 px (headless Chromium, the window couldn't be narrowed):
the list, a file, a commit's diff and the More menu with Repos, the
page never wider than the screen. Found by hand and fixed: New work's
repo picker failed on an empty repository; the allowance didn't show
until a reload.

### M13.10 — The guide inside, and a helper that shows me ([[ADR-041-Docs-And-A-Guiding-Helper]])
- [ ] Docs in the sidebar: the guide's pages, a search, Ask the helper about this
- [ ] The helper knows the guide, a map of the screens, and my data (mail included) through the API
- [ ] The helper navigates, highlights a control, and fills a field for me to check

## Exit criterion

I ask for new work on the piano project from its Eye tab and follow it
there to the end, without a job page; a search engine and a visitor
find nothing on my private Nest.

Related: [[Roadmap]] · [[Phase-11-Workspace]]
