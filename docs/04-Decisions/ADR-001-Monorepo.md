# ADR-001 — One pnpm monorepo, with the canon inside it

**Status:** Accepted · 2026-10-01 · [[Phase-1-MVP]]

## Context
Oraknid has three programs (the daemon, the web UI, The Nest) plus Leg
adapters, all TypeScript. They share a wire format (HTTP, WebSocket
frames, stored records) and rules (state machines, budgets, drift
thresholds). If any of them drifts apart from the others, the product breaks.

## Decision
One repository, laid out as:

```
apps/
  daemon/          the service: The Eye, Legs supervisor, HTTP/WS API, CLI entry
  web/             React + shadcn/ui PWA
  nest/            the relay (Phase 4)
packages/
  contracts/       Zod schemas: entities, API, WS frames, events — defined once
  core/            shared rules: state machines, budget math, drift thresholds, routing scores
  legs/
    sdk/           the LegAdapter interface, contract test kit
    claude-code/   adapter + default capability profile
    openai-compatible/
  os/              OS integration behind interfaces (linux now, windows later)
skills/            built-in skills (canon-driven-development.md)
deploy/            systemd unit, Nest compose files (Phase 4)
docs/              the canon
```

Tooling: **pnpm workspaces + Turborepo** for task orchestration and
caching, **TypeScript** project references, **Biome** for lint and
format, **Vitest** for tests, **tsdown** to build the daemon and
packages, **Vite** (with `vite-plugin-pwa`) for the web app. Versions
are pinned in the root `package.json` at scaffold time. Node: the
current Active LTS at scaffold time (Node 24 until 2026-10-20, then
Node 26, which becomes LTS on 2026-10-28).

## Consequences
- Contracts and rules are imported, never copied, so programs can't disagree.
- Adding a Leg kind means adding a `packages/legs/<kind>` package.
- A single version number in the root, read by every program.
- One CI pipeline.

## Why not a canon repo with separate code repos
Nothing needs separate deploys or owners. Separate repos would bring
back the drift that shared packages prevent.

## Why not Nx
More than a repo this size needs. Turborepo does the caching with almost
no configuration.

## Why not ESLint + Prettier
Two tools and two configs. Biome is one fast tool. Its React-hooks
rule coverage needs checking at scaffold time. If it's missing,
`eslint-plugin-react-hooks` is added for `apps/web` only.

Related: [[Architecture-Overview]] · [[ADR-010-API-Contracts]]
