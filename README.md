<p align="center"><img src="apps/web/public/logo.svg" width="96" alt="" /></p>

<h1 align="center">Oraknid</h1>

<p align="center"><b>Your development workspace that runs itself.</b><br/>
Coding agents that plan, build and verify your work, with the projects, repositories,
servers, backups, storage, mail and monitoring around it, on your own machine.</p>

<p align="center">
<a href="https://oraknid.abakdi.com">Website</a> ·
<a href="https://oraknid.abakdi.com/docs/">Guide</a> ·
<a href="https://github.com/ABakdi/Oraknid/releases">Releases</a> ·
<a href="docs/Home.md">Design canon</a>
</p>

---

Oraknid runs in the background on your Linux machine. You tell it what you
want; **The Eye** plans the work into small tasks with checks, hands each to
the agent that fits it best (Claude Code, OpenCode, Antigravity or a local
model), watches them, and only calls a task done when its checks pass. Around
that sits everything a project needs: its GitHub repos, the servers it deploys
to, what runs on them, their databases' backups, your cloud storage and your
mail, all in one interface you can also use from your phone.

> **v0.1.0 is a pre-release.** It is used daily by its author, tested end to
> end, and still young: expect rough edges, and report them.

## What it does

**Agents and The Eye**
- Runs **Claude Code, OpenCode, Antigravity** and any **OpenAI-compatible** local model (Ollama, LM Studio, llama.cpp, vLLM) as *Legs*, several accounts each, found on your machine in one click.
- **Plans** a goal into a graph of tasks with checks, **routes** each to the right Leg and model by strength, quota and cost, and **verifies** the result by running the checks itself.
- **Watches** every session: drift, loops, edits out of scope, tokens burned without progress; corrects, hands over, or asks you.
- Every agent runs in a **sandbox** (bubblewrap, Landlock, its own network through passt): it sees its job's folder and nothing else.
- **Approvals that make sense**: risky actions ask you, with what happens if you say no; routine work doesn't. Autonomy per job.
- **The Eye talks to you** in each project's conversation: what got done, a summary when a job ends, what it needs.
- **Jobs named by what they are**, described by what they did.

**Projects and code**
- A **project page** for everything: the conversation with The Eye, the **Workflow** diagram of its jobs, the work history, Silk (what the project knows), budget and stats, its repos and servers.
- **One repo or several**; each job works on its own branch per repo, merged and pushed by Oraknid when you ask.
- **GitHub**: several accounts, a repo linked to each project, created and pushed without fuss; **Repos** browses your repositories, code, commits with diffs, branches and pull requests.
- **Terminal** in the browser: tabs, split, grid, on this computer or your servers.

**Servers and operations**
- Add a server over SSH: Oraknid **reads what runs there** and keeps a **state document** of it.
- **Monitoring**: CPU, memory, disk, network; **Docker** containers, images and volumes; **databases**; the **reverse proxy** with its sites and certificates; live **traffic** and **logs**.
- **Deploys** to a project's servers by role (testing, production), confirmed for production.
- **Database backups** on a schedule (PostgreSQL, MySQL/MariaDB, MongoDB, Redis, SQLite, in Docker or not), compressed, **encrypted with age**, kept on this computer, another server or cloud storage; Test connection, Verify, and a two-step Restore.
- **Cloud storage**: every provider rclone supports (Google Drive, Dropbox, OneDrive, MEGA, S3, B2, SFTP, WebDAV and more) as **one pool**; uploads go where they fit.

**Everyday**
- **Mail**: IMAP and POP3 accounts with app passwords; agents read, sort and draft, and nothing is sent without you.
- **Chats** with any of your models, and a **helper** that knows the guide and your screens: it takes you to the page and points at the option you're looking for.
- **From your phone**: pair it with a QR code; an end-to-end encrypted relay (**The Nest**, which you can host yourself) lets you approve, follow and steer from anywhere; a PIN locks every device.

## Install

On Linux, as yourself (it asks for `sudo` only to install missing packages):

```sh
# the latest release (main follows the releases; v0.1.0 now)
curl -fsSL https://raw.githubusercontent.com/ABakdi/Oraknid/main/install.sh | sh

# exactly v0.1.0: the script attached to its release
curl -fsSL https://github.com/ABakdi/Oraknid/releases/download/v0.1.0/install.sh | sh

# the newest work, from the dev branch
curl -fsSL https://raw.githubusercontent.com/ABakdi/Oraknid/dev/install.sh | sh -s -- --dev
```

It installs what is missing (git, Node 22.12+, pnpm, bubblewrap, passt,
Python 3, a C++ compiler, and rclone for Cloud storage), builds Oraknid into
`~/.local/share/oraknid/app`, links `oraknid` into `~/.local/bin`, checks the
machine (`oraknid doctor`), and runs it in the background with systemd, OpenRC
or runit. It ends with the address to open and a pairing code. Running it again
updates; `--uninstall` removes it and keeps your data.
Update from Settings → About, or `oraknid update` ([how](docs/04-Decisions/ADR-048-Updates.md)).

Options: `--dev`, `--ref <branch or tag>`, `--dir <path>`, `--from <path or URL>`,
`--no-service`, `--uninstall` ([how it works](docs/04-Decisions/ADR-036-One-Script-Install.md)).
Tested on Arch, Debian, Ubuntu, Fedora, Alpine and openSUSE.

**Away from home**: pair your phone through a public Nest
(`oraknid.abakdi.com`) or [host your own](https://oraknid.abakdi.com/docs/nest.html).

## Documentation

- **[The guide](https://oraknid.abakdi.com/docs/)**: getting started, jobs and The Eye,
  agents, projects and servers, backups, storage, mail, your phone, security.
  It is also inside Oraknid, under Docs.
- **[The design canon](docs/Home.md)**: vision, specifications, architecture,
  every decision (ADRs) and the [roadmap](docs/03-Planning/Roadmap.md). Oraknid
  is built canon first; the canon opens as an Obsidian vault.
- **[Changelog](CHANGELOG.md)**.

## Development

Needs Linux, Node 22.12+ and pnpm 9.

```sh
pnpm install
pnpm check                  # lint, typecheck, every package's tests, then the timing test
pnpm build                  # the daemon, the web UI, the Nest and the site

cd apps/daemon
pnpm exec tsx src/cli.ts doctor
pnpm exec tsx src/cli.ts start      # also: status, open, pair, stop, logs, install
```

Data lives in `$XDG_DATA_HOME/oraknid` (override with `ORAKNID_DATA_DIR`); the
daemon listens on `127.0.0.1:7417`.

```
apps/daemon/          the service: The Eye, the API, the live socket, the CLI (`oraknid`)
apps/web/             the web UI, served by the daemon
apps/nest/            The Nest: the relay for away from home, and the phone loader
apps/site/            the product site and the guide
packages/contracts/   every entity, API shape and live frame, defined once (Zod)
packages/core/        pure rules: life cycles, routing, the command policy
packages/os/          Linux: sandbox, sleep lock, secrets, metrics, notifications, services
packages/tunnel/      the end-to-end encrypted tunnel between a device and the daemon
packages/legs/        the Leg SDK and adapters: claude-code, opencode, antigravity, openai-compatible
docs/                 the canon
```

## Contact

Built by Abderrahmane Bakdi: [a.bakdi@abakdi.com](mailto:a.bakdi@abakdi.com) ·
[GitHub](https://github.com/ABakdi) ·
[LinkedIn](https://www.linkedin.com/in/abderrahmane-bakdi-171b821bb).
Questions, ideas, or a Leg you want supported: write to me.
