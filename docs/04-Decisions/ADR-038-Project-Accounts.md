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

## Consequences
- ADR-023's "one account at a time" ends: several tokens, each named by
  its account.
- The piano project's stalled task is answered by linking a repo.

Related: [[ADR-023-GitHub-By-Token]] · [[ADR-026-Servers]] · [[ADR-021-Tools-Broker]] · [[Approvals-and-Autonomy]] · [[ADR-037-Questions-With-Options]]
