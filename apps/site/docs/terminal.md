# Oraknid in a terminal

Everything Oraknid does can be done from a terminal: on a server without a desktop, over SSH, or because you'd rather stay in one. Run:

```sh
oraknid
```

(`oraknid tui` is the same.) Oraknid must be running (`oraknid status`); the terminal app talks to it on this computer, with the command line's own key, so there is nothing to pair and no PIN to type. Away from this computer, use the web interface through your Nest, or SSH to the computer and run `oraknid` there.

## The conversation

The screen is The Eye's conversation with the current project, the same as the project's page in the web interface:

- your prompts are marked `›`;
- The Eye's replies are rendered (headings, lists, code), with what it did and the job it touched under each;
- while The Eye thinks, its line shows what it is doing and for how long, with what it writes as it comes; once it ends, it folds to one line ("Planned 9 tasks in 41 s");
- what the agents are doing now is a line per running task, at the bottom.

Type at the prompt and press **Enter** to send: The Eye passes it to the job running, starts a follow-up when the last one ended, or a first job. A line ending in `\` goes on to a new one.

While The Eye is thinking, **Esc** stops it. What you write then is either a correction ("no, use Postgres": it stops and thinks again with it) or more context for what comes next: Oraknid guesses which from your words, the line above the prompt says which, and **Tab** switches it.

When The Eye asks questions, they are listed under its reply with their options numbered; `/answer` takes you through them, a number picking an option.

At the first start with more than one project, pick one with `/projects`; the terminal remembers it for the next time.

## Commands

Type `/` and the commands are listed; keep typing to narrow them, **↑↓** to choose, **Tab** to complete, **Enter** to run. Lists are numbered: type a number to pick (at once when no longer number fits), or **↑↓** and **Enter**. **Esc** goes back one step. `/help` lists them all.

| Command | What it does |
| :-- | :-- |
| `/projects`, `/project <n>` | Your projects; picking one makes the prompt talk to its Eye |
| `/jobs`, `/job <n>` | The project's jobs (`/jobs all`: every project's); a job's plan as a tree, a number opens a task |
| `/logs` | The job's sessions and their logs; on a server, its logs, followed live; else Oraknid's own |
| `/pause`, `/resume`, `/cancel`, `/redirect <instruction>` | The current job; `/cancel` with none chosen cancels the job this conversation is about, after y/N |
| `/inbox` | Questions and approvals waiting for you, answered by number or in your words |
| `/servers`, `/server <n>` | Your servers; picking one shows its overview |
| `/chat` | The server's Eye: ask about it, or for work on it (again: back to the project's) |
| `/docker`, `/db`, `/proxy`, `/state` | What runs on the server: containers, databases, proxies and certificates, its state document |
| `/ssh` | A shell on the server, through Oraknid's key; **Ctrl+]** leaves it |
| `/backups` | Backup plans and their runs (the server's, when one is chosen); run one now |
| `/agents`, `/models` | Your Legs, their models, plan windows and quota; local models |
| `/usage`, `/health` | Tokens and plan windows; this computer: danger, tasks running, tasks paused for room |
| `/mail`, `/repos`, `/storage`, `/chats`, `/skills` | Mail accounts and threads, GitHub repositories, disk and cloud storage, chats, skills |
| `/settings` | The common settings by name: `/settings max-running-jobs 3`, `/settings terminal on` |
| `/update`, `/doctor` | A newer Oraknid, and updating to it; what is wrong with this computer |
| `/quit` | Leave; Oraknid keeps running (**Ctrl+C** twice does the same) |

`/ssh` uses the same terminal as the web interface: it is off until you turn it on (`/settings terminal on`), and every shell opened is recorded.

## Told when it matters

A question or an approval for you, or the computer in danger, shows in a line at the top of the screen, with the terminal's bell. `/inbox` answers it.

## Without the web interface

Installed with `--no-gui`, Oraknid has no web pages at all: it builds and installs less, and the address `http://127.0.0.1:7417` only says to use `oraknid` in a terminal. Everything else works the same, except a phone: it loads the web interface from your computer, so pairing one says it needs it. Add it any time with:

```sh
oraknid install --gui
```

It builds the web interface, restarts Oraknid with it, and updates keep it from then on.
