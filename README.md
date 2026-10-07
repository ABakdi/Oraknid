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
want; **The Eye** plans the work into whole tasks with checks, hands each to
the agent that fits it best (Claude Code, OpenCode, Antigravity, or Oraknid's
own agent on any model, local or remote), watches them, climbs to a stronger
model when one fails, and only calls a task done when its checks pass. Around
that sits everything a project needs: its GitHub repos, the servers it deploys
to, what runs on them, their databases' backups, your cloud storage and your
mail, all in one interface you can also use from your phone, or from a
terminal.

> **v0.2.4 is a pre-release.** It is used daily by its author, tested end to
> end, and still young: expect rough edges, and report them. Versions stay
> 0.x.y until 1.0 ([changelog](CHANGELOG.md)).

## What it does

**Agents and The Eye**
- Runs **Claude Code, OpenCode, Antigravity** and any **OpenAI-compatible** model (Ollama, LM Studio, llama.cpp, vLLM, OpenRouter) as *Legs*, several accounts each, found on your machine in one click. **Oraknid's own agent** gives any model Claude-Code-like tools in the sandbox.
- **Plans** a goal into whole tasks with checks (split only where the pieces are independent), **routes** each to the cheapest model likely to do it, **climbs the ladder** to a stronger one when it fails (with a Claude share you set), and never picks an agent that is out of quota, paused or deprecated.
- **Verifies** by running the checks itself; the agent runs them too before it ends. A check that is broken itself is repaired, never held against the agent.
- **Watches** every session: drift, loops, edits out of scope, tokens burned without progress; corrects, hands over, or asks you.
- Every agent runs in a **sandbox** (bubblewrap, Landlock, its own network through passt): it sees its job's folder and nothing else.
- **Auto mode**: open-source rules (tree-sitter-bash, CC Safety Net, secretlint) settle ordinary commands at once and block dangerous ones; a model judge decides the rest. You're asked only for a server job's plan, changes on production, sending, publishing, deleting and paying, or an agent stuck on blocks. Autonomy per job: Auto, Careful or Full.
- **Parallel by default**, within what your computer can take: memory, CPU and disk watched, work paused before it gets into danger, and you told once.
- **The Eye thinks out loud** in a terminal-like transcript: stop it or redo it with your words; **Cancel** a job from the conversation.
- **The Eye talks to you** in each project's conversation: what got done, a summary when a job ends, what it needs.
- **Jobs named by what they are**, described by what they did.

**Projects and code**
- A **project page** for everything: the conversation with The Eye, the **Workflow** diagram of its jobs, the work history, Silk (what the project knows), budget and stats, its repos and servers.
- **One repo or several**; each job works on its own branch per repo, merged and pushed by Oraknid when you ask.
- **GitHub**: several accounts, a repo linked to each project, created and pushed without fuss; **Repos** browses your repositories, code, commits with diffs, branches and pull requests.
- **Terminal** in the browser: tabs, split, grid, on this computer or your servers.
- **Local models**: search Hugging Face and Ollama's library for what fits your machine, download (resumable, checked), run with llama.cpp or Ollama, and give them roles (translate, OCR, speech to text, embeddings) every agent can use.
- **Archive or delete** a project, choosing what happens to its repos and folder.

**Servers and operations**
- Add a server over SSH: Oraknid **reads what runs there** and keeps a **state document** of it. Each server has a **chat**: ask about it, or send an agent into it as a **server job**, its plan approved by you first, its state document updated after.
- **Monitoring**: CPU, memory, disk, network; **Docker** containers, images and volumes; **databases**; the **reverse proxy** with its sites and certificates; live **traffic** and **logs**.
- **Deploys** to a project's servers by role (testing, production), confirmed for production.
- **Database backups** on a schedule (PostgreSQL, MySQL/MariaDB, MongoDB, Redis, SQLite, in Docker or not), compressed, **encrypted with age**, kept on this computer, another server or cloud storage; Test connection, Verify, and a two-step Restore.
- **Cloud storage**: every provider rclone supports (Google Drive, Dropbox, OneDrive, MEGA, S3, B2, SFTP, WebDAV and more) as **one pool**; uploads go where they fit.

