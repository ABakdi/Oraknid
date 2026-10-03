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

Related: [[ADR-038-Project-Accounts]] · [[ADR-023-GitHub-By-Token]] · [[Web-UI]]
