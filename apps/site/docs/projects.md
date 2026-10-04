# Projects, repos and servers

## Projects

A **project** is a folder where jobs work. With git, every job has its own branch and worktree; without git, Oraknid keeps checkpoints in a shadow repository so you can still roll back.

**Making one.** In **Projects**, press **New project**. Give it a **name**, then say where it comes from:

- **New** (the default): Oraknid makes the project's folder, named after the project (change the name if you like), inside the folder you choose under **Where it goes**, and makes it a git repo. The folder you used last time is offered again. With GitHub connected, **Also a new GitHub repo** makes one on the account you pick (private unless you switch it off), clones it there and links the project to it.
- **A folder on this computer**: the folder you choose *is* the project: a repo, or a folder holding several. If it isn't a git repo, you're asked whether to make it one or to leave it alone (checkpoints in a shadow repository).
- **From GitHub**: with GitHub connected, pick one of your repos from the list (search it, and choose the account when you have several), or paste a link; without an account, paste a link: only a public repo can be cloned that way. Under **Clone it into**, choose where its folder goes.

A line at the bottom says exactly what will happen before it does, for example *Creates /home/me/code/piano and makes it a git repo.* or *Clones ABakdi/piano into /home/me/code/piano and links the project to it.* **New work**'s "A new project…" is the same form.

**Choosing a folder.** Every folder field has **Choose…**, which opens the folder picker: the folders on the computer Oraknid runs on, even when you use it from your phone. Click a folder to open it, use the path at the top or **Up** and **Home** to go back, **New folder** to make one where you are, and **Choose this folder** when you're there. Repos are marked **git**. You can also type a path (`~/code` works). The picker only lists folders, never your files.

**Several repos.** A project can also be a folder holding several git repositories, each in its own folder (a site in `web/`, its API in `api/`): they are found when you add the project, and the **Repo** tab lists them, each with its folder, its branches and its own GitHub repo. **Add a repo** adds one later (a folder of the project that is a repo, a new empty one, or a clone), **Find repos in its folder** looks again. The pencil on a repo's row renames it in the project, or changes its release branch (where jobs start from) and work branch (where they merge), while no job of the project runs. A job works in the repos its tasks touch: each gets the job's branch, each task's work is committed in each repo it changed with its own message, and **Merge** merges every repo's branch into that repo's work branch (or none, when one conflicts).

A project's page is where you work: its **The Eye**, **Workflow**, **Work**, **Repo**, **Inbox**, **Silk**, **Activity** and **Budget & stats** tabs (see [Jobs and The Eye](/docs/jobs.html)), and its **Settings**, **Skills** (which skills its jobs may use), **Servers** and **Network**. A project can have a budget across all its jobs. Its header has **Open folder** (the project's folder in your file manager, to look or test by hand) and **Terminal here** (a terminal that starts in that folder).

**Archiving and deleting.** Both are in the project's **…** menu (in its header and on its card in the list) and on its **Settings** tab.

- **Archive** moves the project to **Archived projects**, at the bottom of the list: hidden from New work, everything kept, and **Unarchive** brings it back. If jobs are running you're asked to cancel them first. You can also tick **Archive the GitHub repo** (it becomes read-only on GitHub) and **Delete the project folder from this computer to free space**. The folder option is only offered when nothing would be lost: every repo linked to GitHub, everything committed and every branch pushed; otherwise it says what isn't (*site: commits not on GitHub, on dev (2).*). When you unarchive, the repos it archived are offered back, and a deleted folder is cloned back from GitHub to the same place, each repo where it was.
- **Delete** can't be undone. The project and its jobs' history always leave Oraknid. Tick **Delete the project folder from this computer** to remove the folder too (its path and size are shown; worktrees go with it), and **Delete the GitHub repo** for each linked repo you want gone on GitHub. With either ticked, type the project's name to enable **Delete**. Oraknid won't delete your home folder, a top-level folder, a folder holding another project, or anything a link points to, and only deletes a GitHub repo its account owns.

Deleting a GitHub repo needs a token with the **delete_repo** permission (a classic token) or **Administration: Read and write** (a fine-grained one). Without it GitHub refuses and Oraknid tells you; nothing else is deleted then, so you can grant it in **github.com → Settings → Developer settings → Personal access tokens**, paste the token again in **Settings → Connections → GitHub**, and delete again. Afterwards the dialog lists each step: done, not done (and why), or skipped.

## GitHub

Add one or more GitHub accounts in **Settings → Connections → GitHub**, each with a token. A token stays in your keychain, is given to git only for the command that needs it, and never to an agent.

