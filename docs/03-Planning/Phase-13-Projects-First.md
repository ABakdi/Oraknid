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
tests (`startup.test.ts`, `faults.test.ts`) and one web test
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
- [ ] Providers through rclone: Google Drive, Dropbox, MEGA, S3-compatible; the pool with upload, download, move, delete; automatic or chosen placement
- [ ] Backups to cloud storage, and downloaded from the web page
- [ ] The helper and the guide

## Exit criterion

I ask for new work on the piano project from its Eye tab and follow it
there to the end, without a job page; a search engine and a visitor
find nothing on my private Nest.

Related: [[Roadmap]] · [[Phase-11-Workspace]]
