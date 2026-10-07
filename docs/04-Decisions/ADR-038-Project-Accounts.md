# ADR-038 — A project's GitHub repo and servers, chosen once, used by Oraknid

**Status:** Accepted · 2026-10-03

## Context
I asked The Eye to create a GitHub repo for the piano project and push.
It planned a task around the GitHub CLI; my token stays with Oraknid
and never reaches a Leg (ADR-023), so the Leg tried to install the CLI,
copied binaries around, asked me a dozen times, and the job stalled.
Servers have the same question: which one, and with what rights.

## Decision
- **A project links accounts like it links servers**: its **GitHub
  link** is an account (one of the GitHub tokens in Settings, several
  allowed, each named by its account) and a repository (owner/name,
  created or existing, its visibility). It's shown and changed in the
  project's Settings, next to its servers.
- **The Eye asks once, in its conversation**: when work needs GitHub
  (or a server) and the project has no link for it, The Eye asks with
  options (ADR-037): the accounts or servers I have, the one it
  recommends first, "create a new repo" with a name and visibility for
  GitHub. My answer is saved to the project and the work goes on. With
  one account and nothing else to choose, it uses it and says so.
- **Oraknid does GitHub work itself**, through a built-in `github` tool
  in the broker (like the `email` tool), using the project's account:
  `create_repo`, `push` (a branch of the job's work to the linked
  repo), `open_pull_request`, `repo_info`. The token stays in the
  daemon; git runs with it through `GIT_ASKPASS`. Legs are told to use
  the tool and never the `gh` CLI or a token.
- **No questions for linked work**: pushing a branch to the project's
  linked repo, creating the repo I chose, and opening a pull request
  there run without asking (the link is my approval). Pushing anywhere
  else, force-pushing, deleting a branch or a repo, and changing
  visibility still ask (BR-5).
- **Servers the same way**: a deploy to the project's linked server
  uses its state document and runs as ADR-026 says; The Eye asks which
  server once when the project has none linked.

## Fixed after the piano job (2026-10-03)
The link was asked, answered and the repo pushed, yet the task kept
failing: it had been planned around the gh CLI, and its checks (`gh repo
view`, `git ls-remote` on a remote Oraknid never adds) could never pass;
the check repair didn't know the project's repo and kept them.
- **Checks Oraknid answers itself**: `oraknid github-repo` (the linked
  repo exists, with its visibility) and `oraknid github-branch <branch>`
  (the branch is on it at the same commit as here), read with the
  account's token outside the sandbox.
- **A task meets its project's link**: before it runs, a task that needs
  GitHub in a linked project gets a note that the link wins (name,
  visibility, the tool, no gh), and its checks that call gh or read a
  remote become the two above. Once per task.
- **The check repair knows the repo** and replaces such checks itself.
- **Branch checks name real branches** (2026-10-04): an
  `oraknid github-branch` check names only branches the repo really has:
  those the task names, else its work branch. Never a word guessed from
  the text ("push dev and main to GitHub" once gave a branch named
  `to`, and the check could never pass). An old check naming a branch
  the repo doesn't have is repaired, on a task adapted before too.

*Extended 2026-10-03:* several repos per project, and servers with roles ([[ADR-042-Several-Repos-And-Servers]]).
*Extended 2026-10-07:* a link may be on GitLab, Gitea or Forgejo (its `host`), served by the same tool and gates ([[ADR-062-Git-Hosts]]).

## Changed (2026-10-03): the project's Repo tab
The link was in the project's Settings and went unseen. A **Repo** tab,
after Work, shows the linked repo (which one, through which account),
its latest commits, branches and open pull requests, Browse the code
(into Repos, ADR-040) and Open on GitHub, with the card to link, change
or unlink it below. Settings keeps the project's servers.

## Changed (2026-10-04): a linked repo archived or deleted on my request
Deleting or archiving a repo stays outside what The Eye does on its own;
but when I delete or archive a project I may tick its linked GitHub
repos, and Oraknid archives (PATCH `archived`) or deletes them with the
link's account, only when that account owns the repo (its own, or an
organisation it administers). Deleting needs the token's `delete_repo`
permission; GitHub's 403 is said with where to grant it. A repo deleted
loses its link ([[Jobs-and-Projects]] → Archiving and deleting a
project, [[ADR-034-Projects-First]] → Changed).

## Consequences
- ADR-023's "one account at a time" ends: several tokens, each named by
  its account.
- The piano project's stalled task is answered by linking a repo.

## As built (2026-10-03)
- **Accounts**: each token in the keychain under its account's name
  (`github.token.<login>`), the list in the setting `github.accounts`,
  the first the default. The one token of before is named by its
  account the first time the accounts are listed and stays where it was
  (`github.token`): referred to, never read out or copied.
- **The link** is a column of the project (account, owner, name,
  visibility, new or existing, created yet). A project made from one of
  my GitHub repos is linked to it. New work's "A new GitHub repo" makes
  it on the account I pick (2026-10-03): with more than one account, a
  GitHub account picker under it, the default first and chosen; the
  default sends none, as before (the API's `account` was there, the
  page had used the default only).
- **When The Eye asks**: before a task's attempt, when its title or
  instructions name GitHub or a pull request (GitHub), or a deploy or
  "the server" (a server). The planner is told to name GitHub in such a
  task's title. The question is an inbox item, also posted in the
  project's conversation; the job waits on it. The new repo recommended
  is named after the project, public when my words asked for public.
  With one account and a folder whose `origin` is one of its repos,
  there is nothing to choose: it links that. With no server it says so
  once and goes on; with one it uses it.
- **The tool**: `repo_info`, `create_repo` (the linked repo, empty, so
  the first push lands), `push` (`branch`, `to`, `force`, `repo`),
  `open_pull_request`. git runs in the daemon by URL with
  `GIT_ASKPASS`; its output is scrubbed of the token. A force-push is
  `--force-with-lease`, and asks.
- **Untrusted content still wins**: linked work in a task that read
  untrusted content asks (BR-15), since a public repo is publishing.
- **The piano project's task** is answered by this design: once the
  daemon runs this build and the paused job is resumed, The Eye asks
  which repo in the piano project's conversation. Reproduced in
  `apps/daemon/src/eye/project-links.test.ts` against a stand-in GitHub
  and a local bare repo.

Related: [[ADR-023-GitHub-By-Token]] · [[ADR-026-Servers]] · [[ADR-021-Tools-Broker]] · [[Approvals-and-Autonomy]] · [[ADR-037-Questions-With-Options]]
