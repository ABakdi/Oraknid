# Projects, repos and servers

## Projects

A **project** is a folder where jobs work: one you have, a new empty one, a new GitHub repo (on the account you pick, when you have more than one), one of your GitHub repos, or any git URL. With git, every job has its own branch and worktree; without git, Oraknid keeps checkpoints in a shadow repository so you can still roll back.

**Several repos.** A project can also be a folder holding several git repositories, each in its own folder (a site in `web/`, its API in `api/`): they are found when you add the project, and the **Repo** tab lists them, each with its folder, its branches and its own GitHub repo. **Add a repo** adds one later (a folder of the project that is a repo, a new empty one, or a clone), **Find repos in its folder** looks again. The pencil on a repo's row renames it in the project, or changes its release branch (where jobs start from) and work branch (where they merge), while no job of the project runs. A job works in the repos its tasks touch: each gets the job's branch, each task's work is committed in each repo it changed with its own message, and **Merge** merges every repo's branch into that repo's work branch (or none, when one conflicts).

A project's page is where you work: its **The Eye**, **Workflow**, **Work**, **Repo**, **Inbox**, **Silk**, **Activity** and **Budget & stats** tabs (see [Jobs and The Eye](/docs/jobs.html)), and its **Settings**, **Skills** (which skills its jobs may use), **Servers** and **Network**. A project can have a budget across all its jobs.

## GitHub

Add one or more GitHub accounts in **Settings → Connections → GitHub**, each with a token. A token stays in your keychain, is given to git only for the command that needs it, and never to an agent.

A project has its own **GitHub repo**, on its **Repo** tab: which repo and account, its latest commits, branches and open pull requests, and **Browse the code** (in Repos). When work needs GitHub and none is set, The Eye asks you once in the project's conversation (which account, a new repo or one of yours, public or private) and saves your answer. From then on Oraknid creates the repo, pushes and opens pull requests there itself, without asking; a force-push or a push anywhere else still asks.

In a project of several repos, each repo has its own link, set on its section of the Repo tab, and The Eye asks once for each repo the work needs; Oraknid pushes each to its own repo.

**Repos** (`g r`) shows your repositories from every account: browse their code at any branch, read the commit history with each change, branches and pull requests, and link one to a project or start new work on it.

## Network

Agents reach the internet, but none of the services running on your computer. If a project needs one (a local Postgres on 5432, say), list its port in the project's **Network** tab. A Leg that uses a local model can always reach that model.

## Servers

Add a server with its address and a password or key. Oraknid installs a key of its own, reads what runs there (only reads) and writes a **state document**: services, ports, what must not break. A small `oraknid-monitor` script reports CPU, memory, disk and network every few seconds.

A server's page has tabs for what runs there, each read only while you look at it and never stored:

- **Docker**: containers grouped by compose project, with their state, health, uptime, ports, CPU and memory; images, volumes and networks, with the unused ones marked.
- **Databases**: PostgreSQL, MySQL or MariaDB, MongoDB and Redis, whether they run as services or in containers: version, state, port, and size when it can be read.
- **Proxy & traffic**: nginx, Caddy, Traefik or HAProxy, its sites and where they send requests, its certificates and when they end (red two weeks before), its config check; then the last 15 minutes of requests, status codes, top paths and clients, and connections per port.
- **Logs**: a service's, a container's or the proxy's log, followed live while the tab is open, or searched.
- **Backups**, a **Terminal** on the server, and its **State document**.

When something can't be read, the tab says why and what to do (for Docker, add the server's user to the `docker` group; for the proxy's logs, to `adm`): Oraknid never asks for root to look. **Restart** on a container, a database or the proxy asks you first, and every restart is in the audit log. The helper can read all of it too ("what's unhealthy on my VPS?").

Give a server to a project, with a **role** there (testing, staging, production…: a word of yours, set next to it in the project's Settings), and that project's jobs can reach it by name (`ssh <alias>`), with its state document in mind. A server can have a different role in each project.

When work needs a server, say which: "deploy to staging", or "on vps-2". The Eye finds it by its role or its name and only asks you to confirm ("Deploy to production, vps-2?"). If you don't say, it asks with your servers, the project's by role first, then **Add a new server**, which sends you to the add dialog and asks again as soon as it's added. **Production** (a role named so, or one you mark) is always confirmed, even when it's the only server. Your choice is kept for the job and saved to the project with its role. Anything that changes the server goes through your approvals, and the document is brought up to date after.

## Terminal

**Terminal** opens shells on your computer or your servers, in tabs, side by side or in a grid. It is off until you turn it on: it is a full shell as you.

| Keys | Does |
| :-- | :-- |
| Ctrl Shift Enter | New terminal |
| Ctrl Shift X | Close it |
| Ctrl Shift Left / Right, 1 to 9 | Move between terminals |
| Ctrl Shift D, G, F | Side by side, grid, one at a time |
| Select, Ctrl Shift V | Copy, paste |
