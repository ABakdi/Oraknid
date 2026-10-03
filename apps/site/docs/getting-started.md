# Getting started

Oraknid runs on your own Linux computer, in the background. You open it in a browser, describe work, and it gets done by the agents you already have.

## What you need

- **Linux** (it is developed on Arch; any recent distribution works).
- **Node 22.12 or newer** and **pnpm 9**.
- **git** and **bubblewrap** (`bwrap`): every agent runs in a sandbox.
- **Python 3** and **passt**, so each sandbox also gets its own network and can't reach your desktop or your local services. Recommended.
- At least one agent account or model: Claude Code, OpenCode, Antigravity, or anything that speaks the OpenAI API (Ollama, llama.cpp, a hosted API).

## Install

```sh
git clone -b dev {{repo}}.git
cd Oraknid
pnpm install
pnpm build
node apps/daemon/dist/cli.mjs doctor
```

`doctor` checks the sandbox, the keychain where secrets live, the background service and the rest, and says how to fix what is missing.

Then run it as a background service that starts with your computer:

```sh
node apps/daemon/dist/cli.mjs install
```

You can also run it by hand with `start`, see how it is doing with `status`, and stop it with `stop`.

## Open it

```sh
node apps/daemon/dist/cli.mjs open
```

This opens the web interface on `http://127.0.0.1:7417`. The first time, the page asks you to pair this browser with a six-digit code: the command prints it.

## Set your PIN

Oraknid can run anything on your computer, so it opens only with your PIN, on this browser and on every device you add. Pick 6 to 12 digits, or a passphrase. If you ever forget it:

```sh
node apps/daemon/dist/cli.mjs pin reset
```

## Add a Leg

A **Leg** is an agent or model Oraknid can hand work to. Go to **Legs** and use **Find agents on this computer**: it lists what it finds (a Claude Code login, OpenCode, Antigravity, a local Ollama) and adds them in one click. Sign in where it asks.

## Start work

Press **New work** (or `n`). Pick a project (a folder, a new folder, or one of your GitHub repos), describe what you want, and start. The Eye plans it, the Legs do it, and you can follow everything live.

Next: [Jobs and The Eye](jobs.html).
