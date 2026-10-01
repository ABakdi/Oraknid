# Glossary

Every term has one meaning, used the same way in the UI, the code and
the canon. Code identifiers are shown in `code`.

| Term | Code | Meaning |
| :-- | :-- | :-- |
| **Oraknid** | `oraknid` | The whole product: the daemon, the web UI, the CLI and The Nest. Domain: oraknid.com. |
| **The Eye** | `eye` | The supervisor inside the daemon. It plans, routes, monitors, verifies, evaluates and self-prompts. Deterministic code that borrows a Leg when it needs reasoning. |
| **Eye Leg** | `eyeLeg` | The Leg The Eye borrows for its reasoning steps. Chosen at first-run setup and changeable at any time. |
| **Leg** | `leg` | One configured agent account or local model server plugged into Oraknid, e.g. "Claude Code, account work@" or "Ollama on localhost". It offers one or more Leg models. |
| **Leg model** | `legModel` | One model a Leg offers (e.g. Opus on a Claude Code account), with its own capability profile and quota windows. The Eye routes tasks to a Leg model and an effort level. |
| **Effort** | `effort` | The effort or thinking level a model runs at, where the agent supports it. Higher effort costs more tokens. |
| **Leg kind** | `legKind` | The type of backend a Leg uses: `claude-code`, `openai-compatible`, `opencode`, `antigravity`. Each kind has one adapter. |
| **Leg adapter** | `LegAdapter` | The code that drives one Leg kind behind the uniform interface: start, send, stream, interrupt, resume, kill, usage, permissions. |
| **Capability profile** | `CapabilityProfile` | What a Leg model is good and bad at: strengths, context window, quota model, rate limits, speed, known failure patterns. The user can edit it, and observed performance updates it. |
| **Project** | `project` | A workspace (a folder or repo) and everything run against it. Holds many jobs. Stats roll up per project. |
| **Job** | `job` | One goal run to completion: its inputs, a skill, constraints (budget, allowed Legs, autonomy level) and a life-cycle state. |
| **The Web** | `web` | A job's task graph. |
| **Task** | `task` | One node of The Web: a unit of work given to exactly one Leg at a time. |
| **Attempt** | `attempt` | One try at a task by one Leg in one or more sessions. A task can have several attempts (retries, reassignments). |
| **Session** | `session` | One run of one Leg's process or conversation. Kept short and rotated at thresholds. |
| **Handoff** | `handoff` | The structured summary written to Silk when a session rotates or a task moves to another Leg. |
| **Silk** | `silk` | A job's persistent memory: decisions, architecture, progress, issues, handoffs. Lives outside every Leg's session and is the only source of continuity. |
| **Silk mirror** | — | The readable markdown copy of Silk at `.oraknid/silk/` in the job's workspace. |
| **Skill** | `skill` | A markdown methodology file. The user uploads it or picks a built-in. It may declare required tools. |
| **Interview** | `interview` | The opening stage of a job whose skill requires the owner's answers before autonomous work. Questions go to the inbox. |
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
| **Device** | `device` | A browser or phone paired with the daemon (and later The Nest). |
| **Audit log** | `audit` | The append-only record of every action, decision, approval and side effect. |

Related: [[Vision]] · [[Core-Entities]] · [[Product-Requirements]]
