/**
 * The map of the screens (ADR-041): every page, its tabs, and the options
 * on them, each with an id, a name, what it does and where it is. The
 * controls carry the same id as `data-help="<id>"`, so the helper can point
 * at them; a test checks every id here is in the screens. The helper reads
 * this map with each question.
 */

export interface HelpTab {
  id: string;
  name: string;
  does: string;
}

export interface HelpPage {
  id: string;
  /** Its address: `{item}` and `{tab}` are filled in, or dropped from the end. */
  path: string;
  name: string;
  does: string;
  /** What `{item}` is, when the page has one. */
  item?: string;
  tabs?: HelpTab[];
}

export interface HelpControl {
  id: string;
  /** The page it is on; null: on every screen (the header, the sidebar). */
  page: string | null;
  tab?: string;
  name: string;
  does: string;
  /** Where, in words, as I'd find it. */
  where: string;
  /** A field the helper may fill in for me. */
  field?: boolean;
  /** Its page needs an item (a project, a server). */
  needsItem?: boolean;
  /**
   * What to click first when it isn't on screen: a menu, a dialog, a drawer
   * (each by its id, in order; one not on screen is passed by).
   */
  via?: string[];
}

export const PAGES: HelpPage[] = [
  {
    id: "overview",
    path: "/",
    name: "Overview",
    does: "What runs now: the Legs, the activity, problems, resources, Running now (Pause/Resume) and today's tokens.",
  },
  {
    id: "new",
    path: "/new",
    name: "New work",
    does: "A first request, a new project or a draft: options on the left, the goal and the talk with The Eye on the right.",
  },
  {
    id: "draft",
    path: "/new/{item}",
    item: "a draft job's id",
    name: "A draft",
    does: "A draft job on New work: its options, the conversation with The Eye, Start and Delete.",
  },
  {
    id: "projects",
    path: "/projects/{item}/{tab}",
    item: "a project's id",
    name: "Projects",
    does: "The list of projects, and one open beside it, in tabs: the place I work.",
    tabs: [
      {
        id: "eye",
        name: "The Eye",
        does: "The project's conversation with The Eye: ask for work here.",
      },
      {
        id: "workflow",
        name: "Workflow",
        does: "The project's jobs as a diagram: compact (a box per job, open one for its tasks) or expanded (every job's tasks).",
      },
      {
        id: "repo",
        name: "Repo",
        does: "The project's GitHub repo: which one and through which account, its latest commits, branches and open pull requests, Browse the code (in Repos), and linking, changing or unlinking it.",
      },
      {
        id: "work",
        name: "Work",
        does: "The jobs, newest first; one opens in place (item/work/<job id>).",
      },
      { id: "inbox", name: "Inbox", does: "The project's approvals and questions." },
      { id: "silk", name: "Silk", does: "What the jobs learned and decided, by job." },
      { id: "activity", name: "Activity", does: "Every job's events, live." },
      {
        id: "budget",
        name: "Budget & stats",
        does: "The project's budget across its jobs, and its stats.",
      },
      {
        id: "settings",
        name: "Settings",
        does: "Folder and branches, archive or delete, the project's command rules.",
      },
      {
        id: "skills",
        name: "Skills",
        does: "The skills for this project and the tools they need.",
      },
      { id: "servers", name: "Servers", does: "The servers this project's jobs may use." },
      { id: "network", name: "Network", does: "Ports on this computer its jobs may reach." },
    ],
  },
  {
    id: "inbox",
    path: "/inbox",
    name: "Inbox",
    does: "Approvals and questions from every job, answered in place, with filters.",
  },
  {
    id: "mail",
    path: "/mail/{item}",
    item: "a mail account's id",
    name: "Mail",
    does: "An email client: accounts and folders, the conversations, the open one; agents' drafts wait here.",
  },
  {
    id: "legs",
    path: "/legs/{item}",
    item: "a Leg's id (opens its card)",
    name: "Legs",
    does: "The agents and models Oraknid hands work to: health, models, usage; add or find them.",
  },
  {
    id: "chats",
    path: "/chats/{item}",
    item: "a chat's id",
    name: "Chats",
    does: "Free chats with any Leg and model.",
  },
  {
    id: "servers",
    path: "/servers/{item}/{tab}",
    item: "a server's id",
    name: "Servers",
    does: "My servers over SSH: readings, what runs there (Docker, databases, the proxy, traffic, logs), backups, a terminal, the state document.",
    tabs: [
      {
        id: "overview",
        name: "Overview",
        does: "oraknid-monitor's readings, live and over 24 hours; its name, description, address; edit or remove it.",
      },
      {
        id: "docker",
        name: "Docker",
        does: "Containers by compose project (state, health, uptime, ports, CPU, memory), images, volumes, networks; a container's logs; restart one (asked first).",
      },
      {
        id: "databases",
        name: "Databases",
        does: "PostgreSQL, MySQL/MariaDB, MongoDB, Redis found as services or containers: version, state, port, size when readable; logs, restart.",
      },
      {
        id: "proxy",
        name: "Proxy & traffic",
        does: "The reverse proxy (nginx, Caddy, Traefik, HAProxy): its sites and upstreams, certificates and when they end, the config check; traffic of the last 15 minutes and connections per port.",
      },
      {
        id: "logs",
        name: "Logs",
        does: "A service's, a container's or the proxy's log: the last lines, a search, or followed live while open.",
      },
      {
        id: "backups",
        name: "Backups",
        does: "The server's database backup plans and their backups; a new plan picks from the databases found on it.",
      },
      {
        id: "terminal",
        name: "Terminal",
        does: "A shell on the server (when the terminal is on).",
      },
      { id: "state", name: "State document", does: "What Oraknid knows of the server, editable." },
    ],
  },
  {
    id: "terminal",
    path: "/terminal",
    name: "Terminal",
    does: "Terminals on this computer and my servers, in tabs, side by side or in a grid (when turned on).",
  },
  {
    id: "skills",
    path: "/skills/{item}",
    item: "a skill's id",
    name: "Skills",
    does: "Methods a job follows: view, upload, edit, versions.",
  },
  {
    id: "logs",
    path: "/logs/{tab}",
    name: "Logs",
    does: "What happened (the audit trail) and the daemon's log.",
    tabs: [
      { id: "audit", name: "What happened", does: "The audit trail: search, filters, export." },
      { id: "daemon", name: "Daemon log", does: "The daemon's own log." },
    ],
  },
  {
    id: "settings",
    path: "/settings/{tab}",
    name: "Settings",
    does: "Oraknid's settings, one concern per tab.",
    tabs: [
      {
        id: "general",
        name: "General",
        does: "This computer, storage and pruning, notifications, theme.",
      },
      {
        id: "work",
        name: "Eye & jobs",
        does: "The Eye's models, jobs and tasks at once, same-provider fallback.",
      },
      {
        id: "security",
        name: "Security",
        does: "The PIN and idle lock, what agents may run, the terminal.",
      },
      {
        id: "devices",
        name: "Devices & phone",
        does: "Pairing a phone, paired devices and their rights, The Nest.",
      },
      { id: "connections", name: "Connections", does: "Email accounts, GitHub, tools for skills." },
      {
        id: "backups",
        name: "Backups",
        does: "My servers' database backups: every plan, the latest backups with Verify and Restore, and the age keys.",
      },
    ],
  },
  {
    id: "repos",
    path: "/repos/{item}/{tab}",
    item: "a repository as owner/name",
    name: "Repos",
    does: "My GitHub repositories from every account: a list with a search, and one repository's code, history and pull requests; the GitHub accounts and their allowance beside the list.",
    tabs: [
      {
        id: "code",
        name: "Code",
        does: "Browse the files at a branch, read one with colours and line numbers; the README on the root.",
      },
      {
        id: "commits",
        name: "Commits",
        does: "A branch's history; a commit with its changes file by file.",
      },
      { id: "branches", name: "Branches", does: "The repository's branches." },
      {
        id: "pulls",
        name: "Pull requests",
        does: "Open and closed pull requests; one with its description, commits and changes.",
      },
      {
        id: "project",
        name: "Project",
        does: "Link the repository to a project, open the project that links it, or start new work on it.",
      },
    ],
  },
  {
    id: "storage",
    path: "/storage",
    name: "Cloud storage",
    does: "My storage accounts (Google Drive, Dropbox, MEGA, S3-compatible, and any other provider rclone supports) as one pool: the providers with their used and free space, the pool's folders and files (upload, download, rename, move, delete), and where uploads go. A folder of the pool is /storage/<its path>.",
  },
  {
    id: "docs",
    path: "/docs/{item}",
    item: "a guide page's slug",
    name: "Docs",
    does: "The guide: how to install, run and use Oraknid, with a search.",
  },
];

