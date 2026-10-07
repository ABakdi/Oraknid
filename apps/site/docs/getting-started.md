# Getting started

Oraknid runs on your own Linux computer, in the background. You open it in a browser or in a terminal, describe work, and it gets done by the agents you already have.

## What you need

- **Linux** (it is developed on Arch; any recent distribution works).
- At least one agent account or model: Claude Code, OpenCode, Antigravity, or anything that speaks the OpenAI API (Ollama, llama.cpp, a hosted API).

The install script brings the rest.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/ABakdi/Oraknid/main/install.sh | sh
```

That installs the latest release (`main` follows the releases); each [release](https://github.com/ABakdi/Oraknid/releases) carries its own `install.sh`, pinned to it. For the newest work, from the `dev` branch, add `--dev` to the script from `dev`:
`curl -fsSL https://raw.githubusercontent.com/ABakdi/Oraknid/dev/install.sh | sh -s -- --dev`.

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
- `--no-gui`: terminal only, without the web interface: smaller and quicker to build, for a server or a machine you reach over SSH. You use Oraknid with `oraknid` in a terminal ([Oraknid in a terminal](terminal.html)).
- `--gui`: with the web interface (what you get on a desktop).
- `--uninstall`: remove the service and the `oraknid` command. Your data stays.

With neither `--gui` nor `--no-gui`, the script asks, when it runs in a terminal; otherwise it installs the web interface when the computer has a display, and terminal only when it has none. Running it again keeps what you chose the first time, and so do updates. To add the web interface later: `oraknid install --gui`.

Run it again to update: it fetches, rebuilds, and restarts the service.

### Updating

Oraknid looks for a new version on its own, a minute after it starts and then every six hours, and tells you once per version (a notification, a line on the Overview, and the word at the bottom of the sidebar: **0.1.0 · Up to date** or **Update available: v0.2.0**). What counts depends on what you installed, which the script remembers:

- installed with `--dev`: new pre-releases, and new work on `dev` (**New work on dev (N commits)**);
- installed from `main` or a release's tag: releases only, never a pre-release.

**Settings → About & updates** shows the version, the channel, how it was installed, when it last looked (**Check now** looks at once) and what is new in each newer release. **Update now** asks first, saying how many jobs are running (they pause at a safe point while Oraknid restarts, and go on after it); then Oraknid copies its database to `~/.local/share/oraknid/backups/pre-update-….db` (the last three are kept), runs the install script again in the background, and restarts. The page follows it, says "Oraknid is restarting…" while it can't answer, and ends with **Updated to v0.2.0** and **Reload the page**. Any other Oraknid tab you left open says **Oraknid was updated** with **Reload** (a tab in the background reloads by itself). Your data, projects and settings stay where they are: the update replaces only the program in `~/.local/share/oraknid/app`. If the new version fails to build, or builds but doesn't start (it must answer within a minute), Oraknid builds the one you had again and says so. The log is in `~/.local/share/oraknid/logs/update.log`.

From a terminal it is the same:

```sh
oraknid update --check   # is there an update?
oraknid update           # install it, following its log (--yes: even while jobs run)
```

Installed with the script of v0.1.0, which didn't yet remember what it installed? Run the install command once more (with `--dev` if you installed `dev`); from then on Oraknid updates itself.

Away from home, only a device with full rights may update. Running Oraknid from a clone of your own (`pnpm dev`, or a build in your clone), there is no Update now: the page says so, and you update with git (`git pull`, `pnpm install`, `pnpm build`).

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

Or stay in the terminal: `oraknid` alone opens Oraknid there, The Eye's conversation and a prompt, with slash commands for everything else (`/projects`, `/jobs`, `/inbox`, `/servers`…). See [Oraknid in a terminal](terminal.html). Installed with `--no-gui`, that is how you use it: there is no web page to open, and a phone, which needs the web interface, can't be paired until you add it with `oraknid install --gui`.

## Set your PIN

Oraknid can run anything on your computer, so it opens only with your PIN, on this browser and on every device you add. Pick 6 to 12 digits, or a passphrase. If you ever forget it:

```sh
oraknid pin reset
```

## Add a Leg

A **Leg** is an agent or model Oraknid can hand work to. Go to **Legs** and use **Find agents on this computer**: it lists what it finds (a Claude Code login, OpenCode, Antigravity, a local Ollama) and adds them in one click. Sign in where it asks.

## Start work

Press **New work** (or `n`). Pick a project, or make one: give it a name, then choose **New** (Oraknid makes its folder where you choose), **A folder on this computer**, or **From GitHub**; a line under the form says exactly what will happen. Describe what you want, and start. The Eye plans it, the Legs do it, and you can follow everything live.

Next: [Jobs and The Eye](jobs.html).

## Help inside Oraknid

This guide is in Oraknid too, under **Docs** (`g d`). The helper, the round button at the bottom left, knows it, your screens and your data: ask it how something works or where an option is, and it opens the page and points at the control, or does it for you, asking first before anything big. When the control is in a dialog, the helper steps aside until you close it, then comes back; when it can't point at something, it hears so and tells you where to look instead.
