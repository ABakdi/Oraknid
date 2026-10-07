# ADR-058 — CI inside Oraknid: GitHub Actions, this repo's own pipeline, releases by script

**Status:** Accepted · 2026-10-07 · changes [[ADR-001-Monorepo]], [[ADR-010-API-Contracts]], [[ADR-047-Releases]]

## Context
My projects' repositories run GitHub Actions, and I leave Oraknid for
github.com to see whether a push passed, to read the failing step's log,
to re-run it or start a workflow by hand. The Eye pushes a job's branch
(ADR-038) and then can't tell whether CI passed. Oraknid's own canon
promised things that were never built: one CI pipeline (ADR-001), an
OpenAPI document generated at build (ADR-010, [[API-Contract]]), and a
release (ADR-047) is still a dozen commands typed by hand.

## Decision

### 1. GitHub Actions, read and driven from Oraknid
- **Where**: a **CI** tab on a repository of the Repos page
  (`/repos/<owner>/<name>/ci`), and a **CI** tab on a project
  (`/projects/<id>/ci`), one section per linked repo, its release and work
  branches first. Read through the account that reads the repository
  (ADR-040's rule), in the daemon; the token never leaves it.
- **Runs** per repository, filtered by branch (and workflow): status,
  conclusion, duration, commit, event, actor, attempt, a link to GitHub.
- **A run**: its jobs and their steps (each with its status, conclusion and
  time); the failing job and step named.
- **Logs**: a job's log fetched through the daemon, cut by step (each
  line's time against the steps' times, GitHub's `##[group]` markers as a
  fallback), **the failing step first** and open, the others folded;
  searchable (the matching lines and their step). A completed job's log
  is kept in memory (it doesn't change), at most 20 and the last 8 MB of
  each.
- **Artifacts**: a run's list (name, size, expired); a download is a
  one-time link (ADR-046's `Downloads`) that streams GitHub's zip through
  the daemon.
- **Changes**, mine from the page: **re-run failed jobs**, **re-run**,
  **cancel**, and **run a workflow** (`workflow_dispatch`) on a branch
  with its inputs (read from the workflow file's `on.workflow_dispatch.inputs`:
  string, boolean, choice, number, environment, with their defaults).
  Each is audited (`ci.rerun`, `ci.cancelled`, `ci.dispatched`). From an
  agent, the helper or The Eye they go through approvals (ADR-053): the
  github tool's `ci_rerun` is a gated `external-write`; the helper's
  `rerun_ci` is proposed and waits for my Confirm. Reads are free.
- **Live by polling with ETags**: an open run is asked again every 10 s
  (5 s on the page while a run is in progress, the daemon's cache sharing
  one request between pages), a finished one is kept a minute; every
  request after the first carries GitHub's ETag, so an unchanged answer
  (304) costs nothing of the allowance. **Backing off**: when GitHub says
  the hourly allowance is used up, or asks to slow down (`Retry-After`),
  the daemon asks it nothing more with that account until then: a read
  it has is served as it was (`stale`), one it hasn't is refused in words
  with the time; the page's polling slows to a minute while it is so.
- **A CI badge**: on a project's header (its first linked repo's release
  branch, else its work branch) and on a job's page (the job's branch, or
  its pull request's head): passing, failing, running, or nothing when
  the repository has no run there. It opens the CI tab.
- **Notifications**: a run on a linked repo's **release or work branch**
  that ends failing (failure, timed out, startup failure) is told once
  (`ci.failed`, a new row of the routing table: desktop and push, no
  email by default; quiet hours hold it). Oraknid looks every 3 minutes
  (ETags: nothing costs while nothing changes), remembers what it told,
  and from when it started watching a branch, so a restart doesn't tell
  old failures again.
- **The Eye's check** `oraknid github-ci [--repo <name>] [--branch <b>] [--timeout <minutes>]`
  waits for the runs of the branch's latest commit (the project's own
  commit of that branch when it has one, so a push is waited for) and
  passes when every one passed; fails with the failing workflow, job and
  step and the **last 40 lines of that step's log**; fails when they are
  still running at the timeout (20 minutes by default, 60 at most), or
  when the repository has no workflows. Like `github-branch`, it runs
  after the job's end steps (push). The branch (`--branch`, or the first
  word) defaults to the repository's default branch on GitHub. A cancelled
  run fails it too.
- **The Eye's job report** shows CI for the job's pull request (or its
  pushed branch): the badge and the failing step.
- **The helper**: `list_ci_runs` and `ci_failing_log` (reads),
  `rerun_ci` (asked).
- **The terminal app**: `/ci` in a project: its linked repos' latest
  runs; a number shows a run's jobs, the failing step's log tail.

