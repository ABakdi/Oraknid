# ADR-042 — A project with several repos and several servers, each with its role

**Status:** Accepted · 2026-10-03

## Context
A project isn't always one repository: a site and its API can live in
two repos (no monorepo), each committed and pushed on its own. And a
project deploys to more than one server: one for testing, one for
production. ADR-038 linked one repo; a project already takes several
servers, but nothing says which is which, and when I say "deploy it"
The Eye should show me my servers (or let me add one), and pick the one
I name, asking only to confirm.

## Decision
- **Several repos in a project.** A project is either **one repo**
  (its folder is the repository, as today) or **several repos**: its
  folder holds several git repositories, each in its own folder
  (`web/`, `api/`, …), found when the project is added or when one is
  added later. Each has its own name in the project, its branches and,
  if I want, its own GitHub link (account, owner/name, visibility).
- **Jobs across them**: a job gets a worktree and a branch in each repo
  it touches; a task's scope says its repo (its paths start with the
  repo's folder). Checkpoints, rollback, commits, merges and checks
  happen per repo: a task's work is committed in the repos it changed,
  each with its own message, never one commit across them. The result
  of a job lists each repo's branch and commits, and Merge merges each.
- **Pushing**: the `github` tool's `push` names the repo (its name in
  the project); each goes to its own link. The built-in checks take it:
  `oraknid github-branch <branch> [--repo <name>]`, `oraknid github-repo
  [--repo <name>]`. The Eye asks for a link per repo, once, as ADR-038.
- **Servers with roles**: a server given to a project has a **role** in
  it, a word I choose (testing, staging, production…), shown with its
  name. A server can serve several projects with different roles.
- **Choosing a server** for work that needs one (a deploy):
  - I name it in my message ("deploy to production", "on vps-2"): The
    Eye matches the name or the role among the project's servers, then
    mine, and asks me only to **confirm** ("Deploy to production,
    vps-2?"), recommended Yes;
  - I don't: The Eye asks with options, the project's servers by role
    first, then my other servers, and **Add a new server**, which opens
    the add-a-server dialog (the helper takes me there) and comes back
    to the question when it's added;
  - **production** (a role named so, or marked as such) is always
    confirmed, even when it's the only one.
  My choice is saved to the project with its role, as ADR-038 saves a
  repo.

## Consequences
- The project's Repo tab lists each repo; Settings lists its servers
  with their roles.
- A one-repo project behaves as before.

## As built (2026-10-03)
- **The repos** are a column of the project (`projects.repos`: name,
  folder, branches, link). A project of one repo has one, folder "";
  migration 0031 made that repo for every git project, its single link
  of ADR-038 moved into it, and 0032 dropped `projects.github`. The API
  still shows a project of one repo's link as `github`. Found: a folder
  that isn't a repo but holds some (two folders down, not inside each
  other, a submodule being its parent's) is a project of several when
  added; a folder that is a repo stays one repo until I add or find the
  others (the Repo tab), its own repo then the first of them. Repos
  don't change while one of the project's jobs runs.
- **The job's folder mirrors the project's.** I chose a folder per job
  (`.oraknid/worktrees/<job>`) holding each repo it touches as a worktree
  on the job branch at that repo's folder, rather than a worktree beside
  each repo: paths, scopes, checks and what a Leg reads are the
  project's own, a task needs no idea of where each repo lives, and a
  check like `cd web && npm test` works unchanged. A repo is opened
  lazily: when the plan's tasks or the task about to run name it in
  their scope, or when a Leg writes in its folder (moved aside, the
  worktree made, the files put back). When the project's folder is one
  of the repos, the job's folder is its worktree and the others sit in
  it, left out of its snapshots and commits. Git finds a worktree by its
  folder's name, and several jobs' `web` share one, so Oraknid looks for
  the record whose path is the worktree's.
- **One code path, two trees.** A job's work tree is either one git work
  tree (a project of one repo, or a shadow repo: exactly as before) or
  the several-repo tree; checkpoints, the scope's changes (D1), putting
  back, rollback, diffs and commits go through it. Each repo keeps the
  job's checkpoints on its own refs; a repo opened after a checkpoint
  counts from where its worktree started (`refs/oraknid/<job>/start`).
  Files outside every repo (no repo at the top) are changes too: out of
  scope, they go to the trash. A task's commits are one per repo it
  changed, `feat(web): …` when it changed several, kept on the task
  (`tasks.commits`).
- **Tasks side by side** (2026-10-03), as ADR-016 does for one repo:
  above one task at a time, a task gets a folder of its own
  (`.oraknid/worktrees/<job>-t-<task>`) mirroring the job's, each repo it
  touches a worktree on the task's branch (`<job branch>--t-<task>`, the
  same name in every repo) from the job branch's tip in that repo; a
  repo the job hadn't opened is opened in the job's folder first. Its
  checkpoints and scope count from where its worktrees started
  (`refs/oraknid/<job>/t-<task>/start`). Verified, it is merged one task
  of the job at a time: every repo it changed is computed first (`git
  merge-tree`), none is merged when one conflicts, then each is merged
  into the job's worktree of that repo and the task's checks run on the
  job's folder; checks that fail take every repo's merge back (each to
  its commit before). Not merged, the task is redone in a fresh folder
  from the job's newer tips; merged, its folder and branches go.
- **Merge** computes every repo's merge (`git merge-tree`) before
  merging any: a conflict in one merges none.
- **The github tool** takes `repo`: a repo's name in the project, or an
  owner/name to push elsewhere (which asks, as before). In a project of
  several, a repo of several is pushed from its own folder; a call that
  names none while several are linked is refused by the tool with the
  list, so it isn't asked. `repo_info` with no repo says each repo's.
  The built-in checks take `--repo <name>` (or `--repo=<name>`).
- **The Eye asks for the links** of the repos a task is about in one
  question set (`repo:<name>` per repo); an existing repo's visibility
  is read from GitHub.
- **Servers' roles** are a column of the project (`server_roles`, by
  server id: role, production mark or null). The server chosen for a
  job is the setting `job.server.<job>`, with the ones I declined. "My
  message" is the task, the job's goal and my latest message to The
  Eye in that job, not my answers. The question that waits for a new
  server is an inbox item answered by itself when a server is added
  (the `server.added` event).
- **Not built**: renaming a repo or changing its branches in the UI (a repo
  taken out and added again takes the branches it has).

Related: [[ADR-038-Project-Accounts]] · [[ADR-026-Servers]] · [[Jobs-and-Projects]] · [[ADR-016-Parallel-Work]] · [[ADR-037-Questions-With-Options]]
