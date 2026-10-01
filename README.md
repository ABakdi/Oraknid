# Oraknid

*Always watching, many legs.* A local background orchestrator that runs
coding agents and local models from a goal to verified completion.
[oraknid.com](https://oraknid.com)

The project is run from its canon in [`docs/`](docs/Home.md): vision,
specifications, architecture, phases and decisions. Start at
[docs/Home.md](docs/Home.md). It opens as an Obsidian vault.

## Status

Phase 1 (the MVP) is in progress. See [the roadmap](docs/03-Planning/Roadmap.md).

## Layout

```
apps/daemon/          the service: API, live socket, CLI (`oraknid`)
packages/contracts/   every entity, API shape and live frame, defined once (Zod)
packages/os/          Linux integration: sandbox, sleep lock, secrets, metrics, notifications, service
packages/core/        pure rules: life cycles, capability profiles
packages/legs/        the Leg SDK and adapters: Claude Code, OpenAI-compatible
docs/                 the canon
```

More packages arrive milestone by milestone ([ADR-001](docs/04-Decisions/ADR-001-Monorepo.md)).

## Development

Needs Linux, Node 22.12+ and pnpm 9.

```sh
pnpm install
pnpm check                  # lint, typecheck and tests across the workspace
pnpm --filter @oraknid/daemon build

# run the daemon from source
cd apps/daemon
pnpm exec tsx src/cli.ts doctor
pnpm exec tsx src/cli.ts start
pnpm exec tsx src/cli.ts status
pnpm exec tsx src/cli.ts stop
```

Data lives in `$XDG_DATA_HOME/oraknid` (override with `ORAKNID_DATA_DIR`).
The daemon listens on `127.0.0.1:7417`.
