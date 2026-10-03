# ADR-040 — Repos: my GitHub repositories inside Oraknid

**Status:** Accepted · 2026-10-03

## Context
With several GitHub accounts in Oraknid (ADR-038), I want to see my
repositories without leaving it: their branches, commit history, code,
pull requests, and which project uses which.

## Decision
- **Repos**, a page in the sidebar (`/repos`), shortcut `g r`:
  - **Accounts**: every GitHub account I added (add, check, remove; each
    named by its account), the same list as Settings → GitHub.
  - **The list**: the repositories of an account (or all), searchable,
    with visibility, default branch, last push, and the project that
    links it if any.
  - **A repository**, in tabs in the address: **Code** (browse the tree
    at a branch, read a file with syntax colouring and line numbers,
    the README shown on the root), **Commits** (history of a branch,
    paged; a commit with its message, author, and diff), **Branches**,
    **Pull requests** (open and closed, one with its description,
    commits and diff), and **Project** (link it to a project or open
    the one that links it; new work on it).
- **Read through the REST API** with the account's token, in the
  daemon, cached briefly; nothing is cloned to browse. Actions that
  change GitHub here are mine and few: create a repo, link it to a
  project, open it on GitHub.
- On a phone: the list, then the repository full screen, code
  scrolling inside its block.

## Consequences
- The token needs read access to contents, metadata and pull requests
  on the repositories I want to see.

## As built (2026-10-03)
- **Reads** (`github.repoList`, `repoInfo`, `branches`, `tree`, `file`,
  `readme`, `commits`, `commit`, `pulls`, `pull`, `limits`;
  [[API-Contract]] → Repos) in `apps/daemon/src/workspace/github-repos.ts`,
  through the GitHub class's `read`: each answer kept a minute per
  account and path (500 at most), then asked again with its ETag, a 304
  costing nothing of the allowance; creating a repository or changing
  the accounts forgets them. Paging follows GitHub's `Link`: the list
  reads 100 a page up to 1,000 an account, commits and pull requests 30
  a page, branches 100. A file over 512 KB is not shown; a NUL byte or
  text that isn't UTF-8 is binary.
- **Which account reads a repository**: the one asked for, else its
  project's link, else the one named like its owner, else the one that
  listed it, else the first that can see it. A repository two accounts
  see is listed once, under the first.
- **GitHub's limits in words**: "GitHub's hourly allowance for me is used
  up (5000 requests); it fills again at 08:51, in 30 minutes.", or
  "GitHub asks Oraknid to slow down for me: try again in 30 seconds.";
  the list still shows the other accounts and names the one refused.
  The Repos page shows each account's allowance as last seen.
- **Changes from the page**: a new repository (`github.createRepo`,
  with a README, audited), a link to a project (`projects.setGitHub`,
  an existing repository through the account that reads it), Open on
  GitHub (a link). New work on a linked repository opens its project's
  Eye tab; on another, New work with it chosen to clone, through its
  account.
- **Away from home**: reading, yes. `createRepo`, `addAccount`,
  `removeAccount` and `projects.setGitHub` are home only for a standard
  device (the home-only list still named the routes of before several
  accounts, so adding and removing an account had been allowed away
  from home since M13.6; fixed).
- **The page** (`apps/web/src/pages/repos.tsx`): the list and the
  accounts' card, a repository in tabs whose address holds the branch
  (one part, its slashes encoded), the path, the commit or the pull
  request; syntax colouring by highlight.js's core with 17 languages,
  in its own chunk loaded when a file opens, coloured from the theme's
  tokens. Diffs in `components/diff-view.tsx`.
- Found by hand: New work's repo picker failed on an empty repository
  (no last push); it takes one now.
- **Checked (2026-10-03)**: `g r` on Mail also replied, `g c` also opened
  a new message (both listened on window). The `g` prefix now listens in
  the capture phase and swallows the key after `g`, known or not, before
  any page's own shortcut sees it (`lib/go-prefix.ts`). The code colours
  in the light theme, never checked by hand, measured against the well, a
  card, muted, the canvas and a diff's added, removed and hunk rows: all
  at AA in both themes (lowest 4.99:1 light, 5.05:1 dark), unchanged;
  `lib/code-colours.test.ts` reads them from `index.css` so a later change
  can't drop below AA unseen.

Tested: `apps/daemon/src/workspace/github-repos.test.ts` against a
stand-in GitHub (`apps/daemon/src/testing/fake-github.ts`: two accounts,
pages, ETags, an allowance a test can use up); `apps/web/src/pages/repos.test.tsx`.

Related: [[ADR-038-Project-Accounts]] · [[ADR-023-GitHub-By-Token]] · [[Web-UI]]
