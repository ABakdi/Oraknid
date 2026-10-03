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
      { id: "backups", name: "Backups", does: "The server's database backups." },
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
    does: "Which of my servers its jobs may use; add one or set it up.",
    where: "A project → Servers",
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
