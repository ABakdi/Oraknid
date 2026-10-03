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
apps/daemon/          the service: The Eye, the API, the live socket, the CLI (`oraknid`)
apps/web/             the web UI (React, shadcn/ui), served by the daemon
packages/contracts/   every entity, API shape and live frame, defined once (Zod)
packages/os/          Linux integration: sandbox, sleep lock, secrets, metrics, notifications, service
packages/core/        pure rules: life cycles, capability profiles
packages/legs/        the Leg SDK and adapters: Claude Code, OpenAI-compatible
docs/                 the canon
```

More packages arrive milestone by milestone ([ADR-001](docs/04-Decisions/ADR-001-Monorepo.md)).

## Install

On Linux, as yourself (it asks for `sudo` only to install missing packages):

```sh
curl -fsSL https://raw.githubusercontent.com/ABakdi/Oraknid/main/install.sh | sh
# until dev is merged into main:
curl -fsSL https://raw.githubusercontent.com/ABakdi/Oraknid/dev/install.sh | sh -s -- --ref dev
```

It installs what is missing (git, Node 22.12+, pnpm through corepack,
bubblewrap, passt, Python 3, a C++ compiler), builds into
`~/.local/share/oraknid/app`, links `oraknid` into `~/.local/bin`, runs
`oraknid doctor`, and runs Oraknid in the background with systemd, OpenRC
or runit (an autostart entry otherwise). It ends with the address and a
pairing code. Options: `--ref`, `--dir`, `--no-service`, `--uninstall`
([ADR-036](docs/04-Decisions/ADR-036-One-Script-Install.md)). Running it
again updates.

## Development

Needs Linux, Node 22.12+ and pnpm 9.

```sh
pnpm install
pnpm check                  # lint, typecheck and tests across the workspace
pnpm --filter @oraknid/web build      # the UI the daemon serves
pnpm --filter @oraknid/daemon build

# run the daemon from source
cd apps/daemon
pnpm exec tsx src/cli.ts doctor
pnpm exec tsx src/cli.ts start
pnpm exec tsx src/cli.ts status
pnpm exec tsx src/cli.ts open    # pairs this browser and opens the UI
pnpm exec tsx src/cli.ts pair    # a code for a phone or another browser
pnpm exec tsx src/cli.ts stop
```

Data lives in `$XDG_DATA_HOME/oraknid` (override with `ORAKNID_DATA_DIR`).
The daemon listens on `127.0.0.1:7417`.