const S = "settings";

export const CONTROLS: HelpControl[] = [
  // Every screen.
  {
    id: "nav.new-work",
    page: null,
    name: "New work",
    does: "Opens New work.",
    where: "The header, top right; More on a phone",
    via: ["nav.more"],
  },
  {
    id: "nav.search",
    page: null,
    name: "Search or run (Ctrl K)",
    does: "Jumps to a page or a job, or runs a control.",
    where: "The header",
  },
  {
    id: "nav.theme",
    page: null,
    name: "Switch theme",
    does: "Dark or light.",
    where: "The header, the sun or moon",
  },
  {
    id: "nav.fold",
    page: null,
    name: "Fold the sidebar",
    does: "Folds the sidebar to icons ( [ ).",
    where: "The bottom of the sidebar (wide screens)",
  },
  {
    id: "nav.docs",
    page: null,
    name: "Docs",
    does: "Opens the guide.",
    where: "The sidebar; More on a phone",
    via: ["nav.more"],
  },
  // Overview.
  {
    id: "overview.legs",
    page: "overview",
    name: "Legs now",
    does: "Each Leg's state, model, task and usage.",
    where: "The top of the Overview",
  },
  {
    id: "overview.running",
    page: "overview",
    name: "Running now",
    does: "Every job going, waiting, paused or queued, with Pause or Resume.",
    where: "The Overview, below the cards",
  },
  {
    id: "overview.problems",
    page: "overview",
    name: "Problems",
    does: "Errors, kills, escalations, blocked jobs, linking to the evidence.",
    where: "The Overview, right of the activity",
  },
  // New work.
  {
    id: "work.project",
    page: "new",
    name: "Project",
    does: "Which project the work is in, or a new one (from a folder, a new folder, GitHub, a git URL).",
    where: "New work → Options, first",
  },
  {
    id: "work.github-account",
    page: "new",
    name: "GitHub account",
    does: "Which of my GitHub accounts a new project's new GitHub repo is made on; the first (the default) unless I pick another.",
    where:
      "New work → Options, under the project, when it is a new GitHub repo and I have more than one account",
  },
  {
    id: "work.skill",
    page: "new",
    name: "Method (skill)",
    does: "The method the job follows; The Eye picks one when left on automatic.",
    where: "New work → Options",
  },
  {
    id: "work.legs",
    page: "new",
    name: "Legs allowed",
    does: "Which Legs may work on it (none ticked: any).",
    where: "New work → Options",
  },
  {
    id: "work.autonomy",
    page: "new",
    name: "Autonomy",
    does: "Supervised, Standard or Full: how much it asks me first.",
    where: "New work → Options",
  },
  {
    id: "work.tokens",
    page: "new",
    name: "Token limit",
    does: "A token budget for the job.",
    where: "New work → Options",
    field: true,
  },
  {
    id: "work.alarm",
    page: "new",
    name: "Alarm (hours)",
    does: "Warns me when the job runs longer than this.",
    where: "New work → Options",
    field: true,
  },
  {
    id: "work.quota-share",
    page: "new",
    name: "Most of a Leg's quota window to use (%)",
    does: "Leaves the rest of my plan's window for me.",
    where: "New work → Options",
    field: true,
  },
  {
    id: "work.checks",
    page: "new",
    name: "Job-level checks",
    does: "Commands that must pass at the end, one per line.",
    where: "New work → Options → Checks and inputs",
    field: true,
  },
  {
    id: "work.inputs",
    page: "new",
    name: "Inputs",
    does: "Files in the project or links the job reads.",
    where: "New work → Options → Checks and inputs",
    field: true,
  },
  {
    id: "work.goal",
    page: "new",
    name: "What do you want done?",
    does: "The goal, in my words.",
    where: "New work, the big field on the right",
    field: true,
  },
  {
    id: "work.continue",
    page: "new",
    name: "Continue",
    does: "Saves the draft and starts the talk with The Eye.",
    where: "New work, under the goal",
  },
  {
    id: "work.drafts",
    page: "new",
    name: "Drafts",
    does: "My drafts, to open again.",
    where: "The top of New work, when there are drafts",
  },
  {
    id: "work.start",
    page: "draft",
    needsItem: true,
    name: "Start",
    does: "Starts the draft job (disabled, saying why, until it can).",
    where: "A draft, under the conversation",
  },
  // Projects.
  {
    id: "projects.new",
    page: "projects",
    name: "New project",
    does: "Adds a project: an existing folder, a new one, a GitHub repo, a git URL.",
    where: "Projects, above the list",
  },
  {
    id: "project.github",
    page: "projects",
    tab: "repo",
    needsItem: true,
    name: "The project's GitHub repo",
    does: "Links the project to a GitHub repo (an account, a new or existing repo, public or private), changes or unlinks it; Oraknid pushes and opens pull requests there without asking.",
    where: "A project's Repo tab, under what's on the repo",
  },
  {
    id: "project.repo",
    page: "projects",
    tab: "repo",
    needsItem: true,
    name: "What's on the project's repo",
    does: "The linked repo's latest commits, branches and open pull requests, with Browse the code and Open on GitHub.",
    where: "A project's Repo tab, at the top, once a repo is linked and pushed to",
  },
  {
    id: "project.repos",
    page: "projects",
    tab: "repo",
    needsItem: true,
    name: "The project's repos",
    does: "Its git repositories: the folder itself, or several in its folders (a site and its API), each with its folder, release and work branches and GitHub link; take one out of the project.",
    where: "A project's Repo tab (at the top when it has several), and its Settings",
  },
  {
    id: "project.repos-add",
    page: "projects",
    tab: "repo",
    needsItem: true,
    name: "Add a repo",
    does: "Adds a repo to the project: a folder of it that is a repo, a new empty one, or a clone of my GitHub repo or a git URL, with its name in the project.",
    where: "The project's repos card, on the Repo tab",
  },
  {
    id: "project.repos-detect",
    page: "projects",
    tab: "repo",
    needsItem: true,
    name: "Find repos in its folder",
    does: "Looks again for git repositories in the project's folders (two folders down) and adds the new ones.",
    where: "The project's repos card, on the Repo tab",
  },
  {
    id: "project.repo-edit",
    page: "projects",
    tab: "repo",
    needsItem: true,
    name: "Change a repo",
    does: "Renames one of the project's repos, or changes its release branch (jobs start from it) and work branch (jobs merge into it). Not while one of its jobs runs.",
    where: "The pencil on a repo's row in the project's repos card, on the Repo tab",
  },
  {
    id: "project.repo-each",
    page: "projects",
    tab: "repo",
    needsItem: true,
    name: "One repo of several",
    does: "A repo of a project of several: its folder and branches, what's on its GitHub repo, and the card to link, change or unlink it.",
    where: "A project's Repo tab, one section per repo",
  },
  {
    id: "project.open-folder",
    page: "projects",
    needsItem: true,
    name: "Open folder",
    does: "Opens the project's folder in this computer's file manager, to look at or test the work by hand; away from home it copies the folder's path.",
    where: "A project's header, beside New work",
  },
  {
    id: "project.terminal-here",
    page: "projects",
    needsItem: true,
    name: "Terminal here",
    does: "Opens a terminal on this computer that starts in the project's folder (the terminal must be on).",
    where: "A project's header, beside New work",
  },
  {
    id: "project.new-work",
    page: "projects",
    needsItem: true,
    name: "New work (in a project)",
    does: "Opens the project's Eye tab to ask for work.",
    where: "A project's header",
  },
  {
    id: "project.archive",
    page: "projects",
    tab: "settings",
    needsItem: true,
    name: "Archive",
    does: "Hides the project from the lists and New work, keeps its stats.",
    where: "A project → Settings",
  },
  {
    id: "project.delete",
    page: "projects",
    tab: "settings",
    needsItem: true,
    name: "Delete the project",
    does: "Deletes it and its jobs from Oraknid; the folder stays.",
    where: "A project → Settings",
  },
  {
    id: "project.rules",
    page: "projects",
    tab: "settings",
    needsItem: true,
    name: "Commands in this project",
    does: "Allow and deny patterns for this project's jobs.",
    where: "A project → Settings",
  },
  {
    id: "project.budget",
    page: "projects",
    tab: "budget",
    needsItem: true,
    name: "The project's budget",
    does: "What its jobs used against it; Change to set it.",
    where: "A project → Budget & stats",
  },
  {
    id: "project.servers",
    page: "projects",
    tab: "servers",
    needsItem: true,
    name: "Servers for this project",
    does: "Which of my servers its jobs may use, each with its role; add one or set it up.",
    where: "A project → Servers, and its Settings",
  },
  {
    id: "project.server-role",
    page: "projects",
    tab: "servers",
    needsItem: true,
    name: "A server's role in the project",
    does: "A word for what the server is for here (testing, staging, production…) and Production, which The Eye always confirms; The Eye uses the server whose name or role I say.",
    where: "Next to each ticked server, in a project's Servers card",
    field: true,
  },
  // Inbox.
  {
    id: "inbox.search",
    page: "inbox",
    name: "Search the inbox",
    does: "Words in the title, the detail, the job or the project.",
    where: "Inbox, the filters",
    field: true,
  },
  {
    id: "inbox.project",
    page: "inbox",
    name: "Project filter",
    does: "Only one project's items.",
    where: "Inbox, the filters",
  },
  {
    id: "inbox.job",
    page: "inbox",
    name: "Job filter",
    does: "Only one job's items.",
    where: "Inbox, the filters",
  },
  {
    id: "inbox.kind",
    page: "inbox",
    name: "Kind filter",
    does: "Approvals or questions.",
    where: "Inbox, the filters",
  },
  // Mail.
  {
    id: "mail.write",
    page: "mail",
    name: "Write",
    does: "A new message (c).",
    where: "Mail, above the folders",
    via: ["mail.folders"],
  },
  {
    id: "mail.search",
    page: "mail",
    name: "Search this folder",
    does: "Searches the folder, here and on the server (/).",
    where: "Mail, above the list",
    field: true,
  },
  {
    id: "mail.check",
    page: "mail",
    name: "Check for mail",
    does: "Checks every folder now.",
    where: "Mail, beside the search",
  },
  {
    id: "mail.folders",
    page: "mail",
    name: "Folders and accounts",
    does: "Opens the folders and accounts on a phone.",
    where: "Mail on a phone, left of the search",
  },
  {
    id: "mail.add-account",
    page: "mail",
    name: "Add an account",
    does: "Adds a mail account (IMAP or POP3, with SMTP).",
    where: "Mail, under the folders",
    via: ["mail.folders"],
  },
  {
    id: "mail.account-menu",
    page: "mail",
    name: "Account menu",
    does: "Check for mail, Reconnect, Account settings, Remove.",
    where: "Mail, the … beside an account",
    via: ["mail.folders"],
  },
  {
    id: "mail.reconnect",
    page: "mail",
    name: "Reconnect…",
    does: "A new password after it changed, or the one kept.",
    where: "Mail → account menu",
    via: ["mail.folders", "mail.account-menu"],
  },
  {
    id: "mail.account-settings",
    page: "mail",
    name: "Account settings…",
    does: "The account's name, auto-send, Sent, POP deletion.",
    where: "Mail → account menu",
    via: ["mail.folders", "mail.account-menu"],
  },
  {
    id: "mail.account.name",
    page: "mail",
    name: "Account name",
    does: "The name shown for the account; Rename saves it.",
    where: "Mail → account menu → Account settings…",
    field: true,
    via: ["mail.folders", "mail.account-menu", "mail.account-settings"],
  },
  {
    id: "mail.account.auto",
    page: "mail",
    name: "Auto-send",
    does: "Agents' emails go out without asking me (off by default).",
    where: "Mail → account menu → Account settings… (also Settings → Connections)",
    via: ["mail.folders", "mail.account-menu", "mail.account-settings"],
  },
  {
    id: "mail.account.sent",
    page: "mail",
    name: "File what I send in Sent",
    does: "Oraknid keeps a copy in Sent (off when the provider does it).",
    where: "Mail → account menu → Account settings…",
    via: ["mail.folders", "mail.account-menu", "mail.account-settings"],
  },
  {
    id: "mail.add.address",
    page: "mail",
    name: "Address (adding an account)",
    does: "The address; its servers are found from it.",
    where: "Mail → Add an account",
    field: true,
    via: ["mail.folders", "mail.add-account"],
  },
  {
    id: "mail.add.password",
    page: "mail",
    name: "Password (adding an account)",
    does: "The password or app password, kept in the keychain.",
    where: "Mail → Add an account",
    via: ["mail.folders", "mail.add-account"],
  },
  {
    id: "mail.add.test",
    page: "mail",
    name: "Test",
    does: "Checks the incoming server and SMTP, saving nothing.",
    where: "Mail → Add an account, beside Connect",
    via: ["mail.folders", "mail.add-account"],
  },
  // Legs.
  {
    id: "legs.add",
    page: "legs",
    name: "Add a Leg",
    does: "Adds an agent or model server, with a live test.",
    where: "Legs, top right",
  },
  {
    id: "legs.find",
    page: "legs",
    name: "Find agents on this machine",
    does: "Finds Claude Code, OpenCode, Antigravity, Ollama… and adds them.",
    where: "Legs, top right",
  },
  {
    id: "legs.card",
    page: "legs",
    name: "A Leg's card",
    does: "Opens a Leg: models, usage, test, log in, pause, rename, remove.",
    where: "Legs, each line",
  },
  // Chats, servers, terminal, skills, logs.
  {
    id: "chats.new",
    page: "chats",
    name: "New chat",
    does: "A chat with a Leg and model, with projects attached.",
    where: "Chats, top right",
  },
  {
    id: "servers.add",
    page: "servers",
    name: "Add a server",
    does: "Adds a server by SSH.",
    where: "Servers, above the list",
  },
  {
    id: "server.discover",
    page: "servers",
    needsItem: true,
    name: "Discover again",
    does: "Brings the server's state document up to date.",
    where: "A server's header",
  },
  {
    id: "server.edit",
    page: "servers",
    needsItem: true,
    name: "Edit (a server)",
    does: "Changes its name, description, address, user or credentials, with Test connection before saving.",
    where: "A server's header",
  },
  {
    id: "server.terminal",
    page: "servers",
    needsItem: true,
    name: "Terminal (a server)",
    does: "Opens a terminal on the server.",
    where: "A server's header",
  },
  {
    id: "server.refresh",
    page: "servers",
    tab: "docker",
    needsItem: true,
    name: "Refresh",
    does: "Reads this part of the server again now (it is read every so often while open).",
    where: "A server's Docker, Databases or Proxy & traffic tab, top right",
  },
  {
    id: "server.restart",
    page: "servers",
    tab: "docker",
    needsItem: true,
    name: "Restart",
    does: "Restarts a container or a service on the server, after I confirm; audited.",
    where: "A container's or database's line, or the proxy's",
  },
  {
    id: "server.logs.source",
    page: "servers",
    tab: "logs",
    needsItem: true,
    name: "Which log",
    does: "Picks the log: a service, a container, or the proxy's files.",
    where: "A server's Logs tab, top",
  },
  {
    id: "server.logs.search",
    page: "servers",
    tab: "logs",
    needsItem: true,
    field: true,
    name: "Search the log",
    does: "Filters what comes while following; otherwise searches the log's last 20 000 lines (Enter).",
    where: "A server's Logs tab, next to the log",
  },
  {
    id: "server.logs.follow",
    page: "servers",
    tab: "logs",
    needsItem: true,
    name: "Follow",
    does: "Shows new lines as they come, while the tab is open; off to search.",
    where: "A server's Logs tab, top right",
  },
  {
    id: "server.terminal.open",
    page: "servers",
    tab: "terminal",
    needsItem: true,
    name: "Open a terminal here",
    does: "Opens a shell on the server inside its page.",
    where: "A server's Terminal tab",
  },
  {
    id: "terminal.new",
    page: "terminal",
    name: "New terminal",
    does: "This computer or a server (Ctrl Shift Enter).",
    where: "Terminal, the + after the tabs",
  },
  {
    id: "terminal.layout",
    page: "terminal",
    name: "Layout",
    does: "One at a time, side by side, or a grid.",
    where: "Terminal, right of the tabs",
  },
  {
    id: "skills.new",
    page: "skills",
    name: "New skill",
    does: "Writes or uploads a skill (.md).",
    where: "Skills, top right",
  },
  {
    id: "logs.search",
    page: "logs",
    tab: "audit",
    name: "Search the audit trail",
    does: "Words in what happened.",
    where: "Logs → What happened",
    field: true,
  },
  // Settings.
  {
    id: "settings.computer",
    page: S,
    tab: "general",
    name: "This computer",
    does: "Keychain, sandbox, sleep, the background service.",
    where: "Settings → General",
  },
  {
    id: "settings.storage",
    page: S,
    tab: "general",
    name: "Storage",
    does: "What Oraknid keeps, and pruning old jobs.",
    where: "Settings → General",
  },
  {
    id: "settings.notifications",
    page: S,
    tab: "general",
    name: "Notifications",
    does: "Which events reach me, and where (desktop, phone, email).",
    where: "Settings → General",
  },
  {
    id: "settings.theme",
    page: S,
    tab: "general",
    name: "Look",
    does: "Dark, light, or following the system.",
    where: "Settings → General",
  },
  {
    id: "settings.eye",
    page: S,
    tab: "work",
    name: "The Eye's models",
    does: "Which Leg and models The Eye reasons with, and for quick decisions.",
    where: "Settings → Eye & jobs",
  },
  {
    id: "settings.jobs",
    page: S,
    tab: "work",
    name: "Running jobs",
    does: "Jobs and tasks at once, same-provider fallback.",
    where: "Settings → Eye & jobs",
  },
  {
    id: "settings.jobs-at-once",
    page: S,
    tab: "work",
    name: "Jobs at once",
    does: "How many jobs run together; the rest queue.",
    where: "Settings → Eye & jobs → Jobs at once",
  },
  {
    id: "settings.tasks-at-once",
    page: S,
    tab: "work",
    name: "Tasks at once in a job",
    does: "How many tasks of one job run together.",
    where: "Settings → Eye & jobs → Jobs at once",
  },
  {
    id: "settings.lock",
    page: S,
    tab: "security",
    name: "Unlocking",
    does: "The PIN and the idle lock.",
    where: "Settings → Security",
  },
  {
    id: "settings.idle-lock",
    page: S,
    tab: "security",
    name: "Lock after no use for",
    does: "How long a device stays unlocked when idle.",
    where: "Settings → Security → PIN",
  },
  {
    id: "settings.pin",
    page: S,
    tab: "security",
    name: "Change the PIN",
    does: "The PIN that unlocks every device (only at home).",
    where: "Settings → Security → PIN",
  },
  {
    id: "settings.rules",
    page: S,
    tab: "security",
    name: "What agents may run",
    does: "My allow and deny patterns for every job's commands.",
    where: "Settings → Security",
  },
  {
    id: "settings.terminal",
    page: S,
    tab: "security",
    name: "Terminal",
    does: "Turns the terminal in the web app on or off.",
    where: "Settings → Security",
  },
  {
    id: "settings.terminal-switch",
    page: S,
    tab: "security",
    name: "Terminal on/off",
    does: "The switch itself (asks before turning it on).",
    where: "Settings → Security → Terminal",
  },
  {
    id: "settings.phone",
    page: S,
    tab: "devices",
    name: "Your phone, from anywhere",
    does: "Pairing a phone through The Nest.",
    where: "Settings → Devices & phone",
  },
  {
    id: "settings.pair-phone",
    page: S,
    tab: "devices",
    name: "Pair your phone",
    does: "A QR code to scan, once the Nest and the PIN are set.",
    where: "Settings → Devices & phone",
  },
  {
    id: "settings.devices",
    page: S,
    tab: "devices",
    name: "Paired devices",
    does: "Every paired device, its rights, revoke.",
    where: "Settings → Devices & phone",
  },
  {
    id: "settings.nest",
    page: S,
    tab: "devices",
    name: "The Nest",
    does: "The relay that lets my phone reach Oraknid from anywhere.",
    where: "Settings → Devices & phone",
  },
  {
    id: "settings.nest-public",
    page: S,
    tab: "devices",
    name: "Use a public Nest",
    does: "Connects through a public Nest in one click.",
    where: "Settings → Devices & phone → The Nest",
  },
  {
    id: "settings.mail",
    page: S,
    tab: "connections",
    name: "Email accounts",
    does: "My mail accounts and their options.",
    where: "Settings → Connections",
  },
  {
    id: "settings.mail-add",
    page: S,
    tab: "connections",
    name: "Add an account (Settings)",
    does: "The same form as on Mail.",
    where: "Settings → Connections → Email accounts",
  },
  {
    id: "settings.github",
    page: S,
    tab: "connections",
    name: "GitHub",
    does: "Connects GitHub with a token, for repos and pushing.",
    where: "Settings → Connections",
  },
  {
    id: "settings.tools",
    page: S,
    tab: "connections",
    name: "Tools for skills",
    does: "MCP tools a skill needs, set up once.",
    where: "Settings → Connections",
  },
  // Backups (ADR-044).
  {
    id: "settings.backups",
    page: S,
    tab: "backups",
    name: "Backup plans",
    does: "Every database backup plan: what, when, where to, how many kept, encrypted or not; its last run.",
    where: "Settings → Backups",
  },
  {
    id: "backups.new-plan",
    page: S,
    tab: "backups",
    name: "New backup plan",
    does: "A plan for one database (or all of a server's): kind, container or host, schedule, destination, retention, key, password.",
    where: "Settings → Backups, under the plans",
  },
  {
    id: "backups.plan-form",
    page: S,
    tab: "backups",
    name: "A backup plan's form",
    does: "The fields of a new or changed plan.",
    where: "Settings → Backups, after New backup plan",
    via: ["backups.new-plan"],
  },
  {
    id: "backups.run",
    page: S,
    tab: "backups",
    name: "Run now (a backup plan)",
    does: "Runs a plan's backup at once.",
    where: "Settings → Backups, on a plan",
  },
  {
    id: "settings.backup-runs",
    page: S,
    tab: "backups",
    name: "Latest backups",
    does: "Each run: when, size, how long, checksum, where, its error in words, Verify and Restore.",
    where: "Settings → Backups",
  },
  {
    id: "backups.verify",
    page: S,
    tab: "backups",
    name: "Verify a backup",
    does: "Decrypts, decompresses and checks a backup is a whole dump of its kind.",
    where: "Settings → Backups → Latest backups, on a backup",
  },
  {
    id: "backups.restore",
    page: S,
    tab: "backups",
    name: "Restore a backup",
    does: "Puts a backup back, into its database or another, in two steps; only I can do it.",
    where: "Settings → Backups → Latest backups, on a backup",
  },
  {
    id: "settings.backup-keys",
    page: S,
    tab: "backups",
    name: "Encryption keys",
    does: "The age keys backups are encrypted with: their public halves, the private one to take once.",
    where: "Settings → Backups",
  },
  {
    id: "backups.new-key",
    page: S,
    tab: "backups",
    name: "Make a key",
    does: "A new age key; its private half is shown once to download.",
    where: "Settings → Backups → Encryption keys",
  },
  {
    id: "backups.import-key",
    page: S,
    tab: "backups",
    name: "Import a key",
    does: "An age private key I already have, kept in the keychain.",
    where: "Settings → Backups → Encryption keys",
  },
  {
    id: "server.backups",
    page: "servers",
    needsItem: true,
    tab: "backups",
    name: "A server's backups",
    does: "The server's database backup plans and their backups.",
    where: "A server → Backups",
  },
  {
    id: "server.backups.new",
    page: "servers",
    needsItem: true,
    tab: "backups",
    name: "New backup plan (a server)",
    does: "A backup plan for one of this server's databases, picked from those found or described.",
    where: "A server → Backups",
  },
  {
    id: "backups.download",
    page: S,
    tab: "backups",
    name: "Download a backup",
    does: "Downloads a kept backup to this browser: as stored, or decrypted with its key (still compressed). Only on the computer running Oraknid.",
    where: "Settings → Backups → Latest backups, on a backup",
  },
  {
    id: "backups.destination",
    page: S,
    tab: "backups",
    name: "Where a plan keeps its backups",
    does: "This computer, another server, or cloud storage: the pool (each backup placed by the upload rule) or one provider.",
    where: "Settings → Backups → New backup plan, Where to",
    via: ["backups.new-plan"],
  },
  {
    id: "backups.test",
    page: S,
    tab: "backups",
    name: "Test connection (a backup plan)",
    does: "Tries the plan's form as it is, saving nothing: reaches the server over SSH, logs in with the database's own client (its version and databases, read only) and writes a small file where the backups go; each part says ok or why not.",
    where: "Settings → Backups → New backup plan (or a plan's Edit), beside Save",
    via: ["backups.new-plan"],
  },
  {
    id: "backups.advanced",
    page: S,
    tab: "backups",
    name: "Advanced (a backup plan's own fields)",
    does: "Each kind's own fields: PostgreSQL sslmode, schemas, dump format, more pg_dump options; MySQL/MariaDB TLS, one transaction, routines, events, triggers; MongoDB authentication database, replica set, TLS, read preference or a connection string; Redis database number and TLS.",
    where: "Settings → Backups → New backup plan, under The database",
    via: ["backups.new-plan"],
  },
  {
    id: "backups.found",
    page: "servers",
    needsItem: true,
    tab: "backups",
    name: "Found on the server (a backup plan)",
    does: "A database found on the server fills the plan: its kind, its container or port, and its user and database when its container's environment says them; never a password.",
    where: "A server → Backups → New backup plan",
    via: ["server.backups.new"],
  },
  // Cloud storage.
  {
    id: "storage.pool",
    page: "storage",
    name: "The pool",
    does: "One listing of every provider's files: folders merged by path, each file with its provider; breadcrumbs, a search, drop files to upload.",
    where: "Cloud storage",
  },
  {
    id: "storage.upload",
    page: "storage",
    name: "Upload",
    does: "Uploads files from this browser into the folder open, with their progress. Only on the computer running Oraknid.",
    where: "Cloud storage → The pool, top right (or drop files on the list)",
  },
  {
    id: "storage.upload-to",
    page: "storage",
    name: "Upload to",
    does: "Where the next uploads go: where the rule puts them, or a provider I pick.",
    where: "Cloud storage → The pool, beside Upload",
  },
  {
    id: "storage.uploads",
    page: "storage",
    name: "Uploads in progress",
    does: "Each upload's progress: to Oraknid, then to the provider; where it went, or why it failed.",
    where: "Cloud storage → The pool, above the list while uploading",
  },
  {
    id: "storage.search",
    page: "storage",
    name: "Search the pool",
    does: "Finds files whose name holds the words, in every provider, under the folder open.",
    where: "Cloud storage → The pool, under the breadcrumbs",
    field: true,
  },
  {
    id: "storage.file-actions",
    page: "storage",
    name: "A file's or folder's actions",
    does: "Download, rename or move (within its provider or to another), delete (asked first).",
    where: "Cloud storage → The pool, the … at the end of a row",
  },
  {
    id: "storage.providers",
    page: "storage",
    name: "Providers",
    does: "My storage accounts, each with its used and free space; check, edit (name, a space limit for object storage), remove.",
    where: "Cloud storage, beside the pool (below it on a phone)",
  },
  {
    id: "storage.add-provider",
    page: "storage",
    name: "Add a provider",
    does: "Adds Google Drive or Dropbox (signing in through rclone in a browser on this computer), MEGA (e-mail and password), S3-compatible storage (MinIO, AWS, R2, B2, Wasabi: endpoint, region, bucket, keys), or any other provider rclone supports (Another provider).",
    where: "Cloud storage → Providers",
  },
  {
    id: "storage.add-any",
    page: "storage",
    name: "Another provider",
    does: "Any provider rclone supports (OneDrive, SFTP, WebDAV, pCloud, Box, B2, Proton Drive, iCloud Drive, FTP, SMB …): picked from rclone's own list, then a form made of rclone's description of it.",
    where: "Cloud storage → Providers → Add a provider, the last tile",
    via: ["storage.add-provider"],
  },
  {
    id: "storage.backend-search",
    page: "storage",
    name: "Search rclone's providers",
    does: "Finds a provider of rclone's by its name or another name (ssh finds SFTP, hetzner the S3 services); Google Drive, Dropbox and MEGA open their short forms.",
    where: "Cloud storage → Providers → Add a provider → Another provider",
    via: ["storage.add-provider", "storage.add-any"],
    field: true,
  },
  {
    id: "storage.rclone-form",
    page: "storage",
    name: "A provider's form from rclone",
    does: "The service first when it has several (S3's AWS, Hetzner, R2 …), the options it needs (marked *), its everyday ones, passwords and keys as password fields kept only in the encrypted config, the folder the pool shows, and a space limit for one that can't say its free space. One that signs in through a browser has Sign in.",
    where: "Cloud storage → Providers → Add a provider → Another provider, once one is picked",
    via: ["storage.add-provider", "storage.add-any"],
  },
  {
    id: "storage.rclone-advanced",
    page: "storage",
    name: "Advanced options",
    does: "The rest of rclone's options for that provider (timeouts, chunk sizes, encodings …), closed until opened; empty ones keep rclone's default.",
    where: "Cloud storage → Providers → Add a provider → Another provider, under its options",
    via: ["storage.add-provider", "storage.add-any"],
  },
  {
    id: "storage.rclone-question",
    page: "storage",
    name: "rclone asks",
    does: "A question rclone asks while it sets a provider up (OneDrive's drive, a two-factor code), answered one at a time; Cancel gives the add up and forgets what was given.",
    where: "Cloud storage → Providers → Add a provider → Another provider, after Add",
    via: ["storage.add-provider", "storage.add-any"],
  },
  {
    id: "storage.s3-all",
    page: "storage",
    name: "Another S3 service",
    does: "Opens rclone's full S3 form, with every S3-compatible service it knows (Hetzner, Scaleway, IDrive e2, DigitalOcean …).",
    where:
      "Cloud storage → Providers → Add a provider → Object storage (S3), under the space limit",
    via: ["storage.add-provider"],
  },
  {
    id: "storage.add-dialog",
    page: "storage",
    name: "The new provider's form",
    does: "Its kind, name, the account's details or the sign-in, and the folder the pool shows.",
    where: "Cloud storage → Providers → Add a provider",
    via: ["storage.add-provider"],
  },
  {
    id: "storage.sign-in",
    page: "storage",
    name: "Sign in (Google Drive, Dropbox, OneDrive …)",
    does: "rclone's own sign-in: opens its page in a browser on this computer; once allowed, Add finishes.",
    where:
      "Cloud storage → Providers → Add a provider, Google Drive, Dropbox, or another provider that signs in through a browser",
    via: ["storage.add-provider"],
  },
  {
    id: "storage.placement",
    page: "storage",
    name: "Where uploads go",
    does: "Automatic by a rule (most free space first, my priority order, or by size: large files to object storage) or always one provider. A file too big for any one place is refused.",
    where: "Cloud storage, under Providers",
  },
  // Docs.
  {
    id: "docs.search",
    page: "docs",
    name: "Search the guide",
    does: "Searches the guide's headings and text.",
    where: "Docs, at the top",
    field: true,
  },
  {
    id: "docs.ask",
    page: "docs",
    needsItem: true,
    name: "Ask the helper about this",
    does: "Opens the helper with this page as context.",
    where: "A guide page, at the top",
  },
];

