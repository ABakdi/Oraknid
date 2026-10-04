# Getting started

Oraknid runs on your own Linux computer, in the background. You open it in a browser, describe work, and it gets done by the agents you already have.

## What you need

- **Linux** (it is developed on Arch; any recent distribution works).
- At least one agent account or model: Claude Code, OpenCode, Antigravity, or anything that speaks the OpenAI API (Ollama, llama.cpp, a hosted API).

The install script brings the rest.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/ABakdi/Oraknid/main/install.sh | sh
```

Run it as yourself, not as root. It asks for `sudo` only to install what is missing, and prints every command it runs:

- **git**, **bubblewrap** (`bwrap`: every agent runs in a sandbox), **Python 3** and a C++ compiler, from your distribution (apt, dnf, pacman, zypper or apk);
- **passt**, so each sandbox gets its own network and can't reach your desktop or your local services (recommended);
- **rclone**, for Cloud storage (recommended; without it only Cloud storage waits, and `oraknid doctor` says how to install it);
- **Node 22.12 or newer**: your distribution's when it is recent enough, otherwise one from nodejs.org, checked against its checksum and kept inside Oraknid's folder;
- **pnpm**, through corepack.

Then it builds Oraknid in `~/.local/share/oraknid/app`, puts the `oraknid` command in `~/.local/bin`, runs `oraknid doctor`, and starts Oraknid in the background with what your system uses for services:

| System | The service | Stop it | Keep it from starting |
| :-- | :-- | :-- | :-- |
| systemd | a user service | `systemctl --user stop oraknid` | `systemctl --user disable --now oraknid` |
| OpenRC | `/etc/init.d/oraknid`, running as you | `sudo rc-service oraknid stop` | `sudo rc-update del oraknid default` |
| runit | a service folder running as you | `sudo sv down /var/service/oraknid` | `sudo rm /var/service/oraknid` |
| anything else | an autostart entry for your desktop session | `oraknid stop` | `rm ~/.config/autostart/oraknid.desktop` |

OpenRC and runit services are system services that drop to your user, so writing them asks for `sudo` once. At the end the script prints the exact commands for your system, the address to open, and a pairing code.

Options go after `sh -s --`:

```sh
curl -fsSL https://raw.githubusercontent.com/ABakdi/Oraknid/dev/install.sh | sh -s -- --dev
```

- `--dev`: install the `dev` branch, where the newest work is (the same as `--ref dev`). Until it is merged into `main`, this is the one to use.
- `--ref <branch>`: what to install (default `main`).
- `--dir <path>`: where the program lives (default `~/.local/share/oraknid/app`).
- `--from <path|url>`: install from another clone, a folder or a git URL, instead of GitHub.
- `--no-service`: build and link, but don't run it in the background.
- `--uninstall`: remove the service and the `oraknid` command. Your data stays.

Run it again to update: it fetches, rebuilds, and restarts the service.

### By hand

If you'd rather do each step yourself, you need Node 22.12 or newer, pnpm 9, git, bubblewrap, Python 3 and a C++ compiler (passt and rclone recommended):

```sh
git clone -b dev {{repo}}.git
cd Oraknid
pnpm install
pnpm build
ln -s "$PWD/apps/daemon/dist/cli.mjs" ~/.local/bin/oraknid
oraknid doctor
oraknid install
```

`doctor` checks the sandbox, the keychain where secrets live, the background service and the rest, and says how to fix what is missing. `install` runs Oraknid in the background, as the script does.

You can also run it by hand with `oraknid start`, see how it is doing with `oraknid status`, read its log with `oraknid logs -f`, and stop it with `oraknid stop`.

## Open it

```sh
oraknid open
```

This opens the web interface on `http://127.0.0.1:7417`. The first time, the page asks you to pair this browser with a six-digit code: the command prints it. `oraknid pair` gives a new one, for a phone or another browser.

## Set your PIN

Oraknid can run anything on your computer, so it opens only with your PIN, on this browser and on every device you add. Pick 6 to 12 digits, or a passphrase. If you ever forget it:

```sh
oraknid pin reset
```

## Add a Leg

A **Leg** is an agent or model Oraknid can hand work to. Go to **Legs** and use **Find agents on this computer**: it lists what it finds (a Claude Code login, OpenCode, Antigravity, a local Ollama) and adds them in one click. Sign in where it asks.

## Start work

Press **New work** (or `n`). Pick a project (a folder, a new folder, or one of your GitHub repos), describe what you want, and start. The Eye plans it, the Legs do it, and you can follow everything live.

Next: [Jobs and The Eye](jobs.html).

## Help inside Oraknid

This guide is in Oraknid too, under **Docs** (`g d`). The helper, the round button at the bottom left, knows it, your screens and your data: ask it how something works or where an option is, and it opens the page and points at the control, or does it for you, asking first before anything big. When the control is in a dialog, the helper steps aside until you close it, then comes back; when it can't point at something, it hears so and tells you where to look instead.
