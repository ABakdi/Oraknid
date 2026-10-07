# Repos

**Repos** (`g r`) shows your GitHub repositories, from every GitHub account you added in **Settings → Connections → GitHub**. Oraknid reads them through GitHub's API with the account's token, which never reaches your browser; nothing is cloned just to browse.

## The list

On the left, every repository (each listed once, newest push first), or only one account's. Search by name, description or project, and filter by visibility. Each row says whether it is public or private, its description, default branch, last push, the account that reads it, and the project it is linked to. An account GitHub can't read is named above the list, with why.

**New repository** asks for the account, a name, a description and whether it is private (the default); it is made with a README, so it can be cloned at once, and opens when it is ready. A new repository is made at home, or from a device with full rights.

With no repository open, the right side shows your **GitHub accounts** (add, check, remove) and each account's hourly allowance in words. On a small screen, **Accounts** above the list opens them.

## A repository

A repository opens in tabs, with **Open on GitHub** in its header:

- **Code**: pick a branch, walk the folders, read the README; a file shows with line numbers and colours. A binary file, or one over 512 KB, says so and links to GitHub.
- **Commits**: a branch's history, 30 at a time, and each commit with its message, author and changes.
- **Branches**: each branch, its default and protected ones marked.
- **Pull requests**: open or closed (merged said), each with its description, commits and changes.
- **Project**: the project linked to it (open it, or start **New work on it**), or **Link** it to a project, or start new work that clones it.

Changes are shown per file, folded with a click, with their counts, added lines green and removed lines red. Past 25 files, each one opens when you ask.

## Linking a project

A project's own GitHub link is set on its **Repo** tab ([Projects, repos and servers](projects.html#github)); linking from here does the same. A repository already linked to another project asks first. Away from home, linking needs a device with full rights.

The [helper](chats.html) lists your repositories too: ask it "which of my repos aren't in a project?".

## CI (GitHub Actions)

A repository's **CI** tab in Repos, and a project's **CI** tab (one section per linked repo), show its GitHub Actions without leaving Oraknid:

- **Runs**, newest first, all branches or the one you pick: passed, failed or running, the workflow, the commit, what started it, who, how long.
- **A run**: its jobs and their steps, the failing job opened. Its **log** comes by step with the failing step first and open; the search box keeps only the lines that match. Its **artifacts** download through Oraknid (on the computer running it, not from your phone).
- **Re-run failed jobs**, **Re-run all** and **Cancel**, each after saying what will happen. **Run workflow** starts a workflow that can be run by hand (`on: workflow_dispatch`) on the branch or tag you name, with its inputs.
- A **CI badge** after a project's name says whether its release branch passes (else its work branch); a job's page shows the badge of the pull request or branch it pushed, and The Eye's "Job done" note shows it too.
- When a run on a linked repo's release or work branch fails, you're told (desktop and push; change it in **Settings → Notifications**; quiet hours hold it).

Pages refresh every few seconds while something runs and every minute otherwise; GitHub only counts a request when something changed. If GitHub asks Oraknid to slow down, it shows what it had and says when it asks again.

Your token needs **Actions: Read** to see runs (fine-grained tokens), and **Actions: Read and write** to re-run, cancel or run a workflow; a classic token's **repo** covers both (add **workflow** to run one by hand). When it's missing, Oraknid says which permission to add.

The Eye can wait for CI too: a task's check `oraknid github-ci dev` passes once the runs of the branch's pushed commit pass, and fails with the failing step's last lines (`--timeout 30` waits up to 30 minutes; 20 by default). Agents can read runs and a failing log through Oraknid's GitHub tool; a re-run they ask for waits for your approval. The helper can list runs, show a failing log, and re-run one once you confirm. In the terminal, `/ci` lists the project's runs.
