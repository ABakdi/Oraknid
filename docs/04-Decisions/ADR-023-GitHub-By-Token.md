# ADR-023 — GitHub through a token I paste

**Status:** Accepted · 2026-10-02 · [[Phase-8-Daily-Use]]

## Context
I want to create a GitHub repo, or pick one of mine, when I start a
project, and have Oraknid clone it. The GitHub CLI isn't installed here.
The options were a sign-in through a GitHub OAuth app (no token to
copy, but an app to register once) or a token. My choice: a token.

## Decision
- **Settings → GitHub**: I paste a fine-grained personal access token
  (repository administration to create repos, contents to clone and
  push). It goes to the keychain (BR-13), is checked at once against
  `GET /user`, and the account name is shown. Removing it deletes it.
- **REST API** (`api.github.com`) with plain `fetch`: list my repos,
  create one (private by default, with a README so it can be cloned).
- **Cloning** with `git clone` over HTTPS, the token given through
  `GIT_ASKPASS` for that one command, never in the URL, the remote or
  `.git/config`. A project from a cloned repo is an ordinary project.
- **Pushing** stays a gated action (BR-5) and uses the same askpass
  when I approve it. The token never reaches a Leg: Legs have no
  network credentials, and a push is Oraknid's, not the Leg's.
- Creating a repo is an action of mine (from the page or through the
  helper, which asks first); it is audited.
- Other remotes (GitLab, any git URL): a plain clone URL works for
  public repos now; tokens for other hosts come later.

## Consequences
- No app to register; the token's expiry is mine to manage, and Settings
  says when GitHub refuses it.
- One account at a time.

Related: [[Security]] · [[Jobs-and-Projects]] · [[Phase-8-Daily-Use]]
