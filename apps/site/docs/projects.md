# Projects, repos and servers

## Projects

A **project** is a folder where jobs work: one you have, a new empty one, a new GitHub repo, one of your GitHub repos, or any git URL. With git, every job has its own branch and worktree; without git, Oraknid keeps checkpoints in a shadow repository so you can still roll back.

A project's page has tabs for its **Jobs**, **Stats**, **Skills** (which skills its jobs may use), **Servers**, **Network** and **Commands** (its own command rules).

## GitHub

Paste a token in **Settings → Connections → GitHub** to create and clone your repos. The token stays in your keychain, is given to git only for the command that needs it, and never to an agent.

## Network

Agents reach the internet, but none of the services running on your computer. If a project needs one (a local Postgres on 5432, say), list its port in the project's **Network** tab. A Leg that uses a local model can always reach that model.

## Servers

Add a server with its address and a password or key. Oraknid installs a key of its own, reads what runs there (only reads) and writes a **state document**: services, ports, what must not break. A small `oraknid-monitor` script reports CPU, memory, disk and network every few seconds.

Give a server to a project, and that project's jobs can reach it by name (`ssh <alias>`), with its state document in mind. Anything that changes the server goes through your approvals, and the document is brought up to date after.

## Terminal

**Terminal** opens shells on your computer or your servers, in tabs, side by side or in a grid. It is off until you turn it on: it is a full shell as you.

| Keys | Does |
| :-- | :-- |
| Ctrl Shift Enter | New terminal |
| Ctrl Shift X | Close it |
| Ctrl Shift Left / Right, 1 to 9 | Move between terminals |
| Ctrl Shift D, G, F | Side by side, grid, one at a time |
| Select, Ctrl Shift V | Copy, paste |
