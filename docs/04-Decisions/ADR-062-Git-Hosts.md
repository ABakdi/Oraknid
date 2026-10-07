# ADR-062 — GitLab, Gitea and Forgejo beside GitHub, one GitHost interface

**Status:** Accepted · 2026-10-07 · [[Phase-8-Daily-Use]] (M8.3) · builds on [[ADR-023-GitHub-By-Token]], [[ADR-038-Project-Accounts]], [[ADR-040-Repos-Page]]

## Context
ADR-023 left "tokens for other hosts" for later: a plain clone URL of a
public repo was all GitLab got. Some of my repositories live on GitLab
(gitlab.com and a self-hosted one) and on a Forgejo of mine. I want them
in Oraknid as GitHub's are: an account, the list, a project linked to one
of them, Oraknid cloning, pushing and opening the merge request itself,
and the Repos page reading them.

GitHub's client (`workspace/github.ts`) is used everywhere (the github
tool, the Eye's built-in checks, the endings, New work, removal) and
another piece of work is adding CI to GitHub at the same time. So the
other hosts must come in beside it, not by rewriting it.

## Decision
- **Accounts by personal access token**, as GitHub's: GitLab (gitlab.com
  or my own address) and Gitea or Forgejo (my own address; Forgejo speaks
  Gitea's API and is told apart by its `/api/forgejo/v1/version`). The
  token is checked against the host (`GET /user`), kept in the keychain
  under the host and the account's login, and never shown again, never in
  a URL, a remote, a config file, an event or a Leg. Plain http only to
  this computer. Several accounts per host, several hosts.
- **A small `GitHost` interface** (`workspace/hosts/host.ts`): the core
  New work, the github tool and a project's link need (`accounts`,
  `repos`, `createRepo`, `repo`, `openPullRequest`, `cloneUrl`, `clone`,
  `push`), `branchHead` and `branchUrl` for the checks and the endings,
  and `browse`, the Repos page's reads in GitHub's shapes (list, info,
  branches, tree, file, README, commits, a commit with its diff, pull or
  merge requests, one with its commits and diff). GitHub's client fills
  the core as it is (its methods already have these shapes); an adapter
  adds its Repos reads. CI stays out: an optional `ci?` facet for the
  GitHub CI work to fill first.
- **A link names its host**: a project's link (`GitHubLink`) gains an
  optional `host` (absent: GitHub) and its owner may be a GitLab group
  with subgroups (`team/web`). The same link, the same `github` tool (its
  name kept: skills and prompts name it), the same gates: pushing a branch
  to the linked repo, creating it when new, opening a pull (merge) request
  there run without asking; anything else is the gated action it is. The
  built-in checks `oraknid github-repo` and `oraknid github-branch` read
  the link's host.
- **Oraknid's own credential path** for every host: git runs in the daemon
  with the token given through `GIT_ASKPASS` for one command (GitLab's
  user `oauth2`, Gitea's the account's login), by URL, nothing written to
  `.git/config`, its output scrubbed of the token.
- **Repos and New work**: the host accounts in a card beside GitHub's
  (Repos → Accounts, Settings → Connections), every host's repositories
  in one list, a repository read through its host, New work cloning one
  through its account and linking the project to it.

## Consequences
- A project's GitHub link can point at GitLab, Gitea or Forgejo; nothing
  else of GitHub's changes.
- Archiving or deleting a repo on my request stays GitHub's
  ([[ADR-038-Project-Accounts]] → Changed 2026-10-04): another host's
  linked repo is compared with the folder (`git ls-remote`) and cloned
  back, never archived nor deleted from Oraknid.

## As built (2026-10-07)
- **Where**: `apps/daemon/src/workspace/hosts/` — `host.ts` (the
  interface, `HostError`, the askpass git helpers, async so the daemon
  keeps answering while git talks to a host; unified diffs cut per file),
  `rest.ts` (the accounts store: the setting `githosts.accounts`, each
  token in the keychain as `githost.token.<host>.<login>`; `TokenHost`,
  what both clients share: reads kept a minute and asked again with their
  ETag, pages by `Link` or GitLab's `x-next-page`, every refusal in
  words), `gitlab.ts` (API v4, `PRIVATE-TOKEN`; a project by its path with
  its namespace; merge requests; closed = merged + closed; diffs from
  `/diffs`, `/changes` before GitLab 15.7), `gitea.ts` (API v1, `token`;
  contents and git trees as GitHub's; diffs from `.diff`, cut per file),
  `registry.ts` (`GitHosts`: GitHub through `githubHost`, an adapter over
  its client and `Repos`; one client per other host; `hostFor(github,
  link)` reaches the registry from the GitHub client the daemon already
  hands the Eye, the Verifier and the endings, so none of their wiring
  changed).
- **A host's id** is its address without the scheme, lower-cased
  (`gitlab.com`, `git.example.org:3000`, `example.org/gitea`).
- **API** ([[API-Contract]] → Git hosts): `hosts.list`, `accounts`,
  `addAccount`, `removeAccount`, `repos`, `repoList`, `repoInfo`,
  `branches`, `tree`, `file`, `readme`, `commits`, `commit`, `pulls`,
  `pull`, `createRepo` (any host, GitHub's included through its own
  routes). `projects.createFrom` and `projects.addRepo` take a `host` on
  `github-new` and `github-clone`; `projects.setGitHub` a link with a
  host, checked against that host's accounts. Adding and removing an
  account and creating a repository are home only for a standard device.
- **The Repos page**: a repository on another host is at
  `/repos/<host>!<owner>/<name>/…` (neither a host nor an owner has a
  `!`; a group's slashes encoded in the part); its Pull requests tab is
  Merge requests on GitLab; Open on `<host>`.
- **Tested** (`workspace/hosts/hosts.test.ts`) against stand-in GitLab and
  Gitea/Forgejo servers (`testing/fake-git-host.ts`) answering from real
  bare repositories, with git's smart HTTP through `git http-backend`
  behind Basic auth: an account added (a wrong token refused in words),
  the list with a subgroup's project, a repository read (tree, file,
  README, commits, a commit's diff), a new project from a new GitLab repo
  created and cloned with `oauth2` and the token, the github tool on the
  GitLab link (repo_info, push, a merge request opened and read back),
  the built-in checks, a repo in a subgroup, a clone from Forgejo with
  the login and token, and the token in no request line, event, remote or
  config; `apps/web/src/pages/repos.test.tsx` (a GitLab project in the
  list and at its address).
- **Not yet**: The Eye's question when a project has no link offers
  GitHub's accounts only (the tool's note to a task still says GitHub);
  CI on the other hosts; archiving or deleting their repos from Oraknid;
  OAuth sign-in to them (tokens only); a GitLab instance whose web
  address differs from its git address.

Related: [[ADR-023-GitHub-By-Token]] · [[ADR-038-Project-Accounts]] · [[ADR-040-Repos-Page]] · [[ADR-021-Tools-Broker]] · [[Security]]
