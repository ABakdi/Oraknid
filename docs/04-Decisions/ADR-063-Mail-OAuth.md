# ADR-063 — Gmail and Outlook sign in with Google or Microsoft again, through an app I register

**Status:** Accepted · 2026-10-07 · [[Phase-12-Email]] · brings back what [[ADR-032-Email]] took out on 2026-10-03

## Context
ADR-032 had sign-in with Google and Microsoft, then took it out the same
day: accounts became app passwords only, OAuth "back after a few
releases". App passwords need two-step verification, Microsoft is
retiring them for many accounts, and a work Google account may not allow
them at all. The sign-in comes back now, with what was learned: the app
is mine to register (Oraknid ships no client id), and Microsoft can sign
in without any address back to this computer.

## Decision
- **The app is mine**: I register an OAuth app with Google (a "Desktop
  app" client) and with Microsoft (an app registration that allows public
  client flows) and give Oraknid its client id, and Google's client secret
  (a desktop app's isn't confidential, but Google wants it). **Settings →
  Connections → Email accounts → Sign-in with Google and Microsoft**, with
  the steps for each and the redirect to give the app. The id is a
  setting; the secret goes to the keychain, never shown back.
- **Two ways to sign in, started from the web UI** (Add an account, or
  Reconnect on an OAuth account):
  - **in the browser**: the authorization code flow with PKCE (S256),
    Google's page in a new tab coming back to the daemon itself at
    `http://127.0.0.1:<port>/oauth/mail/callback`; only a sign-in started
    here (its random state) is accepted, for fifteen minutes;
  - **with a code** (Microsoft's device code flow, its default): the code
    and Microsoft's page are shown, and the daemon polls until I typed it
    there. Google's device flow doesn't allow Gmail's scope, so Google is
    the browser's.
- **XOAUTH2 for IMAP and SMTP**, the account's servers Gmail's or
  Outlook's own. The refresh token goes to the keychain; access tokens
  stay in memory and are refreshed a minute before they expire; a new
  refresh token the provider turns over replaces the old one. A refresh
  refused for good (revoked, expired, the app's secret changed) puts the
  account in **Reconnect**, and Reconnect is signing in again, never a
  password.
- **App passwords keep working**, side by side: an account is a password
  or OAuth (`mail_accounts.auth`). POP3 stays password only.

## Consequences
- An app to register once per provider, in my own Google Cloud project
  and Microsoft Entra tenant; a Google app in "testing" asks again every
  seven days (Google's rule) unless published.
- Away from home, signing in and the apps' settings are refused: the
  browser flow comes back to this computer.

## As built (2026-10-07)
- **Where**: `apps/daemon/src/mail/oauth.ts` (the endpoints, PKCE, the
  code exchange, refresh, the device code and its poll, the id token's
  address read but not verified, as it comes straight from the token
  endpoint over TLS), `mail/service.ts` (`oauthApps`, `setOAuthApp`,
  `oauthStart`, `oauthStatus`, `oauthCancel`, `oauthCallback`; a sign-in
  in hand checks IMAP and SMTP with the token before the account is kept;
  signing in again checks the address is the account's), the callback
  route in `daemon.ts`; migration `0041_mail_oauth.sql` adds `auth`.
- **Keychain**: `mail.<account>.refresh`, `mail.oauth.google.secret`;
  settings `mail.oauth.<provider>.clientId`. The scopes: Google
  `https://mail.google.com/ openid email`; Microsoft `offline_access
  openid email` and Outlook's `IMAP.AccessAsUser.All` and `SMTP.Send`.
- **API** ([[API-Contract]] → Mail): `mail.oauthApps`, `setOAuthApp`,
  `oauthStart` (`browser` or `device`), `oauthStatus`, `oauthCancel`;
  `MailAccountView.auth`. `setOAuthApp` and `oauthStart` are home only.
- **Web**: the apps' card in Settings, "Sign in with …" above the add
  form (only the apps set up), the code and Microsoft's link while it
  waits, Reconnect signing in again for an OAuth account.
- **Tested** (`mail/oauth.test.ts`) against a stand-in sign-in server
  (`testing/fake-oauth.ts`: PKCE checked, the client and Google's secret,
  refresh tokens revocable, device codes approved by the test) and the
  stand-in mail server taking XOAUTH2 (IMAP `AUTHENTICATE` with SASL-IR,
  SMTP): Gmail by the browser (the page followed back to the daemon,
  synced, no `LOGIN`), a token refreshed after it ran short, a revoked
  one asking to sign in again, the same account signed in again; Outlook
  by the device code as a public client; a forged callback refused; no
  token in any event; `apps/web/src/components/mail-oauth.test.tsx`.
- **Not yet**: tried on a real Google or Microsoft account; Microsoft's
  browser flow needs its redirect registered as shown (the device code
  needs none); the Mail page's account menu signs in again through
  Reconnect only.

Related: [[ADR-032-Email]] · [[Security]] · [[Phase-12-Email]]