A project has its own **GitHub repo**, on its **Repo** tab: which repo and account, its latest commits, branches and open pull requests, and **Browse the code** (in Repos). When work needs GitHub and none is set, The Eye asks you once in the project's conversation (which account, a new repo or one of yours, public or private) and saves your answer. From then on Oraknid creates the repo, pushes and opens pull requests there itself, without asking; a force-push or a push anywhere else still asks.

In a project of several repos, each repo has its own link, set on its section of the Repo tab, and The Eye asks once for each repo the work needs; Oraknid pushes each to its own repo.

**Repos** (`g r`) shows your repositories from every account: browse their code at any branch, read the commit history with each change, branches and pull requests, and link one to a project or start new work on it.

## Network

Agents reach the internet, but none of the services running on your computer. If a project needs one (a local Postgres on 5432, say), list its port in the project's **Network** tab. A Leg that uses a local model can always reach that model.

## Servers

Add a server with its address and a password or key. Oraknid installs a key of its own, reads what runs there (only reads) and writes a **state document**: services, ports, what must not break. A small `oraknid-monitor` script reports CPU, memory, disk and network every few seconds.

For a key, **choose its file** (usually `~/.ssh/id_ed25519`, the one without `.pub`; in the file picker, Ctrl+H shows hidden folders like `.ssh`) or drop it on the box: the dialog shows the file's name and the kind of key it read, and asks for the passphrase when the key has one. **Paste it instead** is there too. A public key (`.pub`) is caught before you save. **Fix wording** next to the description tidies your words (spelling, grammar, clarity, nothing added), and **Undo** brings yours back.

**Test connection** tries what you typed before you save: it says "Logged in as root: Linux 6.1 (vps1)" with the server's host key, or why not, in plain words (wrong password or key, passphrase needed, no such host, nothing listening on that port, no answer, or a host key that changed).

Made a mistake, or the server moved? **Edit** in its header (or **Fix the connection** under its error) opens the same dialog filled in: change the name, description, address, port, user, key or password, and test again. Leave the key and password empty to keep the ones you gave. A new address forgets the old host key; a new password means **Set up** again.

A server's page has tabs for what runs there, each read only while you look at it and never stored:

- **Docker**: containers grouped by compose project, with their state, health, uptime, ports, CPU and memory; images, volumes and networks, with the unused ones marked.
- **Databases**: PostgreSQL, MySQL or MariaDB, MongoDB and Redis, whether they run as services or in containers: version, state, port, and size when it can be read.
- **Proxy & traffic**: nginx, Caddy, Traefik or HAProxy, its sites and where they send requests, its certificates and when they end (red two weeks before), its config check; then the last 15 minutes of requests, status codes, top paths and clients, and connections per port.
- **Logs**: a service's, a container's or the proxy's log, followed live while the tab is open, or searched.
- **Backups**, a **Terminal** on the server, and its **State document**.

When something can't be read, the tab says why and what to do (for Docker, add the server's user to the `docker` group; for the proxy's logs, to `adm`): Oraknid never asks for root to look. **Restart** on a container, a database or the proxy asks you first, and every restart is in the audit log. The helper can read all of it too ("what's unhealthy on my VPS?").

Give a server to a project, with a **role** there (testing, staging, production…: a word of yours, set next to it in the project's Settings), and that project's jobs can reach it by name (`ssh <alias>`), with its state document in mind. A server can have a different role in each project.

When work needs a server, say which: "deploy to staging", or "on vps-2". The Eye finds it by its role or its name and only asks you to confirm ("Deploy to production, vps-2?"). If you don't say, it asks with your servers, the project's by role first, then **Add a new server**, which sends you to the add dialog and asks again as soon as it's added. **Production** (a role named so, or one you mark) is always confirmed, even when it's the only server. Your choice is kept for the job and saved to the project with its role. Anything that changes the server goes through your approvals, and the document is brought up to date after.

A server's databases can be backed up on a schedule, encrypted, to this computer or another server: see [Backups](/docs/backups.html).

## Terminal

**Terminal** opens shells on your computer or your servers, in tabs, side by side or in a grid. It is off until you turn it on: it is a full shell as you.

| Keys | Does |
| :-- | :-- |
| Ctrl Shift Enter | New terminal |
| Ctrl Shift X | Close it |
| Ctrl Shift Left / Right, 1 to 9 | Move between terminals |
| Ctrl Shift D, G, F | Side by side, grid, one at a time |
| Select, Ctrl Shift V | Copy, paste |