**Everyday**
- **Mail**: IMAP and POP3 accounts with app passwords; agents read, sort and draft, and nothing is sent without you.
- **Chats** with any of your models, and a **helper** that knows the guide and your screens: it takes you to the page and points at the option you're looking for.
- **From your phone**: pair it with a QR code; an end-to-end encrypted relay (**The Nest**, which you can host yourself) lets you approve, follow and steer from anywhere; a PIN locks every device.
- **From a terminal**: `oraknid` opens The Eye's conversation with slash commands for everything else; a server can run Oraknid with no web UI at all.
- **Updates from inside**: Oraknid tells you of a new version and installs it in one click, its database copied first, rolled back if the new version doesn't start.

## Install

On Linux, as yourself (it asks for `sudo` only to install missing packages):

```sh
# the latest release (main follows the releases; v0.2.4 now)
curl -fsSL https://raw.githubusercontent.com/ABakdi/Oraknid/main/install.sh | sh

# exactly v0.2.4: the script attached to its release
curl -fsSL https://github.com/ABakdi/Oraknid/releases/download/v0.2.4/install.sh | sh

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
`--no-service`, `--gui` / `--no-gui`, `--local-models` (llama.cpp's `llama-server`
built for your GPU: CUDA, ROCm, Vulkan or CPU), `--uninstall`
([how it works](docs/04-Decisions/ADR-036-One-Script-Install.md)).
Models are then found, downloaded and run from **Models** in Oraknid
([the guide](https://oraknid.abakdi.com/docs/models.html)).

**In a terminal**: `oraknid` alone opens Oraknid in the terminal: The Eye's
conversation, a prompt, and slash commands for everything else (`/projects`,
`/jobs`, `/inbox`, `/servers`…; [the guide](https://oraknid.abakdi.com/docs/terminal.html)).
On a server or over SSH, install it **terminal only** with `--no-gui`: no web UI
is built (asked when you don't say; without a terminal to ask on, terminal only
when there is no display). `oraknid install --gui` adds the web UI later.
Tested on Arch, Debian, Ubuntu, Fedora, Alpine and openSUSE.

**Away from home**: pair your phone through a public Nest
(`oraknid.abakdi.com`) or [host your own](https://oraknid.abakdi.com/docs/nest.html).

## Documentation

- **[The guide](https://oraknid.abakdi.com/docs/)**: getting started, jobs and The Eye,
  the terminal app, agents, local models, projects and servers, backups, storage,
  mail, your phone, security.
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
apps/daemon/          the service: The Eye, the Gate, the API, the live socket, the CLI and terminal app (`oraknid`)
apps/web/             the web UI, served by the daemon
apps/nest/            The Nest: the relay for away from home, and the phone loader
apps/site/            the product site and the guide
packages/contracts/   every entity, API shape and live frame, defined once (Zod)
packages/core/        pure rules: life cycles, routing and the ladder, the command policy, the Gate's decision, admission
packages/guard/       auto mode's rules: commands parsed, dangerous ones blocked, secrets caught; the judge's shape
packages/os/          Linux: sandbox, sleep lock, secrets, metrics, notifications, services
packages/tunnel/      the end-to-end encrypted tunnel between a device and the daemon
packages/legs/        the Leg SDK and adapters: claude-code, opencode, antigravity, openai-compatible, oraknid-agent
docs/                 the canon
```

## Contact

Built by Abderrahmane Bakdi: [a.bakdi@abakdi.com](mailto:a.bakdi@abakdi.com) ·
[GitHub](https://github.com/ABakdi) ·
[LinkedIn](https://www.linkedin.com/in/abderrahmane-bakdi-171b821bb).
Questions, ideas, or a Leg you want supported: write to me.