### 2. Oraknid's own CI
`.github/workflows/ci.yml` on push and pull request to `dev` and `main`:
Node 22, pnpm 9 with its store cached, `pnpm install --frozen-lockfile`,
Biome, typecheck, tests, and the OpenAPI document checked against the
router. Tests that need what a CI runner lacks are skipped: with
`ORAKNID_CI=1` set, those that would otherwise find it there (Docker's
databases and MinIO, a logind inhibitor lock, a user's systemd); the
others by the probe they already have (bubblewrap, a real keychain,
rclone, OpenCode, live models). The startup perf test stays in
`pnpm check` on my machine: a shared runner's speed varies.

### 3. Releases by script
`scripts/release.mjs <version> [--publish] [--dry-run]`: checks the tree
is clean and on `dev`, sets every `package.json` to the version, checks
`CHANGELOG.md` has its section, commits (`release: vX.Y.Z, …` from the
section's first line), tags `vX.Y.Z` (annotated), and writes
`dist/release/vX.Y.Z/install.sh` (pinned, `REF="vX.Y.Z"`) and
`SHA256SUMS`. With `--publish` it reads a token from git's credential
helper (`git credential fill` for github.com; never printed, never in an
argument), pushes `dev` and the tag, creates the GitHub pre-release
(before 1.0) with the CHANGELOG section as its notes, uploads both
assets, then fast-forwards `main` to the tag and pushes it.
`.github/workflows/release.yml` does the assets part on a pushed `v*`
tag, so a tag pushed by hand gets them too.

### 4. The OpenAPI document
Generated from the oRPC router with `@orpc/openapi` and `@orpc/zod`'s
Zod 4 converter: served by the daemon at `GET /api/openapi.json`, behind
pairing like every `/api` call, and written to
`docs/02-Architecture/openapi.json` by `pnpm --filter @oraknid/daemon
openapi`, which the release script runs and CI checks (`--check`). Not
by the plain build: an install builds in its own checkout, and a file
changed there would make the next update refuse it as local changes. It describes every procedure's input and output; the
wire stays oRPC's RPC protocol (`POST /api/<path>` with `{"json": input}`),
which the document says in its description. No second, REST-shaped
handler is mounted.

## Consequences
- The token needs **Actions: read** (and **write** to re-run, cancel or
  dispatch) on fine-grained tokens; a classic token's `repo` covers it.
  GitHub's 403 says which permission to grant.
- Polling costs requests only when something changed; the watcher reads
  two branches per linked repo.
- ADR-001's "one CI pipeline" and ADR-010's generated document now exist.

## As built (2026-10-07)
- `packages/contracts/src/ci.ts` (CiRun, CiJob, CiStep, CiLog, CiArtifact,
  CiWorkflow, CiBadge); `apps/daemon/src/workspace/github-ci.ts` (the
  reads, writes, log cutting and the wait), `ci-watch.ts` (the watcher);
  `GitHub.read` takes a time to keep (`ttl`) and, after a refusal for the
  allowance or a slow-down, serves what it has until GitHub's time
  (`GitHubError.retryAt`), for every read, the Repos page's too.
  `GitHub.send` (a change) and `GitHub.raw` (a log or a zip: asked with
  the token, GitHub's redirect followed without it) are new.
- API `ci.*` in `apps/daemon/src/api/ci.ts` ([[API-Contract]] → CI).
  Re-run, cancel and dispatch from the page are mine and audited, allowed
  away from home like a job's own controls; an artifact's download isn't
  (the tunnel carries text).
- **Logs**: GitHub's job log is plain text with a timestamp per line and
  step times to the second. A line goes to the last step started by its
  second; when several started in that second, the first of them is
  entered and each `##[group]` line moves to the next. Colours and the
  timestamps are taken off. A step longer than 2,000 lines keeps its
  last 2,000 and says how many it left out. A workflow's inputs are read
  from its file with `yaml` (2.9.1).
- **The badge**: a branch's latest commit is the head of its newest run;
  failing when any of that commit's runs failed, running when any still
  runs, else passing.
- **The watcher** starts 20 s after the daemon and looks every 3 minutes;
  a refused account is skipped until the next look. A project archived
  or a server's own is not watched.
- **The github tool**: `ci_runs` and `ci_log` are reads (the log wrapped
  as untrusted data); `ci_rerun` is judged `external-write`, never
  "linked", so it goes through the approvals of ADR-053 whatever the link.
- **The helper**: `list_ci_runs` and `ci_failing_log` read (a project's
  first linked repo, or owner/name); `rerun_ci` is proposed and waits
  for my Confirm.
- **Terminal app**: `/ci` (`apps/daemon/src/tui/ci.ts`).
- Web: `components/ci-panel.tsx` (runs, a run, logs, artifacts, the
  dispatch dialog, the project's CI tab) and `components/ci-badge.tsx`
  (the project's header, the job's header, The Eye's job-done report).
- Tested against the stand-in GitHub (`testing/fake-github.ts`, now with
  Actions on me/piano: runs, jobs, logs behind a signed redirect,
  artifacts, workflows and their files, re-runs, cancels, dispatches) in
  `apps/daemon/src/workspace/github-ci.test.ts`: runs, jobs, logs cut by
  step and searched, the signed address never getting the token,
  artifacts downloaded once, re-run, cancel and dispatch with their
  refusals, the badge, ETags (a 304 costs nothing) and the backoff, the
  watcher telling a failure once and a re-run's failure again, quiet
  hours holding it, the OpenAPI document served to paired devices only,
  the github tool's reads free and its re-run gated, the helper's
  actions, `/ci`, and the check passing, failing with the log's tail,
  waiting for a push, timing out and finding no workflows. The web in
  `components/ci-panel.test.tsx`; the release script in
  `apps/daemon/src/release-script.test.ts`.

## Limits
- Live updates are polling, not GitHub's webhooks: Oraknid isn't
  reachable from GitHub, and a webhook needs a public address.
- A log longer than 4 MB loses its start; a job's log is fetched whole
  each time while the job runs (GitHub has no ranged log).
- The check waits on the runs GitHub lists for the branch; a workflow
  that runs only on a pull request's merge ref isn't seen on the branch.
- Only GitHub Actions: other CI services (their commit statuses) aren't
  read.

Related: [[ADR-040-Repos-Page]] · [[ADR-038-Project-Accounts]] · [[ADR-053-Auto-Mode]] · [[Notifications]] · [[Web-UI]]
