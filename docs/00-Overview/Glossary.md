# Glossary

Every term has one meaning, used the same way in the UI, the code and
the canon. Code identifiers are shown in `code`.

| Term | Code | Meaning |
| :-- | :-- | :-- |
| **Oraknid** | `oraknid` | The whole product: the daemon, the web UI, the CLI with its terminal app, and The Nest. Domain: oraknid.com, the name's own, not set up yet; the site and the Nests live at `oraknid.abakdi.com` for now ([[ADR-033-Product-Site]]). |
| **The Eye** | `eye` | The supervisor inside the daemon. It plans, routes, monitors, verifies, evaluates and self-prompts. Deterministic code that borrows a Leg when it needs reasoning. |
| **Eye Leg** | `eyeLeg` | The Leg The Eye borrows for its reasoning steps. Chosen at first-run setup and changeable at any time. |
| **Leg** | `leg` | One configured agent account or local model server plugged into Oraknid, e.g. "Claude Code, account work@" or "Ollama on localhost". It offers one or more Leg models. |
| **Leg model** | `legModel` | One model a Leg offers (e.g. Opus on a Claude Code account), with its own capability profile and quota windows. The Eye routes tasks to a Leg model and an effort level. |
| **Effort** | `effort` | The effort or thinking level a model runs at, where the agent supports it. Higher effort costs more tokens. |
| **Leg kind** | `legKind` | The type of backend a Leg uses: `claude-code`, `openai-compatible`, `opencode`, `antigravity`, `oraknid-agent` (2026-10-07). Each kind has one adapter. A Codex Leg is planned (Phase 15). |
| **Leg adapter** | `LegAdapter` | The code that drives one Leg kind behind the uniform interface: start, send, stream, interrupt, resume, kill, usage, permissions. |
| **Oraknid's own agent** | `oraknid-agent` | The Leg kind that is Oraknid's own tool loop over any model behind an OpenAI-compatible API, with Claude-Code-like tools in the sandbox, compaction and checks on "done" ([[ADR-052-A-Harness-For-Any-Model]] §6). |
| **Local Leg** | — | The Oraknid's-own-agent Leg whose models are the chat models loaded on this computer; made by Oraknid when the first one loads ([[ADR-054-Local-Models]]). |
| **Local model** | `localModel` | A model file downloaded from Hugging Face or Ollama's library and run here by llama-server or Ollama, listed on the Models page. |
| **Role (model)** | `models.roles` | What a local model is set to do for every agent through the `local-models` tool: `translate`, `ocr`, `transcribe`, `embed`, `mail`, `code`, `general` ([[ADR-054-Local-Models]]). |
| **Capability profile** | `CapabilityProfile` | What a Leg model is good and bad at: strengths, context window, quota model, rate limits, speed, known failure patterns. The user can edit it, and observed performance updates it. |
| **Project** | `project` | A workspace (a folder or repo) and everything run against it: the place I work, with one conversation with The Eye, its Web across jobs, its Silk kept by job and an optional budget. Holds many jobs. Stats roll up per project (ADR-034). |
| **Job** | `job` | One goal run to completion: its inputs, a skill, constraints (budget, allowed Legs, autonomy level) and a life-cycle state. Shown as a project's history, in its Work tab, never as a page of its own (ADR-034). |
| **The Web** | `web` | A job's task graph. The UI shows a project's Web as **Workflow** (its tab, 2026-10-03, [[ADR-034-Projects-First]] → Changed); the canon and the code keep The Web. |
| **Task** | `task` | One node of The Web: a unit of work given to exactly one Leg at a time. |
| **Attempt** | `attempt` | One try at a task by one Leg in one or more sessions. A task can have several attempts (retries, reassignments). Ends `succeeded`, `failed`, `reassigned`, `redirected`, `abandoned` or `unavailable`. |
| **Redirected** | `redirected` | An attempt I ended by saying how to go on (try again with my advice, another Leg): not counted against the task's attempt limit, not learned as the model's failure ([[ADR-056-The-Harness]], 2026-10-07). |
| **Attempt log** | `attempt_events` | *Planned* (ADR-056 stage 3): one table of typed events per attempt that every part of the harness writes and reads, deleted with its job. |
| **Session** | `session` | One run of one Leg's process or conversation. Kept short and rotated at thresholds. |
| **Handoff** | `handoff` | The structured summary written to Silk when a session rotates or a task moves to another Leg. |
| **Silk** | `silk` | A job's persistent memory: decisions, architecture, progress, issues, handoffs. Lives outside every Leg's session and is the only source of continuity. |
| **Silk mirror** | — | The readable markdown copy of Silk at `.oraknid/silk/` in the job's workspace. |
| **Skill** | `skill` | A markdown methodology file. The user uploads it or picks a built-in. It may declare required tools. |
| **Interview** | `interview` | The opening stage of a job whose skill requires the owner's answers before autonomous work. Held in the New work page's conversation with The Eye before Start; a started job still in its interview asks in the inbox. |
| **Step** | `step` | One journaled unit of a job's program. Once done, it is never run again: its recorded output is replayed after a pause, crash or restart. |
| **Safe point** | — | A step boundary: where a job can pause or stop without losing work. |
| **Verification** | `verification` | Commands The Eye runs itself (tests, builds, linters, type checks) to decide whether a task is done. The agent gets the same checks and runs them itself first (2026-10-07). |
| **Broken check** | — | A check that fails on itself, not on the work: a syntax or quoting error, a missing tool, an ssh that can't open its config or reach its host. Each check is run once before the task; a broken one is repaired by The Eye and never counted against an agent ([[ADR-052-A-Harness-For-Any-Model]] §2). |
| **Guard check** | — | A check that guards what must keep working ("Harvest still runs"): it must pass before the work too; one that fails then is wrong and is rewritten from what the server shows (2026-10-07). |
| **Drift** | `drift` | A Leg going off course: out-of-scope edits, loops, repeated failures, fake progress claims, stalls, token burn without progress. |
| **Escalation ladder** | `escalation` | The Eye's response to drift, one step at a time: corrective prompt → context reset → reassign → kill → ask the user. Not to be confused with **the ladder**. |
| **The ladder** / **rung** | `rung` | The models ordered per kind of work (code, server, research, docs, review, planning), each on a rung. A task starts on the cheapest likely to do it; one real failure moves it to a higher rung with a handoff, up to the strongest allowed ([[ADR-052-A-Harness-For-Any-Model]] §3). |
| **Claude share** | `claudeShare` | The most of a job's attempts that may run on Claude when its tasks climb; past it, Claude takes a task only when nothing else can. A job's budget, else Settings (`work.claudeShare`); unset: as needed. |
| **Checkpoint (git)** | `checkpoint` | A recorded commit or worktree state a task's changes can be rolled back to. *Not to be confused with a canon checkpoint note in `05-Checkpoints/`.* |
| **Autonomy level** | `autonomy` | Auto (default), Careful or Full ([[ADR-053-Auto-Mode]]). Decides which actions need my approval. |
| **Auto mode** | the guard, the judge | Rules, then a reasoning-blind model judge, decide what a Leg may do; I'm asked for plans of servers, production and what is never automatic ([[ADR-053-Auto-Mode]]). The default autonomy, **Auto**; **Careful** asks for what the rules don't allow at once; **Full** skips the judge off production. They replaced Supervised and Standard (migration 0039). |
| **The guard** | `@oraknid/guard` | Auto mode's rules (layer 1): commands parsed with tree-sitter-bash, blocked by cc-safety-net and Oraknid's rules, secrets going out caught by secretlint, a read-only list; the judge's prompt and the stuck rule. |
| **Judge** | `judge` | Layer 2 of auto mode: a model that sees only my messages, the task and the pending action, never the agent's words; a fast model first, the strongest allowed on a BLOCK. A judge that doesn't answer in 10 s is a block. |
| **Stuck rule** | `stuck` | Three blocks in a row, or twenty in a task, whatever said no (the rules, the judge, Claude Code's own classifier, me): The Eye asks me, listing them, "Let it run this one" or "Keep it blocked". |
| **The Gate** | `Gate` | The one path every action of a Leg takes ([[ADR-056-The-Harness]] §3): a permission prompt, Claude Code's PreToolUse hook, a job's tool through the broker, a command on a server, a check's command. It reads the rules, the grants, the judge and the autonomy, and decides allow, deny, ask or judge (`decide` in core, `harness/gate.ts` in the daemon). |
| **Grant** | `Grant` | A scoped allowance the Gate applies: what I let run once, all like this for the job, an approved plan's own removals, the autonomy level; scope `once`, `task`, `job` or `plan`; kept with the task across restarts. |
| **Task memory** | `task.memory.<task>` | What a task's attempts learned that must outlive one of them and a restart: untrusted, grants, what I refused, the stuck count, what it asked me. Cleared when the task settles. |
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
| **Connected client** | `client` | Another agent (Claude Code, Claude Desktop, OpenCode…) that uses Oraknid over MCP, paired with rights I give and revocable. *Planned* (Phase 14, [[ADR-051-Oraknid-Over-MCP]]); not built. |
| **Terminal app** | `tui` | `oraknid` alone in a terminal: The Eye's conversation, a prompt, slash commands with completion, numbered lists ([[Terminal-App]], [[ADR-055-Terminal-App]]). A **terminal-only** install (`--no-gui`) has no web UI. |
| **Chat** | `chat` | A free conversation with one of my models, which may read attached projects and research the web. |
| **Helper** | `helper` | The floating chat that does things in Oraknid for me through its own API. |
| **Server** | `server` | A machine of mine Oraknid reaches over SSH with its own key. |
| **State document** | — | What a server has and what must not be broken, written by The Eye from a discovery, kept current, editable. |
| **Server job** | — | A job in a server's own project (hidden from Projects, `projects.server_id`): an agent working on the server over ssh, its plan approved by me before anything changes, its checks run on the server, the state document updated after ([[ADR-049-Server-Chat-And-Server-Jobs]]). Started from the server's **Chat** tab, or taken there from another conversation. |
| **Production** | `production` | A server I marked so (its switch, or its role in a project): every change there asks me, at any autonomy. |
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
| **Admission** | `admit` | Whether a ready task may start now: my cap, each Leg's sessions, memory, CPU, disk, pressure, heavy beside heavy ([[ADR-050-Parallel-By-Default]]). Tasks run in parallel by default, within it. |
| **Eye thought** | `EyeThought` | One of The Eye's reasoning calls shown live in the conversation ("Planning the work…"), folded to a line when it ends; I can stop it or redo it with my words (M13.25). |
| **Update channel** | `channel` | `dev` (pre-releases and new work on dev) or `stable` (releases), from what install.sh installed ([[ADR-048-Updates]]). |
| **Audit log** | `audit` | The append-only record of every action, decision, approval and side effect. |

Related: [[Vision]] · [[Core-Entities]] · [[Product-Requirements]]
