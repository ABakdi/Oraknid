# Glossary

Every term has one meaning, used the same way in the UI, the code and
the canon. Code identifiers are shown in `code`.

| Term | Code | Meaning |
| :-- | :-- | :-- |
| **Oraknid** | `oraknid` | The whole product: the daemon, the web UI, the CLI and The Nest. Domain: oraknid.com, the name's own, not set up yet; the site and the Nests live at `oraknid.abakdi.com` for now ([[ADR-033-Product-Site]]). |
| **The Eye** | `eye` | The supervisor inside the daemon. It plans, routes, monitors, verifies, evaluates and self-prompts. Deterministic code that borrows a Leg when it needs reasoning. |
| **Eye Leg** | `eyeLeg` | The Leg The Eye borrows for its reasoning steps. Chosen at first-run setup and changeable at any time. |
| **Leg** | `leg` | One configured agent account or local model server plugged into Oraknid, e.g. "Claude Code, account work@" or "Ollama on localhost". It offers one or more Leg models. |
| **Leg model** | `legModel` | One model a Leg offers (e.g. Opus on a Claude Code account), with its own capability profile and quota windows. The Eye routes tasks to a Leg model and an effort level. |
| **Effort** | `effort` | The effort or thinking level a model runs at, where the agent supports it. Higher effort costs more tokens. |
| **Leg kind** | `legKind` | The type of backend a Leg uses: `claude-code`, `openai-compatible`, `opencode`, `antigravity`. Each kind has one adapter. |
| **Leg adapter** | `LegAdapter` | The code that drives one Leg kind behind the uniform interface: start, send, stream, interrupt, resume, kill, usage, permissions. |
| **Capability profile** | `CapabilityProfile` | What a Leg model is good and bad at: strengths, context window, quota model, rate limits, speed, known failure patterns. The user can edit it, and observed performance updates it. |
| **Project** | `project` | A workspace (a folder or repo) and everything run against it: the place I work, with one conversation with The Eye, its Web across jobs, its Silk kept by job and an optional budget. Holds many jobs. Stats roll up per project (ADR-034). |
| **Job** | `job` | One goal run to completion: its inputs, a skill, constraints (budget, allowed Legs, autonomy level) and a life-cycle state. Shown as a project's history, in its Work tab, never as a page of its own (ADR-034). |
| **The Web** | `web` | A job's task graph. The UI shows a project's Web as **Workflow** (its tab, 2026-10-03, [[ADR-034-Projects-First]] → Changed); the canon and the code keep The Web. |
| **Task** | `task` | One node of The Web: a unit of work given to exactly one Leg at a time. |
| **Attempt** | `attempt` | One try at a task by one Leg in one or more sessions. A task can have several attempts (retries, reassignments). |
| **Session** | `session` | One run of one Leg's process or conversation. Kept short and rotated at thresholds. |
| **Handoff** | `handoff` | The structured summary written to Silk when a session rotates or a task moves to another Leg. |
| **Silk** | `silk` | A job's persistent memory: decisions, architecture, progress, issues, handoffs. Lives outside every Leg's session and is the only source of continuity. |
| **Silk mirror** | — | The readable markdown copy of Silk at `.oraknid/silk/` in the job's workspace. |
| **Skill** | `skill` | A markdown methodology file. The user uploads it or picks a built-in. It may declare required tools. |
| **Interview** | `interview` | The opening stage of a job whose skill requires the owner's answers before autonomous work. Held in the New work page's conversation with The Eye before Start; a started job still in its interview asks in the inbox. |
| **Step** | `step` | One journaled unit of a job's program. Once done, it is never run again: its recorded output is replayed after a pause, crash or restart. |
| **Safe point** | — | A step boundary: where a job can pause or stop without losing work. |
| **Verification** | `verification` | Commands The Eye runs itself (tests, builds, linters, type checks) to decide whether a task is done. |
| **Drift** | `drift` | A Leg going off course: out-of-scope edits, loops, repeated failures, fake progress claims, stalls, token burn without progress. |
| **Escalation ladder** | `escalation` | The Eye's response to drift, one step at a time: corrective prompt → context reset → reassign → kill → ask the user. |
| **Checkpoint (git)** | `checkpoint` | A recorded commit or worktree state a task's changes can be rolled back to. *Not to be confused with a canon checkpoint note in `05-Checkpoints/`.* |
| **Autonomy level** | `autonomy` | Supervised, Standard or Full. Decides which actions need my approval. |
| **Gated action** | `gatedAction` | An action that may need approval: send, push, deploy, delete, spend over a threshold, external API writes. |
| **Approval** | `approval` | A request in the inbox for me to allow or deny a gated action or a Leg's permission prompt. |
| **Question** | `question` | A Leg's or The Eye's question that needs my answer. Answered inline. |
| **Inbox** | `inbox` | The one place approvals and questions wait for me. |
| **Budget** | `budget` | The limits a job, task or Leg must stay within: tokens, quota-window share, context, wall-clock time, money. |
| **Quota window** | `quotaWindow` | A subscription's rolling usage allowance (e.g. a 5-hour or weekly window). Tracked per Leg. |
| **Time alarm** | `timeAlarm` | A wall-clock budget that notifies me to come and look. It doesn't stop the job unless I set it to. |
| **Sleep inhibitor** | `inhibitor` | The lock that keeps the machine awake while any job is active. |
| **Watchdog** | `watchdog` | The supervisor of the daemon and every Leg process. |
| **The Nest** | `nest` | The self-hosted remote relay. The daemon connects to it outbound so I can control Oraknid from anywhere. |
| **Device** | `device` | A browser or phone paired with the daemon, at home or for away through The Nest. |
| **PIN** | `lock` | The one PIN (or passphrase) that unlocks Oraknid on every device, checked by the daemon. Unlocking gives the device an **unlocked session**; idle, closed or revoked, it locks. |
| **Rights** | `rights` | A device's rights: `standard` (away from home, nothing that opens a new way in) or `full` (away from home, what it may do at home). |
| **Loader** | — | The small page The Nest serves; it opens the tunnel and runs the UI the daemon sends through it. |
| **Public Nest** / **private Nest** | `NEST_MODE` | A Nest other people's daemons register on by themselves, or one that takes only the daemons I list. |
| **Draft** | `draft` | A job being prepared on the New work page, saved as I go, not started. |
| **Follow-up job** | — | A job started from new work I ask for on an ended job: same project and choices, its branch from the ended job's branch. |
| **Decision model** | `eyeModels` | A Leg model pinned for one kind of Eye call: planning, judging or quick. The **shadow** plans too, never used, to compare. |
| **Tool** | `tool` | An MCP server a skill can require, run by the daemon's broker; a Leg reaches it only through the broker. |
| **Chat** | `chat` | A free conversation with one of my models, which may read attached projects and research the web. |
| **Helper** | `helper` | The floating chat that does things in Oraknid for me through its own API. |
| **Server** | `server` | A machine of mine Oraknid reaches over SSH with its own key. |
| **State document** | — | What a server has and what must not be broken, written by The Eye from a discovery, kept current, editable. |
| **oraknid-monitor** | — | The small shell program on a server that Oraknid asks for a reading every 15 seconds over SSH. |
| **Mail account** | `mailAccount` | An IMAP or POP3 account with SMTP, read and written in Mail; agents reach it through the `email` tool. |
| **Agent's draft** | — | A mail an agent wrote; sent only when I approve it, unless auto-send is on for its account. |
| **Workflow** | `web` | What the UI calls a project's Web: its tab showing the tasks of its jobs and how they depend on each other (2026-10-03). In the canon and the code it is The Web. |
| **Job name** / **job description** | `title` / `description` | A job's few words, like a commit's subject, and one or two sentences: what it's for, and once ended what it did. Given by The Eye's quick model; mine when I rename it (`namedBy`, `describedAs`; 2026-10-04, [[Jobs-and-Projects]]). |
| **Project repo** | `ProjectRepo` | One git repo of a project, with its name in the project, its folder, its release and work branches and its GitHub link ([[ADR-042-Several-Repos-And-Servers]]). |
| **Backup plan** | `backupPlan` | One database's backup: what, how (its native dump), when (a schedule), where to (this computer, another server, or cloud storage), how many to keep, and its age key if encrypted. Each run is a **backup run** ([[ADR-044-Backups]]). |
| **age key** | `backupKey` | A key pair for encrypting backups with age: the public key encrypts, the private key stays in the keychain and is used only to restore or verify. Made or imported in Settings → Backups → Keys. |
| **Cloud storage** | `cloud` | My storage accounts in Oraknid, seen as one pool, through rclone ([[ADR-046-Cloud-Storage]]). |
| **Provider** | `cloudProvider` | One storage account in Cloud storage (Google Drive, an S3 bucket, MEGA, any backend rclone supports since 2026-10-04), with its used and free space. |
| **The pool** | — | One listing of everything across my providers; an upload goes where a rule I set says (Automatic), or to a provider I pick. |
| **Audit log** | `audit` | The append-only record of every action, decision, approval and side effect. |

Related: [[Vision]] · [[Core-Entities]] · [[Product-Requirements]]
