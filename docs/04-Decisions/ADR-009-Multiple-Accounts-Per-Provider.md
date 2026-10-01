# ADR-009 — Several accounts per provider: supported, but no quota hopping by default

**Status:** Proposed · 2026-10-01 · [[Phase-1-MVP]] — **needs my decision** (see "Open")

## Context
I want to plug in several accounts of the same agent (e.g. two Claude
subscriptions). The providers' current terms (checked 2026-10-01):

- **Anthropic** ([legal and compliance](https://code.claude.com/docs/en/legal-and-compliance),
  [consumer terms](https://www.anthropic.com/legal/consumer-terms)):
  - Signing in to the *unmodified* Claude Code binary with my own
    subscription is allowed, and `claude -p` and Agent SDK use draw from
    my plan's limits.
  - But "advertised usage limits for Pro and Max plans assume ordinary,
    individual usage".
  - Third-party apps must not "collect, store, or intermediate Claude.ai
    credentials or session tokens".
  - The consumer terms forbid automated access "except … where we
    otherwise explicitly permit it".
  - Holding several accounts isn't addressed. Rotating them to get
    around limits looks like circumvention.
- **Google Antigravity** ([terms](https://antigravity.google/terms)):
  third-party tools using Antigravity OAuth breach the terms. Launching
  the official `agy` binary headless with its own cached credentials is
  described by Google staff as supported, consuming the same limits.

## Decision
- A Leg may be any account I legitimately hold. Oraknid never holds or
  passes around a provider's login tokens: each account is a separate
  agent config directory that **I** log into with the official binary
  (`CLAUDE_CONFIG_DIR=… claude` → `/login`). Oraknid only points the
  process at that directory (BR-13, BR-20).
- Routing uses each account for the work it suits. **Falling back to
  another account of the same provider *because* the first hit its
  limit** is off by default. When it's off, the task falls back to a
  different provider or a local Leg, or waits for the reset.
- A per-provider setting can turn same-provider fallback on. The setting
  shows the relevant terms excerpt and is recorded in the audit log.
- `oraknid doctor` links the current terms for every provider in my pool.

## Open
Whether I want same-provider fallback available at all, given the terms.
Until I decide, this ADR stays Proposed and the setting ships off.

## Consequences
- Oraknid stays on the right side of the providers' terms by default,
  which also protects my accounts.
- When all Legs of one provider are exhausted, jobs wait more often,
  unless other providers or local models are in the pool.

Related: [[Legs-and-Capability-Profiles]] · [[Leg-Adapters]] · [[Business-Rules]]