/** Every tab of every page is a control too: `<page>.tab.<tab>`. */
export const TAB_CONTROLS: HelpControl[] = PAGES.flatMap((p) =>
  (p.tabs ?? []).map((tab) => ({
    id: `${p.id}.tab.${tab.id}`,
    page: p.id,
    tab: tab.id,
    needsItem: p.path.includes("{item}/{tab}"),
    name: `${p.name} → ${tab.name}`,
    does: tab.does,
    where: `${p.name}, the tabs`,
  })),
);

export const ALL_CONTROLS: HelpControl[] = [...CONTROLS, ...TAB_CONTROLS];

export const control = (id: string) => ALL_CONTROLS.find((c) => c.id === id);
export const page = (id: string) => PAGES.find((p) => p.id === id);

/**
 * The address of a page: its item and tab filled in, what's missing
 * dropped from the end. A path (`/projects/x`) is taken as it is.
 */
export function pathOf(pageId: string, item?: string, tab?: string): string | null {
  if (pageId.startsWith("/")) return /^\/[\w./#%-]*$/.test(pageId) ? pageId : null;
  const p = page(pageId);
  if (!p) return null;
  const parts = p.path.split("/").filter(Boolean);
  const out: string[] = [];
  for (const part of parts) {
    if (part === "{item}") {
      if (!item) break;
      out.push(encodeURIComponent(item));
    } else if (part === "{tab}") {
      if (!tab) break;
      out.push(tab);
    } else out.push(part);
  }
  return `/${out.join("/")}`;
}

/** The item in an address of this page (`/projects/<id>/work` → id), to stay on it. */
export function itemOf(pageId: string, location: string): string | undefined {
  const p = page(pageId);
  if (!p) return undefined;
  const parts = p.path.split("/").filter(Boolean);
  const at = parts.indexOf("{item}");
  if (at < 0) return undefined;
  const here = location.split(/[?#]/)[0]?.split("/").filter(Boolean) ?? [];
  if (parts.slice(0, at).some((x, i) => here[i] !== x)) return undefined;
  const v = here[at];
  return v ? decodeURIComponent(v) : undefined;
}

/** The map as the helper reads it. */
export function screensText(): string {
  const pages = PAGES.map(
    (p) =>
      `- ${p.id}: ${p.name} (${p.path}${p.item ? `; item: ${p.item}` : ""}): ${p.does}${
        p.tabs ? `\n  tabs: ${p.tabs.map((x) => `${x.id} (${x.name}: ${x.does})`).join("; ")}` : ""
      }`,
  ).join("\n");
  const controls = CONTROLS.map(
    (c) =>
      `- ${c.id}${c.field ? " [field]" : ""}${c.needsItem ? " [needs item]" : ""}: ${c.name}. ${c.does} Where: ${c.where}.`,
  ).join("\n");
  return `## Pages (navigate: page, item, tab)\n${pages}\n\n## Controls (highlight, fill: id; each tab is also <page>.tab.<tab>)\n${controls}`;
}
