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
- [x] `install.sh` at the root: missing packages, clone, build, `oraknid` on my PATH, the service, a pairing code
- [x] Services for systemd, OpenRC and runit; an autostart entry otherwise; `oraknid install`/`uninstall` the same
- [x] The guide and the site's install block say the one command

Tested (M13.3): `packages/os/src/linux/services.test.ts` (which service
manager from PID 1 and the tools present, `ORAKNID_SERVICE`; the OpenRC
script and the runit `run` valid sh, with what each runs as OpenRC's
eval and chpst read it; install and uninstall commands through sudo or
as root; the autostart entry's Exec). `install.sh` shellcheck-clean, and
run for real in containers, as a user with sudo, from a clone of this
branch (`--from`): Debian 12 (apt, Node 18 too old so Node 22 from
nodejs.org with its checksum, autostart, then runit with `runsvdir`
running: the service up as me, `--uninstall`), Ubuntu 24.04 (runit
from the first run), Alpine 3.22 (apk, the
distribution's Node, corepack through npm, OpenRC brought up by hand:
the service up as me, killed and respawned, `--uninstall`), Arch
(pacman, Node 26 without corepack), Fedora 42 (dnf, Node 22 without
corepack), openSUSE Tumbleweed (zypper, no awk at first, `nodejs24`,
and once Node from nodejs.org). Each built, linked `oraknid`, ran
`doctor`, and ended with a pairing code; reruns updated. Not tried: the
systemd path from the script (no systemd in the containers; the unit
is unchanged and was tested in Phase 1), a real boot under OpenRC or
runit, and the `curl | sh` form before it reaches `main`.

Later (2026-10-03): `oraknid doctor` asks for `oraknid install` only
when no service is installed: each service manager says what its own
state needs (nothing for an autostart entry that is there; linger,
`rc-update` or a link otherwise), and installing with one manager
removes another's service first (an autostart entry, then runit);
`oraknid uninstall` removes every kind found. Tested in
`services.test.ts` and `systemd.test.ts` with stand-in commands. The
systemd path of `install.sh` was tested on 2026-10-03 under `systemd-nspawn` (ADR-036 → As built); before that it was not tested in a container: a
container booting systemd needs host access that is not allowed on this
machine without the owner's yes (`CLAUDE.md`); the unit is unchanged
since Phase 1.

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

### M13.11 — Several repos and servers, each with its role ([[ADR-042-Several-Repos-And-Servers]])
- [x] A project of several repos: found in its folder, each with its name, branches and GitHub link (migration 0031 moved the single link into a one-repo project's repo)
- [x] Jobs across them: a worktree and branch per repo touched, checkpoints, commits, checks, merges and pushes per repo; tasks side by side with a folder of worktrees each and an all-or-nothing merge across repos, redone on conflict (2026-10-03, ADR-042 → As built)
- [x] Servers with a role in each project
- [x] The Eye picks the server I name and asks to confirm; otherwise asks with my servers and Add a new server; production always confirmed

Tested (M13.11, 2026-10-03): `pnpm check` green. Daemon
(`apps/daemon/src/eye/several-repos.test.ts`, real git repos in temp
folders, a stand-in GitHub with bare repos; nothing called the real
GitHub): a folder holding `web/` and `api/` added as a project of two
repos with their branches; a job whose first task touches both commits
`feat(web): …` in one and `feat(api): …` in the other, its second task
`feat: …` in api only; its edit in `web/` outside its scope put back,
never committed, kept in the trash under `web/`; the task's diff with
`web/` and `api/` paths; the result listing each repo; rollback of the
second task taking back api's file only; Merge merging each into its
`dev`, my checkouts untouched. Repos found again (`apps/admin`), a new
empty one added, a folder that isn't a repo refused, one taken out; a
one-repo folder staying one repo, then made several by adding the repo
inside it. The Eye asking once for both repos' links (`repo:api`,
`repo:web`), the gh check becoming `oraknid github-repo --repo api` and
`--repo web`, `push` with `repo: "web"` and `repo: "api"` landing each
job branch on its own bare repo at the same commit, an unnamed push
refused by the tool; the built-in checks with `--repo` and `--repo=`.
An older database's single link moved into its repo (migration 0031),
a shadow project left with none. Servers: "Deploy the site to
production" asking only "Deploy to production, vps-2?" (Yes
recommended) and the Leg told which server is the job's; no server
named: the project's by role (production last), my other one, Add a
new server, Go on without; Add a new server waiting until a server is
added through the API, then asking again with it recommended, saved
with the role I chose; production confirmed as the only server; a
plain only server used without a question. All earlier daemon tests
pass unchanged but two that wrote the project's link straight into the
database (now into its repo). Web (`project-repo.test.tsx`): the Repo
tab with two repos (the list, a section and link card per repo, the
linked one's GitHub read for it alone), Add a repo and Find repos;
a one-repo project as before; the servers card's roles, production
marked, a role and a mark saved. By hand on a sample daemon (fake OS,
a scripted Leg, a stand-in brain and GitHub, its own data folder,
port 7561, stopped after) in headless Chromium at 1440 and 390 px: the
Repo tab of `site` (api, web; web's GitHub repo), Settings with roles,
the job's Result per repo, The Eye's server question with options, Add
a new server's link and waiting question, `/servers?add=1` opening the
dialog; nothing wider than the screen.

Open items closed (2026-10-03): the servers card at 390 px (the name no
longer cut, the role field as wide as its word), renaming a repo and
changing its branches (`projects.updateRepo`, the Repo tab's pencil),
New work's GitHub account picker for a new repo, `g` swallowing the
next key (`g r` on Mail no longer replies), the helper hearing when a
highlight fails (`helper.shown`) and stepping aside for a dialog, the
code colours checked at AA in both themes, and a sweep at 390 px
(ADR-038, ADR-040, ADR-041, ADR-042 → As built). Tested: `pnpm check`
green; daemon (`several-repos.test.ts`: rename, branches, refusals, a
one-repo project's branches; `lock.test.ts`: home only;
`helper.test.ts`: a failed highlight in the next round's prompt); web
(`go-prefix.test.ts`, `project-repo.test.tsx`, `work.test.tsx`,
`helper.test.tsx`, `code-colours.test.ts`, `help-map.test.ts`). By hand
in headless Chromium on a sample daemon (fake OS, a scripted Leg, the
stand-in GitHub with two accounts, a stand-in mail server, its own data
folder, port 7587, stopped after) at 1440 and 390 px, dark and light:
43 pages and tabs (Overview, every project tab, Repos with a file, a
commit list, branches and pulls, every server tab, Mail, every Settings
tab, New work, Inbox, Legs, Chats, Skills, Logs, Docs) with nothing past
the right edge and no page errors; `g r` and `g c` on Mail; the servers
card; a repo renamed and its work branch changed, a bad branch refused
in the dialog; the account picker choosing `work`; a highlight that
failed shown failed with why; a highlight into a mail account's settings
dialog, the panel aside and back once the dialog closed; the code's
rendered colours (lowest 6.09:1 on the well). Found by hand and fixed:
the repos card cut a repo's GitHub column to "not on…", and the ring's
note ran its two sentences together.

### M13.12 — What runs on a server ([[ADR-043-Server-Insight]])
- [x] Docker containers, images, volumes and compose projects; databases; the reverse proxy and its sites; traffic; logs live
- [x] A server's page in tabs; restart a container or a service, asked first; the helper reads it all
- [~] SQLite files from the state document, and sizes inside containers: not read yet. ADR-044 (M13.13) now keeps a database's credentials, per backup plan, but Databases doesn't use them; a SQLite file is backed up by describing it in a plan. The light reading every few minutes became a part of every discovery

Tested (M13.12, 2026-10-03): `pnpm check` green. oraknid-monitor
(`apps/daemon/src/servers/monitor.test.ts`): the real script under `sh`
with stand-in docker, systemctl, ss, nginx, openssl, journalctl, sudo
and pgrep printing what a real Debian server prints, and the server's
files under a root of their own: containers with health, uptime, CPU and
memory (MiB and GiB to bytes), a name with quotes, `<no value>` as no
project, images in use, volumes mounted; Docker's socket refused said
with the docker group (in the databases part too); Debian's
`postgresql.service` left out for its cluster, versions from psql and
redis-server, the port only when listening, a size only when readable;
nginx -T with an upstream block, a redirect, two blocks of one name, a
comment, a certificate ended in 2020 and one not readable; Traefik's
routes from labels; the last 15 minutes of two access logs (combined, and
harvest's own with no client), a line 40 minutes old out, a garbage line
counted, queries dropped, a log not readable said with its owner;
connections per listening port; a log's last lines, a search, a source
refused (`;`, a relative path, `..`); a followed log ended by closing its
input with nothing left running. Daemon (`servers/insight.test.ts`,
through the stand-in SSH server with stand-in tools): the state
document's discovery has the containers and sites; each part through
the API, a second read within 20 s served from memory and `fresh` asking
the server; log sources, a search, the journal's header dropped; a log
followed on `/live` until `logs-close` and its process gone on the
server, a fifth at once refused; restart without `confirm` refused, home
only for a standard device, a container restarted, an unknown one and a
service without root refused in words, both attempts audited. The helper
(`helper.test.ts`) reads Docker, databases, the proxy, traffic, the log
sources and a searched log as untrusted data. Web
(`components/server-insight.test.tsx`): the eight tabs in order;
containers by compose project, Restart asking first and doing nothing on
Leave it running; Docker's refusal shown; a database, a site with its
certificate red five days before its end, the traffic and an unreadable
log; a log followed, stopped when another is picked or Follow is turned
off, then searched on the server; every new `data-help` id in the help
map (`help-map.test.ts`). On the real staging server, read-only (the new
script copied to `/tmp`, run once, removed; nothing installed or
restarted): every part valid JSON under dash and mawk and read by the
contracts — 19 containers, 46 images (28 unused), 3 MongoDB containers,
37 nginx blocks as 19 sites, 6 certificates (two already ended),
`nginx -t` ok, 104 requests in 15 minutes from two access logs; a
followed container log stopped with nothing left running. By hand in
headless Chromium on a sample daemon (fake OS, its own data folder, a
stand-in SSH server, port 7541) at 1440 and 390 px: every tab, the
restart dialog, a log followed live and scrolled to its end, traffic
bars and tiles; no page errors, nothing wider than the screen. Found by
hand and fixed: a database process inside a container showed twice; the
log picker squeezed the search on a phone.

### M13.13 — Scheduled, encrypted backups ([[ADR-044-Backups]])
- [x] Backup plans per database (Docker or not): schedule, destination (this computer or another server), retention, credentials in the keychain
- [x] Encryption with age: keys made and kept in the web interface
- [x] Runs recorded, failures notified, Verify; Restore always mine
- [x] The helper sets plans up, runs and verifies them

Tested (M13.13, 2026-10-03): `pnpm check` green, the Docker tests run.
Daemon, real dumps (`apps/daemon/src/backups/backups.docker.test.ts`):
throwaway PostgreSQL 16, MariaDB 11, MongoDB 7 and Redis 7 containers
(passwords required even from inside), reached through a stand-in SSH
server whose commands run here; every process's command line watched
every 2 ms during each dump and restore never held the password, nor
did the commands sent over SSH or the events. PostgreSQL: encrypted
with a new age key to this computer (age header, no plain text,
checksum, size, no `.part` left), verified, restored into a fresh
container under another name, the two-step token refused with the
wrong word and once used; a wrong password and a missing container
fail in words, notify ("Backup failed: …"), leave no file. MariaDB:
streamed to a real sshd in a container as a second server, three runs
with a count of two (the oldest gone from that server, files 600),
verified, a lost row restored. MongoDB: archive, verified, no password
file left in the container, restored into a fresh one. Redis: BGSAVE
and its RDB, verified, restored into a fresh container that came back
with the key. Without Docker (`backups.test.ts`): SQLite on the host,
encrypted, pruned by count, verified, a changed byte and a missing
private key caught, restored; keys made, exported once, imported,
kept while needed; a missed run with a fake clock (Oraknid off at
03:30, back at 09:00: one *missed* run, said so; then a scheduled one;
paused, none); the helper's confirmations and its lack of a password,
a private key or a restore; away-from-home rights. Core: schedules and
cron lines, retention. Web (`backups.test.tsx`): the plan form with a
found database, a cron line, a server destination and a password; one
on the host; an edit keeping the kept password; a key's private half
shown once and never again; Restore in two steps. Help map: every new
id in the screens. By hand on a sample daemon (temp data dir, free
port, stand-in keychain and SSH, a throwaway Postgres): Settings →
Backups at desktop width and at 390 px (no sideways scroll), the plan
form, a failed plan's error, Verify's result, the restore's second step;
after merging ADR-042 and ADR-043, a server's Backups tab on a set-up
server offering the databases `servers.databases` found (a Postgres
container picked fills its kind and name) at desktop and 390 px; a web
test covers that mapping.

### M13.14 — The Eye speaks up ([[ADR-045-The-Eye-Speaks-Up]])
- [x] Task done, task left out, job done (a summary), blocked, a needed request denied: one moderate message each in the project's conversation (also waiting, stopped, a folder put back); the job's summary on the quick model, the rest written by Oraknid; shown as a line, a card and notes
- [x] Every question's options say what they do; "keeps going wrong" in plain words; a denial says its consequence before and after
- [x] GitHub without fuss (after the piano job): merge and push are Oraknid's steps at the end; the job folder stays a worktree (`.git` changes refused, checked after each session); Oraknid's own checks never asked about

Done 2026-10-04 (ADR-045 → As built; Jobs-and-Projects → Ending a job,
As built). A job may now go from `waiting` back to `verifying` (its end
steps waiting for the repo question). Tested: `pnpm check`'s lint and
types green; the web's 109 tests and the daemon's 366 pass, two daemon
tests (`startup.perf.test.ts` (run on its own after the suite: `pnpm check` → `test:perf`), `faults.test.ts`) and one web test
(`project-repo.test.tsx`) failed only under load beside another agent's
runs and pass alone; new: `eye.test.ts` (seven: the Leg's own-check
answered, `.git` commands refused, a separate repo put back, the
messages per event, one blocked message, a denial before and after,
"keeps going wrong" answered in the conversation), `questions.test.ts`,
`brain.test.ts` (prompts and the ending), `project-links.test.ts` (merge
and push at the end against the stand-in GitHub and its bare repo),
`git.test.ts`, the policy's and the pack's tests in core,
`eye-report.test.tsx`. By hand on a sample daemon (fake OS, scripted
Legs, stand-in brain; its own data folder and port, stopped after):
a job of two tasks said two lines and a card; a follow-up's task kept
going wrong, asked in the conversation, answered "Leave it out" there:
the note named the task that went with it, and the card listed both as
left to me; at desktop width and at 390 px (the conversation, the
question's options, the inbox).

### M13.15 — Cloud storage ([[ADR-046-Cloud-Storage]])
- [x] Providers through rclone: Google Drive, Dropbox, MEGA, S3-compatible (every rclone provider since M13.16); the pool with upload, download, move, delete; automatic or chosen placement
- [x] Backups to cloud storage, and downloaded from the web page
- [x] The helper and the guide

Done 2026-10-04 (ADR-046 → As built, ADR-044 → As built). Tested:
`pnpm check` green; daemon against a real MinIO in a throwaway
unprivileged container and a real rclone (`cloud.docker.test.ts`: adding
it with every process's command line watched for its secret, none in
events, views or SQLite; the config unreadable by rclone without the
keychain's password; upload with progress on `/live`, listing across
two providers, search, a one-time download, rename, a move across
providers, a folder renamed and deleted; placement by free space,
priority, a picked provider, pay as you go, a limit; too big refused
before a byte; SQLite backups to the pool and to one provider with
retention, Verify and downloads as stored and decrypted; a provider in
use kept), with a stand-in rclone (`cloud.test.ts`: Google Drive's and
Dropbox's sign-in through `rclone authorize`, MEGA's password through
stdin, home only, the helper's limits), `@oraknid/core` placement; web
(`cloud-storage.test.tsx`: providers and the add dialog, Drive's
sign-in, the pool, an upload's progress and a refusal, a backup's
download). Checked in a browser on a sample daemon (its own data folder
and port, MinIO in a container, all removed after) at desktop and at
390 px.

### M13.16 — Every rclone provider, and a backup form that helps (2026-10-04)
- [x] Cloud storage: every provider rclone supports, forms made from its schema, search by name ([[ADR-046-Cloud-Storage]] → Changed; As built M13.16). rclone's `config providers` read once per version (55 backends offered with v1.75.1); **Another provider** in Add a provider: a search, then a form made of the backend's schema (its service first, required options, the rest under Advanced, typed, secrets as password fields); browser sign-in through `rclone authorize` for the 14 that have it; rclone's own setup questions (OneDrive's drive, a code) asked one at a time, answers in its environment. Short forms for Drive, Dropbox, MEGA and S3 kept.
  Tested: the schema and the form model against the recorded output of the real rclone v1.75.1 (core); SFTP (atmoz/sftp in a throwaway unprivileged container) and WebDAV (`rclone serve webdav`) added through the generic path with the real rclone, a file up, listed and down, passwords on no command line while adding and uploading (`/proc` sampled), nor in views, events or SQLite; OneDrive's sign-in and questions, a two-factor code, a failing and a cancelled setup with a stand-in rclone; the web picker, required vs Advanced, S3's services, password fields and questions (component tests); by hand on a sample daemon (its own temp data folder, a free port, a WebDAV provider added from the form) at desktop and 390 px, all stopped and removed after.
- [x] Backups: Test connection, editing keeps every value, a picked database fills the form, each kind's fields under Advanced ([[ADR-044-Backups]] → Changed, → As built 2026-10-04). Edited values were lost because one unkeyed form served New and every Edit (React kept the open one's values), and a patch's `enabled` default switched paused plans on.
  Tested: against throwaway unprivileged containers (postgres:16, mariadb:11, mongo:7 with a user in its own authentication database, redis:7 with an ACL user, MinIO) through the stand-in SSH server: Test connection ok for each kind and each failure said in words (a wrong password, a wrong authentication database, a missing database, sslmode and Redis TLS the server doesn't speak, a server that doesn't answer, a folder on this computer and on a server it can't write); the advanced fields in the dump commands, with a backup and Verify per kind (PostgreSQL's custom format restored with pg_restore into another database); a MongoDB connection string kept, tested and used; logins read from containers' environments with no password value; no secret on any command line (/proc sampled every 2 ms), in what crossed SSH or in the events. Web tests: a saved plan opened after New (the old bug, failing without the fix) shows every value and saves unchanged; Test connection's parts and picking a listed database; a found database fills user and database and says a password is set; each kind's Advanced fields sent. The test containers' watcher removed them after the runner was killed with SIGKILL. Checked in a browser on a sample daemon (its own data folder and port, an in-memory keychain, a throwaway PostgreSQL, all removed after): Edit after New shows the plan's values, Advanced and Test connection, at desktop and at 390 px (headless Chromium, no sideways scroll).

### M13.17 — Jobs named by what they are (2026-10-04, [[Jobs-and-Projects]] → A job's name and description)
- [x] A proper name and a description when a job is made; what it did when it ends; shown everywhere; rename ([[Jobs-and-Projects]] → A job's name and description, As built). Migration 0035; `nameJob` on the quick model with its rules checked; `eye/naming.ts` names a job made, describes one ended from The Eye's report, waits for a model and tries again, names older jobs at start (quick model only, 5 s apart); `jobs.rename` (allowed away from home, like the job's other edits); `job.named` relayed to the Overview.
  Tested: `naming.test.ts` (from my message: named, then what it did; a typed name kept; rename kept through the end; no model: the first line, named once a model is back; a draft named again after typing; the backfill), `brain.test.ts` (the call on the quick model, a markdown answer sent back, the backfill refused without a quick model), web `job-heading.test.tsx` (rename, the folded goal, Work's row, the Workflow's box). By hand on a sample daemon (fake OS, a scripted Leg, a stand-in brain, its own data folder and port, stopped after) at 1440 px and 390 px in headless Chromium: Running now, Work, the header with my goal opened, a rename shown live, the Workflow's boxes with their tooltips, the Inbox's job line, the palette, a job made without a model named once one came back; no sideways scroll, no console errors.

### Fixes after M13.17 (2026-10-04)
- [x] **Open folder** and **Terminal here** in a project's header: its folder in this computer's file manager, and a terminal started in it (the target `project:<id>`, never a path; [[ADR-028-Terminal]] → Extended).
  Tested: `term.test.ts` (a terminal in a project's folder by its id only, its folder opened, a project that isn't there opens nothing).
- [x] A Leg's write outside its folder is refused, not asked; its own `/tmp` and its home for the job are its to write ([[Approvals-and-Autonomy]] → Writing outside its folder).
  Tested: `policy-drift.test.ts` (edits inside the worktree and its scratch space allowed, elsewhere refused without asking).
- [x] GitHub branch checks look at the repo's real branches (those the task names, else its work branch); a bad `oraknid github-branch to` is repaired ([[ADR-038-Project-Accounts]], [[The-Eye]] → A check that is wrong).
  Tested: `builtin-checks.test.ts` (the branches named that the repo has, the work branch otherwise, a check on a missing branch repaired).
- [x] Reading the project's own repo on GitHub doesn't make a task untrusted (BR-5, [[Approvals-and-Autonomy]] → Reading the project's own repo).
  Tested: `own-repo.test.ts` (the repo's page, its API and its raw files, and nothing else).
- [x] A job whose checks fail and can't be replanned is blocked, not left verifying ([[Core-Entities]]).
  Tested: `states.test.ts` (`verifying` → `blocked`, and back to `running`).
- [x] The site stays the site on a paired device ("Open your Oraknid"); the loader, when my daemon can't be reached, says Oraknid runs on my computer and keeps retrying, with links to the site and the guide on a public Nest ([[ADR-033-Product-Site]] → Changed, [[Nest-Protocol]]).
  Tested: no automated test; still to try by hand on a paired phone with my computer off.
- [x] A server's key made again when ssh2 writes an ed25519 key malformed (about one in two hundred) ([[ADR-026-Servers]] → Fixed).
  Tested: `keys.test.ts` (2,000 keys made, each read back).
- [x] Linger checked before it is asked for, a refusal a warning with the command; doctor tells passt missing from passt unable to make a network here ([[ADR-036-One-Script-Install]], [[OS-Integration]]).
  Tested: `systemd.test.ts` (linger already on left alone, a refused linger a warning); the systemd path in `systemd-nspawn` (ADR-036 → As built).
- [x] Doctor's install hints name this system's package manager and package (apt, dnf, pacman, zypper, apk) ([[OS-Integration]]).
  Tested: `doctor-hints.test.ts`.
- [x] `install.sh --dev` installs the `dev` branch; `install.sh` installs rclone (recommended: a failure only warns) ([[ADR-036-One-Script-Install]]).
  Tested: the README's one-liner, `curl … dev/install.sh | sh -s -- --dev --no-service`, run on a fresh Debian 12 (a plain unprivileged container, 2026-10-04): it installed the packages, rclone among them (Debian's 1.60), cloned `dev` at its newest commit (5d3873d), built, linked `oraknid` and ran `doctor`. That run found `doctor`'s install hints naming `pacman` on Debian, fixed (`doctor-hints.test.ts`).
- [x] Test containers carry their test process's id as a label and are removed by a watcher once it is gone, however it ended.
  Tested: the runner killed with SIGKILL, the containers removed (M13.16).
- [x] The startup timing test runs on its own after the suite (`pnpm check` → `test:perf`), its stalls judged against the machine's own ([[Checkpoint-1]] → B1-04).
  Tested: `pnpm check` runs it after `turbo run typecheck test`; two races in `naming.test.ts` and `rclone-provider.test.tsx` made deterministic with it.
- [x] A folder that isn't a git repo, chosen for a new project, is said in words (what to choose), not as an unknown error.
  Tested: `layer2.test.ts` (a plain folder throws `NotAGitRepo`); `term.test.ts` (`projects.create` on a plain folder is refused with its message in words, not as an error inside Oraknid).

### M13.18 — Servers that are easy to add and fix (2026-10-04)
- [x] A key given as its file first, pasting second, in a dialog a long key can't stretch ([[Servers]] → Adding a server). The add dialog: a box to choose or drop the key file showing its name and what was read ("id_ed25519 · OpenSSH private key", a passphrase seen in its header); **Paste it instead** opens a fixed box (`field-sizing-fixed`, `wrap="off"`, scrolling both ways) in a one-column dialog (`grid-cols-[minmax(0,1fr)]`); `lookAtKey` says a public key or a text that isn't a key in words, and the form can't be saved with one.
- [x] **Test connection** in the add and edit dialogs ([[Servers]] → Testing the connection): `servers.test`, the form as it is, nothing saved, 10 s; with a server's id the kept credentials and its pinned host key; `uname -sr; uname -n` and the fingerprint, or why not in plain words. `sshWords` moved from the backups to `servers/ssh.ts` and learnt a key's own failures (a passphrase needed or wrong, a public key, no key). Home only for a standard device.
- [x] **Edit** a server: everything ([[Servers]] → Editing a server). `servers.update` takes host, port, user and new credentials (stored as `add` stores them, the old ones deleted); a new address clears the pinned host key and oraknid-monitor's hash; a new password makes it `setup: new` again; its connection is dropped. **Edit** in a server's header, **Fix the connection** under its error, **Can't connect: fix it** on a project's servers; the old inline name-and-description form is gone.
- [x] **Fix wording**, reusable ([[Chats-and-Helper]] → Fix wording): `text.polish({text, kind})`, one call on The Eye's quick model (`polishText`, `polish-text` a quick call of 2 min at most), from an empty folder of Oraknid's; no model said plainly. The web app's `PolishButton` on any textarea, with Undo in the toast and next to it; first on a server's description.
  Tested: `servers/edit.test.ts` (Test connection with a password, a wrong one, a key with its passphrase missing, wrong and right, a public key, a closed port, nothing saved; the kept credentials of a server and its pinned host key; `servers.update` fixing a wrong port, user and password, the host key cleared, a key replacing the password, a passphrase alone, a rename keeping the rest, a key and a password refused together; `sshWords`), `eye/polish.test.ts` (the text and its kind to the quick call, the answer trimmed, no model said plainly), `lock-doc.test.ts` (`servers.test` home only, in API-Contract); web `add-server.test.tsx` (the key file by default, then added with it; pasting in a fixed box, a public key refused, a passphrase asked for; Test connection's answer shown and cleared by a change; edit prefilled, Test with the kept credentials, only what changed saved; Fix wording and Undo; no model in a toast; `lookAtKey`).

### M13.19 — A new project that says what it does (2026-10-04, [[Jobs-and-Projects]] → Making a project, [[ADR-034-Projects-First]] → Changed)
- [x] New project asks the name first, then where it comes from: **New** (the default: a folder named after the project, made a git repo, in a parent chosen with the picker, the last one used offered; a new GitHub repo too when connected, private by default, on the account picked), **A folder on this computer** (it is the project; the not-a-repo question stays), **From GitHub** (one of my repos from a searchable list of every account's or one's, cloned through the account that lists it; or a link, which without an account works only for a public repo, and says so). A sentence under the form says what will happen with the real paths, or what is missing; **Create project** waits for it. One form (`components/new-project.tsx`) for New project and New work's "A new project…" (where a plain folder is still made a repo); `newProjectSource` and New work's own source picker are gone ([[Web-UI]] → New project).
  Tested: web `new-project.test.tsx` (the name first, New chosen with the last parent, the sentence, `createFrom` with `new-folder`; a new private GitHub repo said and sent; a folder chosen with the picker, said, the not-a-repo question then `initGit`; one of my repos found by search, said, sent with its account; a link without GitHub, the public-only line, `git-url`; the folder name from the project's name; the account picker as before).
- [x] **The folder picker**: `files.folders({path?, showHidden?})` lists one folder's folders on this machine (my home by default, `~` taken), by name, repos marked, links followed and marked, broken ones left out, one it may not open listed unopened, at most 1,000; a missing path, a file or one it may not read refused in words; `files.makeFolder` makes an empty one. Folders only, never a file. Same token as every call; home only for a standard device, like `createFrom` ([[API-Contract]]). `FolderPicker` (breadcrumbs, Up, Home, New folder, Show hidden, a git badge, a typed path, Choose this folder; opens at home saying why when its start is gone) and `FolderField` / `FolderPickerButton`, used by New project, New work and a backup plan kept on this computer ([[Web-UI]] → The folder picker). `projects.createFrom` takes `~/…` for my home too, as the picker's typed path does.
  Tested: `folders.test.ts` (folders only and sorted, `.git` folder or file, hidden ones counted, `~`, `/` has no parent, a link listed and a broken one left out, missing / a file / not a full path refused, permission denied said and listed unopened, a new folder and one that exists; through the API: 401 without a token, a listing, a missing path in words, `makeFolder` and a name that climbs out refused), `lock-doc.test.ts` (API-Contract names the two home-only calls); web `folder-picker.test.tsx` (home, into folders, the git badge, breadcrumbs, choose; up and home; a locked folder disabled; a start that's gone; a typed path, wrong then right; a new folder made and opened).

### M13.20 — Updates from inside Oraknid (2026-10-04)
- [x] install.sh records what it installed (`<dir>/.oraknid-install.json`: ref, channel, commit, version, when, from where, the service), kept out of git; a commit the checkout has is checked out without fetching; no pairing code in an update's log; an install by v0.1.0's script, without a record, is told to run it once more ([[ADR-048-Updates]], [[ADR-036-One-Script-Install]] → As built).
  Tested: `install-script.test.ts` runs install.sh's own `fetch_source` and `write_record` on real git repositories in temp folders: `dev` is the dev channel at dev's commit, a release's tag the stable channel with its version, `--no-service` recorded, a quote in a path still valid JSON, the record not a change in the checkout, a commit checked out with the repository it came from gone; an install without a record known by its `.tools/` kept out of git. The same functions run under busybox sh (Alpine 3) and dash (Debian 12), in plain unprivileged throwaway containers: the record written, a quote in a path escaped, a commit checked out without its repository.
- [x] An updates service: script install or clone, GitHub's releases with ETags every six hours and on Check now, stable (releases) and dev (pre-releases and new work on dev) channels, quiet offline; Update now with the database copied first (three kept), install.sh run apart from the daemon (a transient `systemd-run --user` unit under systemd, its own session otherwise), a failed update rolled back; refused while jobs run unless confirmed; full rights away from home; `oraknid update` and `--check` ([[ADR-048-Updates]]).
  Tested: `updates.test.ts` (semver's order; drafts and pre-releases per channel; new work on dev from the compare; a clone with no Update now and no checks on its own; the ETag sent again and a 304 keeping the list; offline and rate-limited in words, never thrown; one notification per version; full rights away; "2 jobs are running" refused, then confirmed; the script's arguments per channel and without the service; detached or `systemd-run`, and systemd-run's failure said; the database copied and pruned to three, the copy readable; running, interrupted and succeeded read back, told once after the restart); `install-script.test.ts` runs the update script for real against the miniature repository (the new version's install.sh used, a failing release rolled back to the commit before with its record restored, a release that can't be fetched leaving all as it was, with this version's script); `api/updates.test.ts` (the CLI and a device at home update; a standard device away from home reads but is refused, then allowed with full rights; one running job refused until confirmed); `notify/router.test.ts` (the desktop notification, no email).
- [x] The web: the version and an update in the sidebar's foot, a line on the Overview, Settings → About & updates with the notes, Check now, Update now with its confirm, the progress across the restart and Reload the page; notifications settings list "A new version of Oraknid" ([[Web-UI]] → Settings).
  Tested: web `updates.test.tsx` (up to date, a release with its notes and Update now, the dev channel with a pre-release and new work on dev, a clone saying to use git with no button, away without rights and offline saying why, running, restarting, updated with Reload, rolled back), `help-map.test.ts` (the new tab and controls). By hand on a sample daemon (its own temp data folder, a free port, a stand-in GitHub, an install record in a temp folder; stopped and removed after) in headless Chromium at 1440 px and 390 px: About & updates with a pre-release's notes and new work on dev, an update running with its log and the database's copy, the sidebar's foot; no sideways scroll, no console errors. No update was run on a real install.

### M13.21 — The Eye plans a graph, asks once, and listens (2026-10-04)
The piano job (a new project, one goal: a React piano with sounds, an oscilloscope and a synthesis tool) showed the flagship broken: the interview ran twelve rounds over 45 minutes on a free model (OpenCode · big-pickle), asking the visual direction five times; "start now, the interview is over", written twice in The Eye's chat, was read as new work and made fifteen tasks (two of each, no dependency at all) while the round stayed open in the inbox for fifteen minutes; and since tasks existed, the planner never ran.
- [x] The Eye's own thinking on its strongest model ([[The-Eye]] → The Eye Leg): plan, replan, interview, new work planned into The Web and my message while the job waits on me or has no plan go to my chosen model, else the pool's strongest (`strongestFirst` in `eye/brain.ts`: rated for hard work, then planning strength, then proven), never the cheapest that fits; `triage` and `triage-open` are named as their kinds now (the call was `talk`, which had no kind).
- [x] An interview like a person's ([[Skills]] → The interview): at most 3 rounds (`settings.interviewRounds`, Settings → The Eye → Interview), at most five questions that block planning, recommended options, the rest **assumptions** (`InterviewRound.assumptions`) said in the playback and kept as The Eye's decisions; each round given every question asked with my answer and what is decided (`eye/interview.ts`); a question that means the same as one asked, or another in the round, dropped before the round opens (`freshQuestions`, `packages/core/src/likeness.ts`), and a round with nothing new not asked; "enough, start", "start now", "that's all" end it, in the inbox, the draft or the conversation (`endsInterview`), a question with a recommended answer then assumed.
- [x] Talking while a question is open ([[The-Eye]] → Talking to The Eye): the triage gets the open items with their ids and says whether my message answers one (it is answered with my words, my message recorded as its answer), ends the interview, or is about something else (it stays open; one line says what is still waited for); words that end the interview end it without a model.
- [x] Tasks from chat never bypass the planner: before a plan, new work is guidance for it (Silk); on a running job it is planned into The Web by `extend` with dependencies on the tasks there, once per message, never what is there already; the job plans once through the planner whatever wrote tasks before (`eye/web-store.ts`, `eye/talk.ts`).
- [x] Plans are graphs ([[The-Eye]] → Planning): the prompt asks for dependencies and phases (`PlannedTask.phase`); the same work twice or no dependency where order matters is sent back once (`graphProblems`); `shapeWeb` merges duplicates, orders phases, drops unknown, self and circular dependencies, and as a last resort orders setup and research, the work, then integration and tests; what it mended said in Silk. The Workflow tab draws the edges as before.
  Tested: `eye.test.ts` → "the piano job, replayed" (a brain that asks again in other words: the repeat dropped; "start now, interview is over" in the chat while round 2 is open: the round answered by my message, word for word, no model asked, no task from talk, planning once; the plan of that day, duplicates and no edges, stored as a graph of five tasks, setup and research first, integration last; "Add a metronome" on the running job: one task after the keyboard, and asked again, "That's in the plan already"); an open question answered in the chat through the triage, and an unrelated message answered with "still waiting"; the interview's tests (nothing new left ends it; at most three rounds, then the playback with what it assumed; Enough assumes the recommended answers); `brain.test.ts` (a Claude and an OpenCode free model in the pool: the interview and the plan on Claude Opus; failing without the fix); core `likeness.test.ts` (the day's repeated questions caught, different ones kept, the ending words) and `web.test.ts` (`sameTask`, `graphProblems`, `shapeWeb` on the day's plan, phases, circles).

### M13.22 — Agents that get simple work done (2026-10-04)
The flagship failed painfully simple work. On a fresh install (Claude Max signed in and healthy, OpenCode 2.0.20 with its 14 free models, Antigravity rate-limited), one research task ("Research audio helper libraries for low-latency Web Audio synthesis") took seven attempts in twenty minutes: routing gave it to OpenCode's free models over Claude Sonnet ("right size for the task, capability 3.0/5, quota cost ×1.0"); big-pickle wrote `docs/audio-libraries-recommendation.md`, the very file its check tested, and D1 called it out of scope, put it back, reset and reassigned; then "Internal server error" and "Model is unavailable" were counted as the task failing, each sending it to the next untried free model of the same provider; OpenCode's writes to its own temp folder were refused four times. On an earlier project, OpenCode failed simple git commands, and once ran `git init`.
- [x] **Git in a job's worktree, inside the sandbox** ([[Sandboxing]] → Git in a job's worktree, [[Security]]). Root cause: the worktree's `.git` is a file pointing into the project's `.git`, which the sandbox never bound: every git command said `fatal: not a git repository: (null)`; with the binds, a commit then said "Author identity unknown" (the sandbox's home is the job's) and `packed-refs.lock` couldn't be made. `gitBinds` (packages/os) mounts the project's `.git` as a throwaway tmpfs holding its entries (objects, refs, logs and the worktree's own folder writable; config, hooks, packed refs read-only; the worktree's `.git`, `commondir`, `gitdir` read-only on top), for every sandbox whose folder is a worktree (several-repo job folders too); `gitEnv` gives `safe.directory=*`, no auto gc or maintenance, and my identity when the project names none. The policy already let everyday git through; now it also runs.
  Tested: `sandbox-git.test.ts` (in bwrap, in a worktree of a temp repo: `status`, `diff`, `add`, `commit`, `log`, `switch -c`, `switch`, `stash`, `branch -D` of its own branch, the commits seen from outside on the right branches; the project's config, hooks, the `.git` link and `commondir` unwritable, a `commondir` and `info/attributes` written in the layer never reaching the project; the binds found for a worktree and for a job folder of two repos; failing without the fix with "not a git repository"); `opencode.test.ts` (the real OpenCode, its model a stand-in, in the real sandbox in a job: `git status`, `add`, `diff --cached`, `commit`, `log` run and succeed, the Leg's commit on the job's branch, no classifier, refusal or question); `policy-drift.test.ts` (18 everyday git commands allowed at every autonomy, untrusted or not; push, merge, deleting `main` still asked, a force-push refused).
- [x] **Routing: known before unproven** ([[Legs-and-Capability-Profiles]] → Known and unproven models, [[The-Eye]] → Routing). A profile's `prior`: free models (`-free`, `big-pickle`, `:free`) and unknown names are `unproven` (strengths 2, `free` for the free ones); known families are recognised by name through OpenCode's providers too. `trust` replaces "success after three attempts": the prior counted as earlier attempts (a known model as three at 70%, an unproven one as one at 40%), `(rate − 0.7) × 5`, said in words in the routing record. Quota cost is unchanged: Sonnet's ×2.0 no longer loses to an unproven free model.
  Tested: `routing.test.ts` (the live pool of 2026-10-04 gives the medium research task, and medium implementation, to Sonnet, saying "unproven: no task seen done yet" of the free models; a free model with four research tasks done gains more than 1.5, one failure costs it more than it costs Sonnet; free models still work when Claude's window is kept for hard tasks); `profiles.test.ts` (the priors, the families by name, my override vouching for one).
- [x] **Provider failures rest the model, not the task** ([[Legs-and-Capability-Profiles]] → Provider failures). `providerFailure` reads a session's error: a model gone (30 min) or a 5xx (5 min) rests the model, an account's error (15 min) or the Leg's own program breaking (2 min) the Leg, doubled each time in a row up to four hours; anything else is the task's. The attempt ends `unavailable` (not counted toward the eight, the model's record untouched, the task not told to avoid it); a usage limit too. The registry keeps the rests and each Leg's failures in a row (memory only), `leg.cooldown` and `task.provider-failed` say them; routing leaves a resting model out with the time and reason, takes 1.5 off a Leg's unproven models after one failure and 3 off all its models after two; a job whose every model rests is blocked until the first is back.
  Tested: `provider-failures.test.ts` (the errors of 2026-10-04 and others, each with its scope and rest; the task's own errors; the rest doubling and its cap); `routing.test.ts` (a resting model left out with "resting until 12:05 UTC after a provider failure (Internal server error)"; one failure: not another unproven model of that Leg; two: another Leg); `simple-work.test.ts`, the task's story replayed with stand-in Legs: a 500 on a free model, which rests, the next attempt on Claude Sonnet, both attempts' outcomes `unavailable` and `succeeded`, none counted, the free model's record untouched; two provider failures in a row on OpenCode then Claude though a proven free model is left, "Model is unavailable" resting longer; an error that is the task's still counted.
- [x] **A task's scope holds what its checks name** ([[Drift-Control]] → A task's scope). `taskScope`: the plan's globs, every relative path its checks name (read again when a check is corrected), the files its instructions say it writes, `docs/**` for research and planning; used for D1, the context pack's "You may change only", and what a D1 step puts back.
  Tested: `scope.test.ts` (the task of 2026-10-04: writing its document is no drift, `docs/` open to research, `src/App.tsx` still flagged; an implementation task gets what its checks and instructions name and no `docs/`; paths read from eight commands, quoted patterns and `..` left out; outputs read from instructions); `simple-work.test.ts` (the deliverable written by the task, no `task.drift`, committed on the job's branch).
- [x] **A job's scratch on its Leg** ([[Approvals-and-Autonomy]] → Writing outside its folder, [[Sandboxing]]). A job's home has its own `tmp` and OpenCode database (`opencode.db` and its journal, `repos`); a link an older home had for them is removed. Scratch counts the Leg's own `tmp` and `.cache`. OpenCode's "external directory" asks are allowed (each read or write it then asks for is judged with its path); its sub-agent, question, MCP resource and doom-loop asks are named for the policy, so none waits for a classifier.
  Tested: `job-home.test.ts` (a job's own tmp and database, the login still shared, old links made the job's own, the exact refused paths of 2026-10-04 allowed, the Leg's login, another job's home and my home still refused); `simple-work.test.ts` (OpenCode's asks for its tmp answered yes).
- [x] **Untrusted doesn't stop ordinary work** ([[Security]] → Prompt injection): a task that read the web still edits, writes its scratch, runs its tests and its everyday git without asking; only gated actions ask.
  Tested: `policy-drift.test.ts`.

### M13.23 — Archive and delete a project, with my choices (2026-10-04)
- [x] Delete says it can't be undone and lets me choose what goes: always Oraknid's records (a running job refused, or cancelled first when I tick it); **the project folder** (its path and size, worktrees included; a symbolic link, the root, a top-level folder, home or a folder holding it, Oraknid's data and a folder holding or inside another project's refused; links never followed); **each linked GitHub repo**, deleted with its account's token only when the account owns it, a 403 for want of `delete_repo` said with where to grant it. A folder or a repo asks the name typed. GitHub first, then the folder, then the records: a failed GitHub step keeps the project and its folder, each step reported; `project.deleted` says what went ([[Jobs-and-Projects]] → Archiving and deleting a project, [[ADR-034-Projects-First]] → Changed, [[ADR-038-Project-Accounts]] → Changed).
- [x] Archive moves the project to **Archived projects** (its own section in the list), everything kept, running jobs cancelled first when I say so; I may archive its GitHub repos (read-only there) and delete its folder to free space, offered only when every repo is linked, pushed (compared with the GitHub repo's branches by `git ls-remote`) and clean (no uncommitted change in it or its worktrees, no stash, nothing outside its repos), each reason said otherwise. Migration 0036 adds `projects.archived_with` (repos archived, folder deleted). Unarchive offers to unarchive those repos and clones the folder back from GitHub to the same path in the same layout, its branches made again, progress as `project.restoring`; a clone that fails leaves it archived.
- [x] `projects.removalPreview` (folder size, running jobs, repos with their GitHub repo, ownership and the token's scopes, what would be lost), `projects.delete` and `projects.archive` with their choices, returning each step; all three home only for a standard device ([[API-Contract]]). The web: a **…** menu in the project's header and on each card, the dialogs with their checkboxes, the typed name and the result step by step; Settings' buttons open the same dialogs ([[Web-UI]] → Projects).
  Tested: `removal.test.ts` (dangerous folders refused: the root, a top-level folder, home and its parent, Oraknid's data, a folder holding or inside another project's, a symbolic link; the size not following links; delete with only the records, the folder kept; with the folder, a worktree inside gone and a linked folder outside untouched, the audit event without a token; a folder holding another project's refused with nothing done; two repos on two accounts against a stand-in GitHub, one deleted and one refused for want of `delete_repo`, said plainly, the folder and records kept, the deleted repo's link gone; a repo the account doesn't own never sent a DELETE; archive with a GitHub repo archived and unarchived; deleting the folder refused for an uncommitted file and for commits not pushed on two branches, and for a repo not linked; a clean project of two repos (`apps/web`, `api`) archived with its folder deleted, then unarchived, cloned back from local bare repos in the same layout with its branches, progress events; a clone that fails leaving it archived), `lock-doc.test.ts` (the two calls now home only), `eye.test.ts` (archive and delete through The Eye's project, as before); web `project-removal.test.tsx` (a plain confirm with only the records; the folder's size, the name typed to enable Delete, the GitHub repo and its missing `delete_repo`, each step listed after; the repo's full name typed when it is all that goes; a dangerous folder disabled with why, a running job to cancel first; archive with its repo and folder, the name typed; the folder option disabled with what isn't pushed; unarchive with its repos and the folder cloned back; the Archived projects section, opened on request or when the one shown is archived, each card's … menu), `help-map.test.ts`. Not tried by hand in a browser.

### M13.24 — A chat on each server, and agents that work on it (2026-10-04, [[ADR-049-Server-Chat-And-Server-Jobs]])
- [x] Each server has a project of its own, made with its first message and hidden from the Projects list (`projects.server_id`, migration 0037): its folder `<data>/server-jobs/<id>` with a shadow repo, the server its one server, the built-in `server-work` skill (no interview); a removed server archives it ([[Servers]] → A server's chat and its jobs).
- [x] A **Chat** tab, second on a server's page: the same chat as a project's (`EyeChat` with a server), `servers.conversation` / `talk` / `answer`. With a job going, my message goes to it; with none, `serverTalk` (quick model) answers a question from the state document and the readings without a job (`eye_messages.job_id` may be null), or starts a server job with the server already chosen ([[The-Eye]] → A server's conversation).
- [x] A server job's sessions: the state document, role and production, the alias named with `ssh -F <the job's config>` (ssh never read the alias from `$HOME`), told the place is the server; no Git or GitHub parts. The plan gets the same and the state document; checks `ssh <alias> <command>` run on the server over Oraknid's own connection, for a task and for the job (`servers/checks.ts`).
- [x] Saying what will change: "Approve what will change on <server>" before a plan that changes it, at Supervised and Standard, at Full only on production; a plan of research starts at once.
- [x] Commands on a server judged as what runs there (`servers/remote.ts`): `sudo` there not refused as root here, the never-allowed list kept; production (`servers.production`, the Overview's switch, or a role) asks before anything that doesn't only read, at any autonomy and in every project ([[Approvals-and-Autonomy]] → Commands on a server).
- [x] Afterwards: the state document's new version records the job (`server_states.job_id`) and ends with "Changes by job “…”"; what was read of the server is forgotten; The Eye's job report shows the version, the diff, and the backup plans to look at when data changed; `servers.history` and the State document tab's versions.
- [x] A **Jobs** tab (Work rows and what they wait on), a production badge; `servers.talk` / `answer` / `setProduction` home only for a standard device, `projects.talk` / `answer` refusing a server's project the same way.
  Tested: `server-jobs.test.ts` (a question answered with no job and its project hidden; "install fail2ban": a server job with the server and no repo, "Approve what will change on VPS One", the session's context with the state document, the alias and its place, the check run on the stand-in SSH server, a new state document version naming the job and its change, the report in the server's chat with the diff; production asks before the plan and before `ssh … 'sudo -n systemctl restart nginx'` at Full autonomy), `remote.test.ts` (an ssh read with its options and quotes, what only reads, sudo on the server, production asks), `layer2.test.ts` (three built-in skills), `lock-doc.test.ts`; web `server-jobs.test.tsx` (Chat after Overview, the production switch, a question with no job, my message sent to the server, the Jobs tab with what waits) and `server-insight.test.tsx` (the tabs).

## Exit criterion

I ask for new work on the piano project from its Eye tab and follow it
there to the end, without a job page; a search engine and a visitor
find nothing on my private Nest.

Related: [[Roadmap]] · [[Phase-11-Workspace]]
