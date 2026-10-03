# Projects, repos and servers

## Projects

A **project** is a folder where jobs work: one you have, a new empty one, a new GitHub repo, one of your GitHub repos, or any git URL. With git, every job has its own branch and worktree; without git, Oraknid keeps checkpoints in a shadow repository so you can still roll back.

A project's page is where you work: its **The Eye**, **Workflow**, **Work**, **Inbox**, **Silk**, **Activity** and **Budget & stats** tabs (see [Jobs and The Eye](/docs/jobs.html)), and its **Settings**, **Skills** (which skills its jobs may use), **Servers** and **Network**. A project can have a budget across all its jobs.

## GitHub

Add one or more GitHub accounts in **Settings → Connections → GitHub**, each with a token. A token stays in your keychain, is given to git only for the command that needs it, and never to an agent.

A project has its own **GitHub repo**, in its Settings next to its servers. When work needs GitHub and none is set, The Eye asks you once in the project's conversation (which account, a new repo or one of yours, public or private) and saves your answer. From then on Oraknid creates the repo, pushes and opens pull requests there itself, without asking; a force-push or a push anywhere else still asks.

**Repos** (`g r`) shows your repositories from every account: browse their code at any branch, read the commit history with each change, branches and pull requests, and link one to a project or start new work on it.

## Network

Agents reach the internet, but none of the services running on your computer. If a project needs one (a local Postgres on 5432, say), list its port in the project's **Network** tab. A Leg that uses a local model can always reach that model.

## Servers

Add a server with its address and a password or key. Oraknid installs a key of its own, reads what runs there (only reads) and writes a **state document**: services, ports, what must not break. A small `oraknid-monitor` script reports CPU, memory, disk and network every few seconds.

Give a server to a project (The Eye asks which one when the work needs a server and you have several), and that project's jobs can reach it by name (`ssh <alias>`), with its state document in mind. Anything that changes the server goes through your approvals, and the document is brought up to date after.

## Terminal

**Terminal** opens shells on your computer or your servers, in tabs, side by side or in a grid. It is off until you turn it on: it is a full shell as you.

| Keys | Does |
| :-- | :-- |
| Ctrl Shift Enter | New terminal |
| Ctrl Shift X | Close it |
| Ctrl Shift Left / Right, 1 to 9 | Move between terminals |
| Ctrl Shift D, G, F | Side by side, grid, one at a time |
| Select, Ctrl Shift V | Copy, paste |
