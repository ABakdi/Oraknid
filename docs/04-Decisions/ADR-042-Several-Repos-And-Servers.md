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

Related: [[ADR-038-Project-Accounts]] · [[ADR-026-Servers]] · [[Jobs-and-Projects]] · [[ADR-016-Parallel-Work]] · [[ADR-037-Questions-With-Options]]
